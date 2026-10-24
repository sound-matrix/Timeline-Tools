let timer;
self.onmessage=({data})=>{clearInterval(timer);if(data.running)timer=setInterval(()=>self.postMessage('tick'),data.interval??25);};
