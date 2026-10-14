// Capture du micro : blocs de 4096 échantillons Float32 (~85 ms à 48 kHz),
// postés au thread principal qui les convertit en PCM 16 bits.
const CHUNK_FRAMES = 4096;

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(CHUNK_FRAMES);
    this.length = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i += 1) {
      this.buffer[this.length++] = channel[i];
      if (this.length === CHUNK_FRAMES) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(CHUNK_FRAMES);
        this.length = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
