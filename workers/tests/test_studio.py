import copy
import json
import os
import shutil
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import MagicMock,patch
from workers.studio_audio import (parse_script,prepare,unpack,arrange,matching,validate_studio,script_language,LanguageMismatch,render,validate_arrangement)
from workers.studio_export import validate_export
from workers.audio import duration,validate
SETTINGS=json.loads((Path(__file__).resolve().parents[2]/'tests/fixtures/studio-settings.json').read_text())
ID='11111111-1111-4111-8111-111111111111'
def settings():
 s=copy.deepcopy(SETTINGS);s['has_bed']=False;s.pop('ducking_db');s.pop('bed_fit');s['room_tone']={'enabled':False};return s

def bundle(folder,clips,script,version=2):
 path=folder/'input.zip';entries=[dict(file=f'clip-{i}.wav',name=p.name,speaker='') for i,p in enumerate(clips)]
 manifest=dict(version=version,bed=None,script='script.txt',**({'clips':entries} if version==2 else {'voices':entries,'guide':'guide.wav'}))
 with zipfile.ZipFile(path,'w',compression=zipfile.ZIP_STORED) as z:
  z.writestr('manifest.json',json.dumps(manifest));z.writestr('script.txt',script)
  for i,p in enumerate(clips):z.write(p,f'clip-{i}.wav')
  if version==1:z.writestr('guide.wav',b'This must never be decoded')
 return path

def project(lines):
 return dict(lines=parse_script(lines),manifest=dict(clips=[dict(file='one.wav',name='meera_03.wav',speaker=''),dict(file='two.wav',name='narrator.wav',speaker='')],bed=None),durations={'one.wav':3,'two.wav':3})

def segment(clip,text,start=0,end=1,name='unknown.wav',speaker=''):
 return dict(clip=clip,text=text,src_start=start,src_end=end,name=name,speaker=speaker)

class StudioSettings(unittest.TestCase):
 def test_required_choices(self):
  validate('studio',SETTINGS)
  for key in SETTINGS:
   s=copy.deepcopy(SETTINGS);del s[key];self.assertFalse(validate_studio(s),key)
  for key in ('line_gap_ms','dialogue_lufs','master_lufs','ducking_db'):
   for v in (True,'',None,float('nan'),float('inf')):
    self.assertFalse(validate_studio({**SETTINGS,key:v}))
  self.assertFalse(validate_studio({**SETTINGS,'has_bed':False}));self.assertTrue(validate_studio(settings()))
 def test_indic_language_and_script(self):
  for text,code in [('नमस्ते दुनिया','hi'),('నమస్కారం ప్రపంచం','te'),('வணக்கம் உலகம்','ta')]:self.assertEqual(script_language(text),code)
  self.assertEqual(parse_script('Meera: నమస్కారం')[0]['speaker'],'Meera')
  self.assertEqual(parse_script('WEBVTT\n\n00:01.000 --> 00:02.000\nHello')[0]['start'],1)
  for text in ('','x'*65537,'x\n'*301):
   with self.assertRaises(ValueError):parse_script(text)
 def test_shuffled_clips_multilane_missing_unplaced_natural_duration(self):
  p=project('Narrator: The morning sun rose above the village.\nMeera: Welcome back to our home.\nMeera: Quantum clocks orbit distant nebulae.')
  seg=[segment('c0','Welcome back to our home.',0,1.2,name='meera_03.wav'),segment('c1','The morning sun rose above the village.',.2,2.2),segment('c0','ZZZZZZZZZ',1.5,2)]
  a=arrange(p,seg,settings(),ID)
  self.assertEqual([r['clip'] for r in a['regions']],['c1','c0']);self.assertEqual(a['lanes'][0]['name'],'Narrator');self.assertEqual(len(a['lanes']),2)
  self.assertEqual(a['regions'][1]['start'],2.25);self.assertEqual(a['missing'][0]['line'],2);self.assertEqual(len(a['unplaced']),1)
  self.assertAlmostEqual(a['duration'],2+1.2+.5+a['missing'][0]['length'],places=5)
 def test_filename_speaker_bonus_and_merged_segments(self):
  lines=parse_script('Meera: hello wonderful world')
  seg=[segment('c0','hello',0,.5,name='meera_03.wav'),segment('c0','wonderful world',.5,1.5,name='meera_03.wav')]
  result,used=matching(lines,seg);self.assertEqual(used,{0,1});self.assertGreater(result[0][2],.9)
 def test_group_segment_across_lines_and_low_confidence(self):
  p=project('Meera: hello there\nMeera: welcome home')
  a=arrange(p,[segment('c0','hello there welcome home',0,2)],settings(),ID)
  self.assertEqual(len(a['regions']),2);self.assertEqual(len(a['missing']),0)
  p=project('Meera: hello beautiful morning')
  a=arrange(p,[segment('c0','hello morning',0,1)],settings(),ID)
  self.assertLess(a['regions'][0]['confidence'],.85)
 def test_explicit_export_choices(self):
  for s in ({},{'revision':1,'formats':['mp3'],'subtitles':[],'missing_lines':'exclude'}):
   with self.assertRaises(ValueError):validate_export(s)

@unittest.skipUnless(shutil.which('ffmpeg'),'ffmpeg required')
class Pipeline(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.folder=Path(self.tmp.name);self.clip=self.folder/'meera_03.wav'
  subprocess.run(['ffmpeg','-v','error','-y','-f','lavfi','-i','sine=frequency=440:sample_rate=16000:duration=1',str(self.clip)],check=True)
 def tearDown(self):self.tmp.cleanup()
 def test_v1_guide_ignored_and_derived_billing(self):
  source=bundle(self.folder,[self.clip],'Meera: నమస్కారం\nMeera: ప్రపంచం',1)
  p=prepare(source,self.folder,settings(),detector=lambda *_:('te',.99))
  self.assertNotIn('guide',p['manifest']);self.assertFalse((p['assets']/'guide.wav').exists());self.assertAlmostEqual(p['seconds'],1.25,places=2)
 def test_language_gate_before_prepare_and_zero_charge(self):
  from workers.timeline_tools_worker import handle_job
  source=bundle(self.folder,[self.clip],'Meera: नमस्ते दुनिया')
  db=MagicMock();db.rpc.return_value.execute.return_value.data=True
  job=dict(id=ID,user_id=ID,input_path=ID+'/input.zip',type='studio',settings=settings())
  def transfer(_u,_k,_p,d):shutil.copyfile(source,d)
  with patch('workers.timeline_tools_worker.transfer_input',side_effect=transfer),patch('workers.studio_audio.detect_language',return_value=('en',.99)):
   handle_job(db,job,'worker','https://invalid.test','secret')
  calls=[c.args[0] for c in db.rpc.call_args_list];self.assertNotIn('worker_prepare',calls);self.assertNotIn('worker_complete',calls)
  self.assertEqual(db.rpc.call_args_list[-1].args[1]['p_code'],'language_mismatch')
 def test_uncertain_does_not_block_and_duration_caps(self):
  p=prepare(bundle(self.folder,[self.clip],'Meera: नमस्ते दुनिया'),self.folder,settings(),detector=lambda *_:('en',.3))
  self.assertTrue(p['languages']['clips'][0]['uncertain'])
  folder=self.folder/'large';folder.mkdir()
  with patch('workers.studio_audio.duration',return_value=3601):
   with self.assertRaises(ValueError):prepare(bundle(folder,[self.clip],'hello'),folder,settings(),detector=lambda *_:('en',.9))
 def test_archive_rejects_traversal_and_compression(self):
  for name in ('../bad.wav','sub/bad.wav','/bad.wav'):
   path=self.folder/'bad.zip'
   with zipfile.ZipFile(path,'w') as z:
    z.writestr(name,'bad');z.writestr('script.txt','hello');z.writestr('manifest.json','{}')
   with self.assertRaises(ValueError):unpack(path,self.folder/'assets')
 def test_worker_prepare_derived_duration_and_outputs(self):
  from workers.timeline_tools_worker import handle_job
  source=bundle(self.folder,[self.clip],'Meera: नमस्ते दुनिया')
  db=MagicMock();db.rpc.return_value.execute.return_value.data=True
  job=dict(id=ID,user_id=ID,input_path=ID+'/input.zip',type='studio',settings=settings())
  def transfer(_u,_k,_p,d):shutil.copyfile(source,d)
  seg=[segment('c0','नमस्ते दुनिया',0,1)]
  with patch('workers.timeline_tools_worker.transfer_input',side_effect=transfer),patch('workers.timeline_tools_worker.transfer_output'),patch('workers.studio_audio.detect_language',return_value=('hi',.99)),patch('workers.timeline_tools_worker.studio_asr') as asr:
   asr.remote.return_value=seg;handle_job(db,job,'worker','https://invalid.test','secret')
  prep=next(c for c in db.rpc.call_args_list if c.args[0]=='worker_prepare');self.assertAlmostEqual(prep.args[1]['p_duration'],1,places=2)
  self.assertIn('worker_complete',[c.args[0] for c in db.rpc.call_args_list])
 def test_export_codecs_rates_and_duration(self):
  a=arrange(project('Meera: hello'),[segment('c0','hello',0,1)],settings(),ID)
  for fmt,depth,rate in [('mp3',b,r) for b in (128,320) for r in (44100,48000)]+[('wav',d,r) for d in (16,24,'32f') for r in (44100,48000,96000)]:
   folder=self.folder/f'{fmt}-{depth}-{rate}';folder.mkdir();e=dict(revision=1,formats=[fmt],subtitles=[],missing_lines='exclude',**{fmt:dict(sample_rate=rate,**({'bitrate_kbps':depth} if fmt=='mp3' else {'bit_depth':depth}))});validate_export(e)
   paths=render(dict(stems={'c0':self.clip}),a,folder,settings(),e);probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(paths[0])]))['streams'][0]
   self.assertEqual(int(probe['sample_rate']),rate);self.assertAlmostEqual(duration(paths[0]),1,delta=.1)
   if fmt=='wav':self.assertEqual(probe['codec_name'],{16:'pcm_s16le',24:'pcm_s24le','32f':'pcm_f32le'}[depth])
   else:self.assertEqual(int(probe['bit_rate']),depth*1000)
 @unittest.skipUnless(os.environ.get('STUDIO_REAL_ASR')=='1','opt-in model download and real ASR')
 def test_real_tiny_asr(self):
  from workers.studio_audio import model
  segments,info=model(size='tiny').transcribe(str(self.clip),vad_filter=True);list(segments);self.assertTrue(info.language)

class AsrCompatibility(unittest.TestCase):
 def test_requirements_pin_pyav_compatible_with_faster_whisper(self):
  requirements=(Path(__file__).resolve().parents[1]/'requirements.txt').read_text().splitlines()
  self.assertIn('av==18.1.0',requirements)
  try:
   from faster_whisper.audio import decode_audio
  except ImportError:
   return  # The exact pin is checked even in a dependency-light environment.
  if not shutil.which('ffmpeg'): return
  with tempfile.TemporaryDirectory() as tmp:
   mp3=Path(tmp)/'sample.mp3'
   subprocess.run(['ffmpeg','-v','error','-y','-f','lavfi','-i','sine=frequency=440:sample_rate=44100:duration=1','-ac','1',str(mp3)],check=True)
   samples=decode_audio(str(mp3))
   self.assertGreater(len(samples),0)

 def test_numpy_asr_times_accepted(self):
  import numpy as np
  from workers.studio_audio import mix
  p=project('Meera: hello wonderful world')
  p['languages']={'script_lang':'en','clips':[]}
  segments=[segment('c0','hello wonderful world',np.float64(.1),np.float64(1.3))]
  a=arrange(p,segments,settings(),ID)
  for key in ('src_start','src_end','start','gain_db'):
   self.assertIs(type(a['regions'][0][key]),float,key)
  # The validator also accepts real scalar values directly, without accepting bool/strings.
  a['regions'][0]['src_start']=np.float32(.1)
  validate_arrangement(a)
  self.assertIs(type(a['regions'][0]['src_start']),float)
  for invalid in (True,'0',float('nan'),float('inf')):
   bad=copy.deepcopy(a);bad['regions'][0]['src_start']=invalid
   with self.assertRaises(ValueError):validate_arrangement(bad)
  with tempfile.TemporaryDirectory() as tmp,patch('workers.studio_audio.normalize_clips',return_value=[]):
   outputs=mix(p,Path(tmp),settings(),ID,segments)
   saved=json.loads(next(p for p in outputs if p.name=='arrangement-r1.json').read_text())
   self.assertAlmostEqual(saved['regions'][0]['src_start'],.1)

 def test_transcribe_casts_word_and_segment_times(self):
  import numpy as np
  from types import SimpleNamespace
  from workers.studio_audio import transcribe
  p=project('Meera: hello');p.update(assets=Path('/unused'),languages={'script_lang':'en'})
  p['manifest']['clips']=p['manifest']['clips'][:1]
  for words in ([SimpleNamespace(start=np.float64(.123456789),end=np.float64(1.23456789),word=' hello.')],None):
   raw=SimpleNamespace(start=np.float64(.123456789),end=np.float64(1.23456789),text='hello',words=words)
   with patch('workers.studio_audio.model'),patch('faster_whisper.BatchedInferencePipeline') as pipeline:
    pipeline.return_value.transcribe.return_value=([raw],None)
    result=transcribe(p)
   self.assertIs(type(result[0]['src_start']),float)
   self.assertIs(type(result[0]['src_end']),float)
   self.assertEqual(result[0]['src_start'],.123457)
   self.assertEqual(result[0]['src_end'],1.234568)

 def test_unexpected_exception_maps_to_processing_not_invalid_media(self):
  from workers.timeline_tools_worker import handle_job
  db=MagicMock();db.rpc.return_value.execute.return_value.data=True
  job=dict(id=ID,user_id=ID,input_path=ID+'/input.zip',type='studio',settings=settings())
  with patch('workers.timeline_tools_worker.transfer_input'),patch('workers.studio_audio.prepare',side_effect=TypeError('https://secret.test/private?key=never-log-this')),patch('builtins.print') as log:
   handle_job(db,job,'worker','https://invalid.test','secret')
  failed=next(c for c in db.rpc.call_args_list if c.args[0]=='worker_fail')
  self.assertEqual(failed.args[1]['p_code'],'processing')
  self.assertNotIn('worker_prepare',[c.args[0] for c in db.rpc.call_args_list])
  self.assertNotIn('worker_complete',[c.args[0] for c in db.rpc.call_args_list])
  log.assert_called_once_with(f'job {ID} step=studio_prepare TypeError')

 def test_prepare_step_codes_distinguish_media_and_gate_crashes(self):
  from workers.timeline_tools_worker import handle_job
  from workers.audio import MediaError
  for step,code,exception in [('studio_probe','invalid_media',MediaError()),('studio_decode','invalid_media',MediaError()),('studio_language_gate','processing',TypeError()),('studio_plan','processing',ValueError())]:
   db=MagicMock();db.rpc.return_value.execute.return_value.data=True
   job=dict(id=ID,user_id=ID,input_path=ID+'/input.zip',type='studio',settings=settings())
   def prepare_crash(*args,on_step,**kwargs):
    on_step(step)
    raise exception
   with patch('workers.timeline_tools_worker.transfer_input'),patch('workers.studio_audio.prepare',side_effect=prepare_crash),patch('builtins.print') as log:
    handle_job(db,job,'worker','https://invalid.test','secret')
   failed=next(c for c in db.rpc.call_args_list if c.args[0]=='worker_fail')
   self.assertEqual(failed.args[1]['p_code'],code,step)
   self.assertNotIn('worker_prepare',[c.args[0] for c in db.rpc.call_args_list])
   log.assert_called_once_with(f'job {ID} step={step} {type(exception).__name__}')

class AutoTranscript(unittest.TestCase):
 def test_transcribe_arrangement_uses_order_and_speakers_without_matching(self):
  from workers.defaults import with_defaults
  p=dict(lines=[],manifest=dict(mode='transcribe',script=None,clips=[dict(file='one.wav',name='host.wav',speaker='Host'),dict(file='two.wav',name='guest.wav',speaker='')],bed=None),durations={'one.wav':3,'two.wav':3})
  with patch('workers.studio_audio.matching',side_effect=AssertionError('No script matching')):
   a=arrange(p,[segment('c0','hello',0,1,name='host.wav',speaker='Host'),segment('c1','welcome',.2,1.2,name='guest.wav')],with_defaults('studio',{}),ID)
  self.assertEqual([l['name'] for l in a['lanes']],['Host','guest'])
  self.assertEqual(a['regions'][1]['start'],1.3)
  self.assertEqual(a['lines'][1]['text'],'welcome')
 def test_no_script_gate_and_billing_before_asr(self):
  from workers.timeline_tools_worker import handle_job
  from workers.defaults import with_defaults
  db=MagicMock();db.rpc.return_value.execute.return_value.data=True
  with tempfile.TemporaryDirectory() as tmp:
   folder=Path(tmp); path=folder/'source.zip'
   manifest=dict(version=2,mode='transcribe',script=None,bed=None,clips=[dict(file='one.wav',name='one.wav',speaker='')])
   with zipfile.ZipFile(path,'w',compression=zipfile.ZIP_STORED) as z:
    z.writestr('manifest.json',json.dumps(manifest));z.writestr('one.wav',b'audio')
   events=[]
   def rpc(name,*args): events.append(name);return MagicMock(execute=lambda:MagicMock(data=True))
   db.rpc.side_effect=rpc
   def asr(*args): events.append('ASR');raise RuntimeError('asr unavailable')
   def transfer(_u,_k,_p,d):shutil.copyfile(path,d)
   with patch('workers.timeline_tools_worker.transfer_input',side_effect=transfer),patch('workers.studio_audio.duration',return_value=2),patch('workers.studio_audio.speech_regions',return_value=([(0,2)],[])),patch('workers.studio_audio.detect_language',side_effect=AssertionError('gate called')),patch('workers.studio_audio.script_language',side_effect=AssertionError('gate called')),patch('workers.timeline_tools_worker.studio_asr.remote',side_effect=asr),patch('workers.studio_audio.transcribe',side_effect=asr):
    handle_job(db,dict(id=ID,user_id=ID,input_path=ID+'/input.zip',type='studio',settings={}), 'worker','https://invalid.test','secret')
   self.assertLess(events.index('worker_prepare'),events.index('ASR'))
   self.assertIn('worker_fail',events)
   self.assertEqual(db.rpc.call_args_list[-1].args[1]['p_code'],'processing')
