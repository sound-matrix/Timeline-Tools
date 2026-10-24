import { TimelineRenderer } from "./render-core.js";
const renderer = new TimelineRenderer();
let surface, state = {}, pending = false;
self.onmessage = ({data}) => {
  if(data.canvas){surface=data.canvas;return;}
  Object.assign(state,data);
  if(pending)return;pending=true;
  (self.requestAnimationFrame?.bind(self) ?? ((cb)=>setTimeout(cb,0)))(()=>{
    pending=false;renderer.draw(surface,state);
  });
};
