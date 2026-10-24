import copy,json,tempfile,unittest
from pathlib import Path
import numpy as np
from workers.studio_audio import arrange,validate_arrangement,fade_envelope,pan_gains,unique_source_seconds,arrangement_cues
from workers.defaults import with_defaults
ID='33333333-3333-4333-8333-333333333333'
def source(lines,clips=2):
 return dict(lines=lines,manifest=dict(clips=[dict(file=f'{i}.wav',name=f'{i}.wav',speaker='Host') for i in range(clips)],bed=None),durations={f'{i}.wav':5 for i in range(clips)})
def segment(clip,text,start,end):return dict(clip=clip,text=text,src_start=start,src_end=end,name=clip+'.wav',speaker='Host')
class Daw(unittest.TestCase):
 def test_whole_clip_captions_unmatched_tail_and_bin(self):
  p=source([dict(text='hello there',speaker='Host',start=None,end=None),dict(text='welcome home',speaker='Host',start=None,end=None)],3)
  a=arrange(p,[segment('c0','hello there',1,2),segment('c0','welcome home',3,4),segment('c0','unused tail',4,4.5),segment('c1','no matching words xyz',0,1)],with_defaults('studio',{}),ID)
  self.assertEqual(a['version'],2);self.assertEqual(len(a['regions']),1)
  r=a['regions'][0];self.assertEqual((r['src_start'],r['src_end']),(0,5));self.assertEqual(len(r['lines']),2)
  self.assertEqual({u['clip'] for u in a['unplaced']},{'c1','c2'})
  self.assertEqual([(c.start,c.end) for c in arrangement_cues(a)],[(1,2),(3,4)])
 def test_script_anchor_and_overlap_sequence_never_trim(self):
  p=source([dict(text='hello there',speaker='Host',start=2,end=3),dict(text='welcome home',speaker='Host',start=4,end=5)])
  a=arrange(p,[segment('c0','hello there',1,2),segment('c1','welcome home',1,2)],with_defaults('studio',{}),ID)
  self.assertEqual([r['start'] for r in a['regions']],[1,6.3]);self.assertEqual([r['src_end'] for r in a['regions']],[5,5])
 def test_transcribe_keeps_whole_sources_even_when_split_setting(self):
  p=source([]);p['manifest']['mode']='transcribe'
  a=arrange(p,[segment('c0','first',.5,1),segment('c0','second',3,4),segment('c1','third',2,3)],with_defaults('studio',{'region_mode':'split_by_line'}),ID)
  self.assertEqual(len(a['regions']),2);self.assertEqual(a['regions'][1]['start'],5.3);self.assertFalse(a['unplaced'])
 def test_split_is_explicit_and_v1_migrates_without_rearranging(self):
  p=source([dict(text='hello there',speaker='Host',start=None,end=None),dict(text='welcome home',speaker='Host',start=None,end=None)])
  a=arrange(p,[segment('c0','hello there welcome home',1,4)],with_defaults('studio',{'region_mode':'split_by_line'}),ID);self.assertEqual(len(a['regions']),2)
  legacy=json.loads(Path('tests/fixtures/daw-arrangement.json').read_text());before=copy.deepcopy(legacy['regions']);migrated=validate_arrangement(legacy)
  self.assertEqual(migrated['pan_law'],'legacy')
  for old,new in zip(before,migrated['regions']):
   for k in ('src_start','src_end','start','gain_db'):self.assertEqual(old[k],new[k])
 def test_dsp_pan_fades_budget(self):
  r=dict(src_start=0,src_end=2,fade_in=1,fade_out=1,fade_curve='linear')
  np.testing.assert_allclose(fade_envelope(r,np.array([0,.5,1,1.5,2])),[0,.5,1,.5,0])
  r['fade_curve']='equal_power';np.testing.assert_allclose(fade_envelope(r,np.array([.5,1.5])),[np.sqrt(.5)]*2)
  for pan in (-1,-.5,0,.5,1):self.assertAlmostEqual(sum(g*g for g in pan_gains(pan)),1)
  self.assertAlmostEqual(pan_gains(0)[0],np.sqrt(.5))
  self.assertEqual(unique_source_seconds([dict(clip='one',src_start=0,src_end=10)]*2000),10)

 def test_export_fades_pan_master_and_bounce_recipe(self):
  import shutil,soundfile as sf
  from workers.studio_audio import render,migrate_arrangement
  if not shutil.which('ffmpeg'):self.skipTest('ffmpeg required')
  a=migrate_arrangement(json.loads(Path('tests/fixtures/daw-arrangement.json').read_text()))
  a['pan_law']='equal_power';a['duration']=2;a['loop']['end']=2;a['missing']=[];a['unplaced']=[]
  r=dict(a['regions'][0],src_start=0,src_end=2,start=0,fade_in=.1,fade_out=.2,gain_db=-6)
  a['regions']=[r];a['lanes'][0]['pan']=.5;a['lanes'][0]['gain_db']=-3;a['master']['gain_db']=-2
  settings=dict(master_lufs=-16,room_tone=dict(enabled=False));export=dict(formats=['wav'],wav=dict(bit_depth='32f',sample_rate=48000),subtitles=[],missing_lines='exclude')
  with tempfile.TemporaryDirectory() as tmp:
   folder=Path(tmp);source=folder/'source.wav';signal=np.column_stack([np.sin(2*np.pi*440*np.arange(96000)/48000)*.1]*2).astype('float32');sf.write(source,signal,48000,subtype='FLOAT')
   one=folder/'direct';one.mkdir();render(dict(stems={'c0':source}),a,one,settings,export)
   output,_=sf.read(one/'dialogue.wav',dtype='float32',always_2d=True)
   reference=signal*fade_envelope(r,np.arange(len(signal))/48000)[:,None]*np.asarray(pan_gains(.5))*10**(-11/20)
   np.testing.assert_allclose(output,reference,atol=1e-7)
   derived=dict(id='bounce0',name='Bounce',duration=2,source='c0',src_start=0,src_end=2,gain_db=-6,fade_in=.1,fade_out=.2,fade_curve='linear')
   b=copy.deepcopy(a);b['derived_clips']=[derived];b['regions']=[dict(r,clip='bounce0',gain_db=0,fade_in=0,fade_out=0)]
   two=folder/'bounce';two.mkdir();render(dict(stems={'c0':source}),b,two,settings,export)
   bounced,_=sf.read(two/'dialogue.wav',dtype='float32',always_2d=True)
   np.testing.assert_allclose(output,bounced,atol=1e-7)

 def test_podcast_independent_concurrent_stems_are_not_double_mixed(self):
  import shutil,soundfile as sf
  from workers.podcast import render
  from workers.studio_audio import migrate_arrangement
  if not shutil.which('ffmpeg'):self.skipTest('ffmpeg required')
  a=migrate_arrangement(json.loads(Path('tests/fixtures/daw-arrangement.json').read_text()));a.update(legacy_mastering=False,pan_law='equal_power',duration=2,missing=[],unplaced=[],derived_clips=[])
  a['loop']['end']=2;a['clips']=[dict(id=f'c{i}',name=f'{i}.wav',duration=2,offset=0) for i in range(2)]
  a['regions']=[dict(a['regions'][0],id=f'r{i}',clip=f'c{i}',lane=f'l{i}',src_start=0,src_end=2,start=0,lines=[]) for i in range(2)]
  transcript=dict(speakers=[dict(id='s0',name='Host')],words=[dict(w='hello',start=0,end=1,speaker='s0',conf=1)],segments=[],method='test')
  edits=dict(operations=[dict(op='mute',start=.5,end=1)],corrections={},speaker_names={},timeline=a)
  settings=dict(formats=['wav'],wav=dict(bit_depth='32f',sample_rate=48000),subtitles=[],speaker_labels=False)
  with tempfile.TemporaryDirectory() as tmp:
   folder=Path(tmp);stems={}
   for i,value in enumerate((.1,.2)):
    path=folder/f'{i}.wav';sf.write(path,np.full((96000,2),value,dtype='float32'),48000,subtype='FLOAT');stems[f'c{i}']=path
   work=folder/'out';work.mkdir();paths=render(folder/'unused.wav',work,transcript,edits,settings,2,clip_sources=stems)
   output,_=sf.read(next(p for p in paths if p.suffix=='.wav'),dtype='float32',always_2d=True)
   self.assertAlmostEqual(float(output[1000,0]),.3*np.sqrt(.5),places=5)
   self.assertAlmostEqual(float(output[30000,0]),0,places=5)
