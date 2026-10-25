// Echo's recurrence is shared by live and offline Web Audio. The export worker
// uses the same D-sample input ring and (D + 128)-sample feedback ring.
class TimelineEcho extends AudioWorkletProcessor {
  constructor({ processorOptions: { delayFrames, feedback } }) {
    super();
    this.direct = [
      new Float32Array(delayFrames),
      new Float32Array(delayFrames),
    ];
    this.repeat = [
      new Float32Array(delayFrames + 128),
      new Float32Array(delayFrames + 128),
    ];
    this.feedback = feedback;
    this.cursor = 0;
    this.back = 0;
    this.disposed = false;
    this.port.onmessage = ({ data }) => {
      if (data === "dispose") this.disposed = true;
      else if (data && Number.isFinite(data.feedback)) {
        this.feedback = data.feedback;
        if (data.delayFrames !== this.direct[0].length) {
          this.direct = [
            new Float32Array(data.delayFrames),
            new Float32Array(data.delayFrames),
          ];
          this.repeat = [
            new Float32Array(data.delayFrames + 128),
            new Float32Array(data.delayFrames + 128),
          ];
          this.cursor = this.back = 0;
        }
      }
    };
  }
  process(inputs, outputs) {
    if (this.disposed) return false;
    const input = inputs[0],
      output = outputs[0];
    for (let i = 0; i < output[0].length; i++) {
      for (let ch = 0; ch < output.length; ch++) {
        const value =
          this.direct[ch][this.cursor] +
          this.repeat[ch][this.back] * this.feedback;
        this.direct[ch][this.cursor] = input[ch]?.[i] ?? 0;
        this.repeat[ch][this.back] = value;
        output[ch][i] = value;
      }
      this.cursor = (this.cursor + 1) % this.direct[0].length;
      this.back = (this.back + 1) % this.repeat[0].length;
    }
    return true;
  }
}
registerProcessor("timeline-echo", TimelineEcho);
