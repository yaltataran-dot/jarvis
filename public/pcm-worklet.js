// Hands the microphone's samples to the page in blocks of 1024. Runs on the
// audio thread, so it does nothing else: the page downsamples and sends.
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(1024)
    this.at = 0
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.at++] = ch[i]
      if (this.at === this.buf.length) {
        this.port.postMessage(this.buf)
        this.buf = new Float32Array(1024)
        this.at = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-tap', PcmTap)
