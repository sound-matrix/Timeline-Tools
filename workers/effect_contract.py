"""Dependency-free parameter validation shared by API parity tests and worker DSP."""
import math
import re

SPECS = {
 'eq':{k:v for i,f in enumerate((80,300,1000,3500,10000)) for k,v in ((f'f{i}',(f,20,20000)),(f'g{i}',(0,-24,24)),(f'q{i}',(1,.1,12)))},
 'compressor':dict(threshold=(-24,-60,0),ratio=(4,1,20),attack=(.01,.001,1),release=(.2,.01,2),knee=(12,0,40),makeup=(0,0,24)),
 'limiter':dict(threshold=(-1,-12,0),release=(.08,.01,1)),
 'reverb':dict(decay=(1.2,.1,3),mix=(.2,0,1)),
 'delay':dict(beats=(.5,.125,4),feedback=(.3,0,.85),mix=(.2,0,1)),
 'saturation':dict(drive=(2,1,16),mix=(.5,0,1)),
 'gate':dict(threshold=(-40,-80,-6)),
 'deesser':dict(frequency=(6000,2000,12000),reduction=(6,0,18)),
}
def validate_slots(slots):
 if not isinstance(slots,list) or len(slots)>16: raise ValueError('Invalid effect chain')
 ids=set()
 for s in slots:
  if not isinstance(s,dict) or set(s)!={'id','type','enabled','parameters'} or s.get('type') not in SPECS or type(s.get('enabled')) is not bool:raise ValueError('Invalid effect slot')
  if not isinstance(s['id'],str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}',s['id']) or s['id'] in ids:raise ValueError('Invalid effect id')
  ids.add(s['id']);p=s['parameters'];spec=SPECS[s['type']]
  if not isinstance(p,dict) or set(p)!=set(spec):raise ValueError('Invalid effect parameters')
  for key,(_,lo,hi) in spec.items():
   value=p[key]
   if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value) or not lo<=value<=hi:raise ValueError('Invalid effect parameter')
 return slots

