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


class Settings(unittest.TestCase):
    def test_schema_rejects_bool_gains_nonfinite_unknown_fields_and_bad_formats(self):
        for settings in [dict(eq=[True]*5, threshold=-24, ratio=3, ceiling='-1', lufs='-14'),
                         dict(eq=[math.nan]*5, threshold=-24, ratio=3, ceiling='-1', lufs='-14')]:
            with self.assertRaises(ValueError): validate('master', settings)
        with self.assertRaises(ValueError): validate('clean', dict(noise=True, hum=True, reverb=False, voice=False, strength=50, extra=True))
        with self.assertRaises(ValueError): validate('subtitles', {'language':'Telugu','formats':[]})
        validate('subtitles', {'language':'Telugu','formats':['srt','vtt']})

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
        for lufs,ceiling in [('-14','-1'),('-16','-2'),('-23','-0.3')]:
            outputs=process(self.source,self.folder,'master',dict(eq=[1,-1,0,2,0],threshold=-24,ratio=3,ceiling=ceiling,lufs=lufs))
            report=json.loads(outputs[1].read_text())
            self.assertLessEqual(report['true_peak_dbtp'],float(ceiling)+.05)
            self.assertAlmostEqual(report['integrated_lufs'],float(lufs),delta=.5)
    def test_silence_report_is_json_safe(self):
        subprocess.run(['ffmpeg','-v','error','-y','-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-t','2',str(self.source)],check=True)
        outputs=process(self.source,self.folder,'master',dict(eq=[0]*5,threshold=-24,ratio=3,ceiling='-1',lufs='-14'))
        self.assertIsNone(json.loads(outputs[1].read_text())['integrated_lufs'])
    def test_invalid_media_has_safe_error(self):
        self.source.write_text('not media')
        with self.assertRaises(MediaError) as error: duration(self.source)
        self.assertNotIn(str(self.source),str(error.exception))


class WorkerRecovery(unittest.TestCase):
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
