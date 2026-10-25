"""Bounded, stateful stereo insert DSP. Parameter contract mirrors lib/daw/effects.ts.
Compressor is an approximation of Web Audio's implementation-defined detector.
"""
import math
import numpy as np
from scipy.signal import lfilter

from workers.effect_contract import SPECS,validate_slots

def biquad(kind,freq,q,gain,rate):
 w=2*math.pi*min(freq,rate*.49)/rate;c=math.cos(w);sn=math.sin(w);A=10**(gain/40)
 if kind=='peak':
  alpha=sn/(2*q);b=[1+alpha*A,-2*c,1-alpha*A];a=[1+alpha/A,-2*c,1-alpha/A]
 else:
  # Web Audio high shelf uses S=1.
  alpha=sn/math.sqrt(2);v=2*math.sqrt(A)*alpha
  b=[A*((A+1)+(A-1)*c+v),-2*A*((A-1)+(A+1)*c),A*((A+1)+(A-1)*c-v)]
  a=[(A+1)-(A-1)*c+v,2*((A-1)-(A+1)*c),(A+1)-(A-1)*c-v]
 return np.asarray(b)/a[0],np.asarray(a)/a[0]

class InsertChain:
 def __init__(self,slots,rate=48000,tempo=120):
  self.rate=rate;self.effects=[]
  for slot in validate_slots(slots):
   if not slot['enabled']:continue
   kind=slot['type'];p=slot['parameters'];state={}
   if kind in ('eq','deesser'):
    filters=[biquad('peak',p[f'f{i}'],p[f'q{i}'],p[f'g{i}'],rate) for i in range(5)] if kind=='eq' else [biquad('shelf',p['frequency'],1,-p['reduction'],rate)]
    state['filters']=[(b,a,np.zeros((2,2))) for b,a in filters]
   if kind=='reverb':state['history']=np.zeros((math.ceil(rate*p['decay']),2))
   if kind=='delay':
    size=max(1,round(60/tempo*p['beats']*rate));state.update(ring=np.zeros((size,2)),feedback=np.zeros((size+128,2)),cursor=0,feedback_cursor=0)
   if kind in ('compressor','limiter'):state.update(attack=np.zeros((1,)),release=np.zeros((1,)))
   self.effects.append((kind,p,state))
 def process(self,samples):
  x=samples
  for kind,p,state in self.effects:
   if kind in ('eq','deesser'):
    for i,(b,a,zi) in enumerate(state['filters']):
     x,z=lfilter(b,a,x,axis=0,zi=zi);state['filters'][i]=(b,a,z)
   elif kind=='saturation':
    bounded=np.clip(x,-1,1);x=bounded*(1-p['mix'])+p['mix']*np.tanh(bounded*p['drive'])/math.tanh(p['drive'])
   elif kind=='gate':x=np.where(np.abs(x)<10**(p['threshold']/20),0,np.clip(x,-1,1))
   elif kind=='reverb':
    history=state['history'];n=len(history);buf=np.concatenate((history,x));wet=np.zeros_like(x)
    for j in range(1,33):
     delay=min(n-1,math.floor(n*j/33+.5));wet+=buf[n-delay:n-delay+len(x)]*(math.exp(-3*j/33)*(-1 if j%2 else 1)/8)
    state['history']=buf[-n:];x=x*(1-p['mix'])+wet*p['mix']
   elif kind=='delay':
    ring=state['ring'];feedback=state['feedback'];pos=state['cursor'];back=state['feedback_cursor'];wet=np.empty_like(x);at=0
    # A Web Audio cycle contributes one render quantum (128 samples) to feedback.
    while at<len(x):
     n=min(len(x)-at,len(ring)-pos,len(feedback)-back)
     out=ring[pos:pos+n].copy()+feedback[back:back+n]*p['feedback'];wet[at:at+n]=out
     ring[pos:pos+n]=x[at:at+n];feedback[back:back+n]=out
     at+=n;pos=(pos+n)%len(ring);back=(back+n)%len(feedback)
    state['cursor']=pos;state['feedback_cursor']=back;x=x*(1-p['mix'])+wet*p['mix']
   else:
    levels=20*np.log10(np.maximum(np.max(np.abs(x),axis=1),1e-12));t=p['threshold'];k=p.get('knee',0);ratio=p.get('ratio',20)
    over=levels-t;reduction=np.maximum(over,0)*(1-1/ratio)
    if k>0:
     knee=np.abs(over)<k/2;reduction=np.where(knee,(1-1/ratio)*(over+k/2)**2/(2*k),reduction)
    for name,seconds in (('attack',p.get('attack',.001)),('release',p['release'])):
     alpha=math.exp(-1/(seconds*self.rate));reduction,z=lfilter([1-alpha],[1,-alpha],reduction,zi=state[name]);state[name]=z
    x=x*10**((p.get('makeup',0)-reduction[:,None])/20)
    if kind=='limiter':x=np.clip(x,-10**(p['threshold']/20),10**(p['threshold']/20))
  return np.asarray(x,dtype='float32')
