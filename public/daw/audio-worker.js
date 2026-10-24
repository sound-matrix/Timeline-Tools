/* Bounded PCM decoding off the main thread. WAV windows arrive via transferables. */
self.onmessage=({data:{id,buffer,header,count}})=>{
 try{
  const bytes=new Uint8Array(buffer),view=new DataView(buffer),channels=[];
  for(let ch=0;ch<header.channels;ch++){
   const data=new Float32Array(count);
   for(let i=0;i<count;i++){
    const p=i*header.block+ch*header.bits/8;let v=0;
    if(header.format===3&&header.bits===32)v=view.getFloat32(p,true);
    else if(header.bits===16)v=view.getInt16(p,true)/32768;
    else if(header.bits===24){let n=bytes[p]|bytes[p+1]<<8|bytes[p+2]<<16;if(n&0x800000)n|=~0xffffff;v=n/8388608;}
    else v=view.getInt32(p,true)/2147483648;
    data[i]=Number.isFinite(v)?v:0;
   }
   channels.push(data);
  }
  self.postMessage({id,channels},channels.map(c=>c.buffer));
 }catch(e){self.postMessage({id,error:e.message})}
};
