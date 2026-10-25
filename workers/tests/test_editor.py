import copy,json,tempfile,unittest,math
from pathlib import Path
import numpy as np
import soundfile as sf
from workers.editor_export import asset_path,validate_editor_snapshot,render_editor
from workers.studio_audio import migrate_arrangement,fade_envelope,pan_gains
from workers.studio_export import apply_inserts
OWNER='a1111111-1111-4111-8111-111111111111';PROJECT='33333333-3333-4333-8333-333333333333';ASSET='55555555-5555-4555-8555-555555555555'
def fixture():
 a=migrate_arrangement(json.loads(Path('tests/fixtures/daw-arrangement.json').read_text()));a.update(job_id=PROJECT,editor_project=True,pan_law='equal_power',legacy_mastering=False,duration=2,missing=[],unplaced=[])
 a['loop']['end']=2;a['clips']=[dict(id=ASSET,asset=ASSET,name='Imported.wav',duration=2)]
 r=dict(a['regions'][0],clip=ASSET,src_start=0,src_end=2,start=0,fade_in=.1,fade_out=.3,gain_db=-6,fade_curve='equal_power',lines=[])
 a['regions']=[r,dict(r,id='crossfade',start=.5,src_end=1.5,fade_in=.5,fade_out=.5,gain_db=-9)]
 a['lanes'][0]['pan']=.3;a['master']['gain_db']=-2
 return a
class EditorExport(unittest.TestCase):
 def test_paths_ownership_and_insert_passthrough(self):
  path=f'editor/{OWNER}/{PROJECT}/{ASSET}.wav'
  self.assertEqual(asset_path(path,OWNER,PROJECT,ASSET),path)
  for bad in (path.replace(OWNER,PROJECT),path+'/../secret',path.replace('.wav','.mp4')):
   with self.assertRaises(ValueError):asset_path(bad,OWNER,PROJECT,ASSET)
  a=fixture();row=dict(id=ASSET,project_id=PROJECT,user_id=OWNER,storage_path=path,peaks_path=path[:-4]+'.peaks',duration=2)
  validate_editor_snapshot(dict(arrangement=a,assets=[row]),OWNER,PROJECT)
  with self.assertRaises(ValueError):validate_editor_snapshot(dict(arrangement=a,assets=[dict(row,user_id=PROJECT)]),OWNER,PROJECT)
  value=np.ones(10);self.assertIs(apply_inserts(value,[]),value)
  with self.assertRaises(ValueError):apply_inserts(value,[{}])
 def test_editor_export_range_and_parity_fixture(self):
  a=fixture();rate=48000;t=np.arange(rate*2)/rate;signal=np.column_stack([np.sin(t*440*2*np.pi)*.1,np.sin(t*660*2*np.pi)*.1]).astype('float32')
  with tempfile.TemporaryDirectory() as tmp:
   folder=Path(tmp);source=folder/'source.wav';sf.write(source,signal,rate,subtype='FLOAT')
   settings=dict(revision=1,range=[0,2],options=dict(format='wav',rate=rate,depth=24,bitrate=320,normalize=False),subtitles=[])
   paths=render_editor({ASSET:source},a,folder,settings);out,sr=sf.read(paths[0],dtype='float32',always_2d=True)
   reference=np.zeros_like(signal)
   for r in a['regions']:
    start=round(r['start']*rate);count=round((r['src_end']-r['src_start'])*rate);samples=signal[:count]
    env=fade_envelope(r,np.arange(count)/rate);gain=10**((r['gain_db']+a['lanes'][0]['gain_db']+a['master']['gain_db'])/20)
    reference[start:start+count]+=samples*env[:,None]*np.asarray(pan_gains(.3))*gain
   rms=float(np.sqrt(np.mean((out-reference)**2)));self.assertLess(20*math.log10(max(rms,1e-20)),-60)
   self.assertEqual(sr,48000);self.assertEqual(len(out),96000)

 def test_editor_export_applies_ordered_effects_and_reverse(self):
  from workers.editor_dsp import InsertChain,SPECS
  a=fixture();a['regions']=a['regions'][:1];r=a['regions'][0];r.update(gain_db=0,fade_in=0,fade_out=0,reverse=True,inserts=[])
  a['lanes'][0].update(gain_db=0,pan=0);a['master'].update(gain_db=0,inserts=[])
  slots=[dict(id='eq',type='eq',enabled=True,parameters={k:v[0] for k,v in SPECS['eq'].items()}),dict(id='drive',type='saturation',enabled=True,parameters=dict(drive=4,mix=.5))]
  slots[0]['parameters']['g2']=6;a['lanes'][0]['inserts']=slots
  rate=48000;t=np.arange(rate*2)/rate;signal=np.column_stack([np.sin(t*440*2*np.pi)*.15,np.sin(t*660*2*np.pi)*.1]).astype('float32')
  settings=dict(revision=1,range=[0,2],options=dict(format='wav',rate=rate,depth=24,bitrate=320,normalize=False),subtitles=[])
  with tempfile.TemporaryDirectory() as tmp:
   folder=Path(tmp);source=folder/'input.wav';sf.write(source,signal,rate,subtype='FLOAT')
   outputs=render_editor({ASSET:source},a,folder,settings);out,_=sf.read(outputs[0],dtype='float32',always_2d=True)
   reference=InsertChain(slots,rate,120).process(signal[::-1])*np.asarray(pan_gains(0))
   np.testing.assert_allclose(out,reference,atol=2e-6)

 def test_editor_export_master_ceiling_after_sum_and_master_gain_with_reverb_tail(self):
  from workers.tests.test_editor_dsp import slot
  rate=48000
  a=fixture();a['regions']=a['regions'][:1]
  a['regions'][0].update(src_end=.02,gain_db=0,fade_in=0,fade_out=0,reverse=False,inserts=[])
  a['lanes'][0].update(gain_db=0,pan=0,inserts=[slot('reverb',mix=1,decay=1.2)])
  a['master'].update(gain_db=12,inserts=[slot('limiter',threshold=-1)])
  signal=np.zeros((rate*2,2),dtype='float32');signal[0]=1
  settings=dict(revision=1,range=[0,2],options=dict(format='wav',rate=rate,depth=24,bitrate=320,normalize=False),subtitles=[])
  with tempfile.TemporaryDirectory() as tmp:
   folder=Path(tmp);source=folder/'input.wav';sf.write(source,signal,rate,subtype='FLOAT')
   outputs=render_editor({ASSET:source},a,folder,settings);wet,_=sf.read(outputs[0],dtype='float32',always_2d=True)
   self.assertGreater(float(np.sum(wet[4800:]**2)),.01)
   a['lanes'][0]['inserts']=[]
   # A sustained full-scale input exercises overshoot, rather than a silent tail.
   signal[:rate]=np.sin(2*np.pi*440*np.arange(rate)/rate)[:,None]
   sf.write(source,signal,rate,subtype='FLOAT')
   second=folder/'limited';second.mkdir()
   outputs=render_editor({ASSET:source},a,second,settings);limited,_=sf.read(outputs[0],dtype='float32',always_2d=True)
   self.assertLessEqual(float(np.max(np.abs(limited))),10**(-1/20)+1e-7)
   self.assertGreater(float(np.max(np.abs(limited))),.5)
