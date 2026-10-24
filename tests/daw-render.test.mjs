import test from 'node:test';
import assert from 'node:assert/strict';
import { IntervalIndex, TileCache, TimelineRenderer } from '../public/daw/render-core.js';
test('interval index includes long overlaps and excludes offscreen lanes and regions',()=>{
 const regions=Array.from({length:500},(_,i)=>({id:String(i),lane:'t'+i%20,start:i*7,src_start:0,src_end:8}));
 regions.push({id:'long',lane:'t0',start:0,src_start:0,src_end:3600});
 const index=new IntervalIndex(regions);
 for(let t=0;t<3600;t+=47)for(let lane=0;lane<20;lane++) {
  const expected=regions.filter(r=>r.lane==='t'+lane&&r.start<=t+20&&r.start+r.src_end>=t).map(r=>r.id).sort();
  assert.deepEqual(index.query('t'+lane,t,t+20).map(r=>r.id).sort(),expected);
 }
});
test('waveform cache stays within byte budget and closes evicted bitmaps',()=>{
 let closed=0;const cache=new TileCache(16);const image=()=>({width:2,height:2,close(){closed++;}});
 cache.set('a',image());assert.ok(cache.get('a'));cache.set('b',image());
 assert.equal(closed,1);assert.equal(cache.bytes,16);assert.equal(cache.get('a'),undefined);
 cache.clear();assert.equal(closed,2);assert.equal(cache.bytes,0);
});

test('a collapsed timeline skips bitmap allocation during layout changes', () => {
 const renderer = new TimelineRenderer();
 const surface = { getContext() { throw Error('collapsed canvas must not allocate a drawing context'); } };
 for (const view of [{w:0,h:400},{w:900,h:0}]) renderer.draw(surface,{a:{regions:[]},view,dpr:1});
 assert.equal(renderer.grid,null);
 renderer.close();
});
