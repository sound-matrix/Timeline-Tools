import copy
import json
import shutil
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import MagicMock, patch

from workers.audio import process, validate, duration
from workers.studio_audio import parse_script, prepare, alignment, unpack, validate_studio

SETTINGS = json.loads((Path(__file__).resolve().parents[2] / 'tests/fixtures/studio-settings.json').read_text())


def bundle(folder, guide, voice, script, bed=None, speakers=None):
    path = folder / 'input.zip'
    voices = voice if isinstance(voice, list) else [voice]
    manifest = dict(version=1, guide='guide.wav', voices=[dict(file=f'voice-{i}.wav', speaker=(speakers or ['']*len(voices))[i], name=p.name) for i, p in enumerate(voices)], bed='bed.wav' if bed else None, script='script.txt')
    with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_STORED) as archive:
        archive.writestr('manifest.json', json.dumps(manifest))
        archive.writestr('script.txt', script)
        archive.write(guide, 'guide.wav')
        for i, p in enumerate(voices): archive.write(p, f'voice-{i}.wav')
        if bed: archive.write(bed, 'bed.wav')
    return path


class StudioSettings(unittest.TestCase):
    def test_mirror_and_required_choices(self):
        validate('studio', SETTINGS)
        for field in SETTINGS:
            s = copy.deepcopy(SETTINGS); del s[field]
            with self.assertRaises(ValueError): validate('studio', s)
        for field in ['dialogue_lufs', 'master_lufs', 'ducking_db']:
            for value in [True, '', None, float('nan'), float('inf')]:
                s = copy.deepcopy(SETTINGS); s[field] = value
                self.assertFalse(validate_studio(s))
        for patch_value in [dict(has_bed=False), dict(subtitles=dict(enabled=True, formats=[])),
                            dict(subtitles=dict(enabled=True, formats=['srt', 'srt'])), dict(room_tone=dict(enabled=False, amount=0))]:
            self.assertFalse(validate_studio({**SETTINGS, **patch_value}))
        s = copy.deepcopy(SETTINGS); s.update(has_bed=False, subtitles=dict(enabled=False), room_tone=dict(enabled=False)); del s['ducking_db']
        validate('studio', s)

    def test_script_parsing_and_limits(self):
        self.assertEqual(parse_script('Meera: నమస్కారం')[0]['speaker'], 'Meera')
        self.assertEqual(parse_script('WEBVTT\n\n00:01.000 --> 00:02.500\n<b>Meera:</b> Hello')[0]['end'], 2.5)
        for script in ['', 'x'*65537, 'x\n'*301, '00:02.000 --> 00:01.000\nInvalid']:
            with self.assertRaises(ValueError): parse_script(script)

    def test_bundle_rejects_path_traversal_duplicates_compressed_and_symlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp); p = folder / 'input.zip'
            for name in ['../bad.wav', '/tmp/bad.wav', 'sub/bad.wav', 'https://example.com/bad.wav']:
                with zipfile.ZipFile(p, 'w') as archive:
                    for n in [name, 'manifest.json', 'script.txt', 'guide.wav']: archive.writestr(n, '{}')
                with self.assertRaises(ValueError): unpack(p, folder / 'assets')
            with zipfile.ZipFile(p, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
                for name in ['manifest.json', 'script.txt', 'guide.wav', 'voice.wav']: archive.writestr(name, '{}')
            with self.assertRaises(ValueError): unpack(p, folder / 'assets')
            with zipfile.ZipFile(p, 'w') as archive:
                link = zipfile.ZipInfo('guide.wav'); link.external_attr = 0o120777 << 16
                archive.writestr(link, '/etc/passwd')
                for name in ['manifest.json', 'script.txt', 'voice.wav']: archive.writestr(name, '{}')
            with self.assertRaises(ValueError): unpack(p, folder / 'assets')


@unittest.skipUnless(shutil.which('ffmpeg'), 'ffmpeg required')
class StudioPipeline(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.folder = Path(self.tmp.name)
        self.guide, self.voice, self.bed = [self.folder / f'{s}.wav' for s in ('guide', 'voice', 'bed')]
        self.signal(self.guide, r'if(between(t\,0.5\,1.5)+between(t\,4\,5)\,0.12*sin(2*PI*440*t)\,0.0005*sin(2*PI*200*t))')
        self.signal(self.voice, r'if(between(t\,1\,2)+between(t\,3\,4)\,0.12*sin(2*PI*880*t)\,0)')
        self.signal(self.bed, '0.01*sin(2*PI*220*t)')
    def signal(self, path, expression):
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', f'aevalsrc={expression}:s=16000:d=6', str(path)], check=True)
    def tearDown(self): self.tmp.cleanup()
    def settings(self, bed=False):
        s = copy.deepcopy(SETTINGS)
        if not bed: s['has_bed'] = False; del s['ducking_db']
        return s
    def test_studio_branch_moves_dub_bursts_to_timed_guide_and_exports(self):
        import numpy as np
        import soundfile as sf
        script = '1\n00:00:00,500 --> 00:00:01,500\nNarrator: Hello\n\n2\n00:00:04,000 --> 00:00:05,000\nNarrator: Goodbye'
        source = bundle(self.folder, self.guide, self.voice, script)
        outputs = process(source, self.folder, 'studio', self.settings())
        self.assertEqual([p.name for p in outputs], ['studio-mix.wav', 'alignment-report.json', 'subtitles.srt', 'subtitles.vtt'])
        self.assertAlmostEqual(duration(outputs[0]), 6, delta=.05)
        report = json.loads(outputs[1].read_text())
        self.assertEqual(report['method'], 'heuristic-v1')
        self.assertEqual([l['start'] for l in report['lines']], [.5, 4])
        self.assertGreater(report['lines'][0]['source_start'], .9)
        self.assertGreater(report['lines'][0]['confidence'], .7)
        self.assertEqual(report['loudness']['target_lufs'], -16)
        self.assertIn('Narrator: Hello', outputs[2].read_text())
        samples, rate = sf.read(outputs[0], always_2d=True)
        rms = lambda start, end: np.sqrt(np.mean(samples[int(start*rate):int(end*rate)]**2))
        self.assertGreater(rms(.7, 1.3), .03)
        self.assertLess(rms(2.3, 2.8), .001)
        self.assertGreater(rms(4.2, 4.8), .03)
    def test_plain_text_confidence_is_evidence_based_and_silence_scores_zero(self):
        source = bundle(self.folder, self.guide, self.voice, 'Narrator: Hello\nNarrator: Goodbye')
        project = prepare(source, self.folder)
        report, _ = alignment(project)
        self.assertTrue(all(l['confidence'] <= .65 for l in report['lines']))
        self.assertTrue(all('Low confidence: review timing' in l['flags'] for l in report['lines']))
        self.assertAlmostEqual(report['lines'][0]['start'], .5, delta=.05)
        self.signal(self.voice, '0')
        source = bundle(self.folder, self.guide, self.voice, 'Narrator: Hello\nNarrator: Goodbye')
        silent, _ = alignment(prepare(source, self.folder))
        self.assertEqual([l['confidence'] for l in silent['lines']], [0, 0])
    def test_multiple_speakers_bed_ducking_room_tone_and_disabled_subtitles(self):
        source = bundle(self.folder, self.guide, [self.voice, self.voice], 'Narrator: Hello\nMeera: Goodbye', self.bed, ['Narrator', 'Meera'])
        s = self.settings(True); s['ducking_db'] = 12; s['room_tone']['amount'] = 30; s['subtitles'] = dict(enabled=False)
        from workers.studio_audio import ffmpeg as real_ffmpeg
        with patch('workers.studio_audio.ffmpeg', wraps=real_ffmpeg) as calls:
            outputs = process(source, self.folder, 'studio', s)
        report = json.loads(outputs[1].read_text())
        self.assertEqual(len(report['tracks']), 2)
        self.assertEqual(len(outputs), 2)
        self.assertIn(str(10**(-12/20)), str(calls.call_args_list))
        self.assertAlmostEqual(duration(outputs[0]), 6, delta=.05)
    def test_rejects_unmapped_speakers_out_of_range_cues_and_bed_mismatch(self):
        source = bundle(self.folder, self.guide, [self.voice, self.voice], 'Nobody: Hello', speakers=['Narrator', 'Meera'])
        with self.assertRaises(ValueError): prepare(source, self.folder)
        source = bundle(self.folder, self.guide, self.voice, '00:00:00,000 --> 00:00:07,000\nHello')
        with self.assertRaises(ValueError): prepare(source, self.folder)
        source = bundle(self.folder, self.guide, self.voice, 'Hello')
        with self.assertRaises(ValueError): process(source, self.folder, 'studio', self.settings(True))
    def test_worker_bills_guide_duration_once_and_publishes_all_outputs(self):
        from workers.timeline_tools_worker import handle_job
        source = bundle(self.folder, self.guide, self.voice, 'Hello\nGoodbye')
        owner = '22222222-2222-4222-8222-222222222222'
        job = dict(id='11111111-1111-4111-8111-111111111111', user_id=owner, input_path=owner+'/input.zip', type='studio', settings=self.settings())
        db = MagicMock(); db.rpc.return_value.execute.return_value.data = True
        def transfer(_url, _key, _path, dest): shutil.copyfile(source, dest)
        with patch('workers.timeline_tools_worker.transfer_input', side_effect=transfer), patch('workers.timeline_tools_worker.transfer_output') as upload:
            handle_job(db, job, 'worker', 'https://example.invalid', 'secret')
        prepare_call = next(c for c in db.rpc.call_args_list if c.args[0] == 'worker_prepare')
        self.assertEqual(prepare_call.args[1]['p_duration'], 6)
        complete = next(c for c in db.rpc.call_args_list if c.args[0] == 'worker_complete')
        self.assertEqual(len(complete.args[1]['p_outputs']), 4)
        self.assertEqual(upload.call_count, 4)
        self.assertNotIn('worker_fail', [c.args[0] for c in db.rpc.call_args_list])
