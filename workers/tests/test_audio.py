import copy
import json
import math
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from workers.audio import validate, duration, process, write_subtitles, timestamp, MediaError


FIXTURES = json.loads((Path(__file__).resolve().parents[2] / 'tests/fixtures/processing-settings.json').read_text())


def custom_master():
    return copy.deepcopy(FIXTURES[0]['settings'])


class Settings(unittest.TestCase):
    def test_shared_schema_contract(self):
        for case in FIXTURES:
            with self.subTest(case=case['name']):
                if case['valid']:
                    validate(case['type'], case['settings'])
                else:
                    with self.assertRaisesRegex(ValueError, 'invalid_settings'):
                        validate(case['type'], case['settings'])
        for value in (math.nan, math.inf, -math.inf):
            s = custom_master()
            s['loudness']['lufs'] = value
            with self.assertRaises(ValueError):
                validate('master', s)

    def test_subtitles_timestamps_and_cue_safety(self):
        self.assertEqual(timestamp(3661.125), '01:01:01,125')
        with tempfile.TemporaryDirectory() as folder:
            files=write_subtitles([SimpleNamespace(start=0,end=2.55,text='<b>నమస్కారం</b>\nhello --> there')], Path(folder), ['srt','vtt'])
            self.assertIn('00:00:00,000 --> 00:00:02,550',files[0].read_text())
            self.assertIn('నమస్కారం hello → there',files[0].read_text())
            self.assertTrue(files[1].read_text().startswith('WEBVTT\n'))
            self.assertIn('00:00:02.550',files[1].read_text())

    def test_asr_language_and_formats(self):
        from workers.audio import subtitles
        for language, hint in [('English','en'),('Hindi','hi'),('Telugu','te'),('Tamil','ta')]:
            with tempfile.TemporaryDirectory() as tmp, patch('faster_whisper.WhisperModel') as model, patch('workers.audio.run'):
                model.return_value.transcribe.return_value=(iter([SimpleNamespace(start=0,end=1,text='test')]), None)
                outputs=subtitles(Path('source.wav'),Path(tmp),{'language':language,'formats':['vtt']})
                self.assertEqual(model.return_value.transcribe.call_args.kwargs['language'], hint)
                self.assertEqual([p.suffix for p in outputs],['.vtt'])


@unittest.skipUnless(shutil.which('ffmpeg'), 'ffmpeg required')
class Pipelines(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.folder=Path(self.tmp.name)
        self.source=self.folder/'source.wav'
        subprocess.run(['ffmpeg','-v','error','-y','-f','lavfi','-i','sine=frequency=1000:duration=5',str(self.source)],check=True)
    def tearDown(self): self.tmp.cleanup()
    def test_probe_and_clean_all_controls(self):
        self.assertAlmostEqual(duration(self.source),5,places=1)
        outputs=process(self.source,self.folder,'clean',dict(noise=True,hum=True,reverb=True,voice=True,strength=70))
        self.assertEqual(outputs[0].name,'clean.wav')
        self.assertAlmostEqual(duration(outputs[0]),5,places=1)
    def test_master_measured_target_and_ceiling(self):
        for lufs, ceiling, knee in [(-18.5, -1.5, 'soft'), (-16.7, -2.3, 'hard'), (-23.2, -0.4, 'soft')]:
            s = custom_master()
            s['loudness']['lufs'] = lufs
            s['limiter'].update(ceiling=ceiling, knee=knee)
            outputs = process(self.source, self.folder, 'master', s)
            report = json.loads(outputs[1].read_text())
            self.assertLessEqual(report['true_peak_dbtp'], ceiling + .05)
            self.assertAlmostEqual(report['integrated_lufs'], lufs, delta=.5)
            self.assertEqual(report['target_lufs'], lufs)
            self.assertEqual(report['ceiling_dbtp'], ceiling)
            self.assertEqual(report['settings'], s)
            self.assertAlmostEqual(duration(outputs[0]), 5, delta=.02)

    def test_limiter_caps_hot_signal_without_loudness(self):
        for knee in ('soft', 'hard'):
            s = custom_master()
            s['loudness'] = {'enabled': False}
            s['compressor']['makeup']['gain'] = 36
            s['limiter'].update(ceiling=-6, knee=knee)
            outputs = process(self.source, self.folder, 'master', s)
            report = json.loads(outputs[1].read_text())
            self.assertLessEqual(report['true_peak_dbtp'], -5.95)
            self.assertIsNone(report['target_lufs'])

    def test_silence_report_is_json_safe(self):
        subprocess.run(['ffmpeg','-v','error','-y','-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-t','2',str(self.source)],check=True)
        outputs=process(self.source,self.folder,'master',custom_master())
        self.assertIsNone(json.loads(outputs[1].read_text())['integrated_lufs'])
    def test_invalid_media_has_safe_error(self):
        self.source.write_text('not media')
        with self.assertRaises(MediaError) as error: duration(self.source)
        self.assertNotIn(str(self.source),str(error.exception))


class MasterStages(unittest.TestCase):
    def test_disabled_stages_are_not_applied_and_order_is_preserved(self):
        from workers.audio import master
        measurement = dict(input_i='-18.5', input_tp='-3', input_lra='0', input_thresh='-28.5', target_offset='0')
        for selected in ('all', 'eq', 'compressor', 'loudness', 'limiter'):
            with self.subTest(selected=selected), tempfile.TemporaryDirectory() as tmp:
                s = custom_master()
                if selected != 'all':
                    s = {k: v if k == selected else {'enabled': False} for k, v in s.items()}
                with patch('workers.audio.ffmpeg') as render, patch('workers.audio.measure', return_value=measurement) as meter:
                    master(Path('input.wav'), Path(tmp), s)
                filters = ','.join(call.args[2] or '' for call in render.call_args_list)
                for stage, token in [('eq','equalizer='), ('loudness','loudnorm='), ('limiter','alimiter=')]:
                    self.assertEqual(token in filters, selected in ('all', stage))
                # Soft-knee limiting has its own peak compressor, but no user compressor settings.
                self.assertEqual('ratio=4.5' in filters, selected in ('all', 'compressor'))
                if selected == 'all':
                    self.assertLess(filters.index('equalizer='), filters.index('acompressor='))
                    self.assertLess(filters.index('acompressor='), filters.index('loudnorm='))
                    self.assertLess(filters.index('loudnorm='), filters.index('alimiter='))
                if selected != 'loudness' and selected != 'all':
                    self.assertEqual(meter.call_count, 1)  # Report only, never a normalization pass.



class WorkerRecovery(unittest.TestCase):
    def test_legacy_master_fails_with_invalid_settings_before_storage(self):
        from workers.timeline_tools_worker import handle_job
        from unittest.mock import MagicMock
        db = MagicMock()
        job = {'id': 'legacy', 'type': 'master', 'settings': {'eq': [0] * 5, 'threshold': -24,
               'ratio': 3, 'ceiling': '-1', 'lufs': '-14'}}
        with patch('workers.timeline_tools_worker.transfer_input') as download:
            handle_job(db, job, 'worker', 'https://example.invalid', 'secret')
        download.assert_not_called()
        db.rpc.assert_called_once_with('worker_fail', {'p_job_id': 'legacy', 'p_worker_id': 'worker', 'p_code': 'invalid_settings'})

    def test_completion_response_loss_keeps_successful_outputs(self):
        from workers.timeline_tools_worker import handle_job
        from unittest.mock import MagicMock
        db=MagicMock()
        def rpc(name, args):
            result=MagicMock()
            if name=='worker_complete': result.execute.side_effect=RuntimeError('lost response')
            else: result.execute.return_value.data=True
            return result
        db.rpc.side_effect=rpc
        db.table.return_value.select.return_value.eq.return_value.single.return_value.execute.return_value.data={'status':'done'}
        job={'id':'11111111-1111-4111-8111-111111111111','user_id':'22222222-2222-4222-8222-222222222222','input_path':'22222222-2222-4222-8222-222222222222/a.wav','type':'clean','settings':dict(noise=True,hum=True,reverb=False,voice=False,strength=70)}
        def output(source,folder,*args):
            p=folder/'clean.wav';p.write_bytes(b'wave');return [p]
        with patch('workers.timeline_tools_worker.transfer_input'),patch('workers.timeline_tools_worker.transfer_output'),patch('workers.audio.duration',return_value=5),patch('workers.audio.process',side_effect=output):
            handle_job(db,job,'worker','https://example.invalid','secret')
        db.storage.from_.assert_not_called()
        self.assertNotIn('worker_fail',[call.args[0] for call in db.rpc.call_args_list])


if __name__ == '__main__': unittest.main()
