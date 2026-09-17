/**
 * recorder-processor.js
 *
 * AudioWorkletProcessor that captures the microphone onto the AudioContext clock.
 *
 * This file lives in `public/` on purpose: Vite must serve it verbatim (no bundling,
 * no import rewriting) because `audioWorklet.addModule()` loads it as-is. See
 * `src/audio/mic.ts` -> WORKLET_URL.
 *
 * Contract with the main thread:
 *   main -> worklet : { type: 'arm' } | { type: 'disarm' }
 *   worklet -> main : { type: 'origin', originFrame }        first quantum after arm
 *                     { frameIndex, samples }                one chunk, buffer transferred
 *                     { type: 'disarmed', originFrame }      after the final flush
 *
 * `frameIndex` is the absolute frame position of the chunk start on the AudioContext
 * timeline (`currentFrame`), which is what makes sample-accurate alignment possible.
 * While armed we always emit 128 frames per quantum, even when the input is empty, so
 * the frame mapping never drifts.
 */

const CHUNK_FRAMES = 4096;

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.armed = false;
    this.originFrame = -1;
    this.chunkStartFrame = -1;
    this.writeIndex = 0;
    this.chunk = new Float32Array(CHUNK_FRAMES);

    this.port.onmessage = (event) => {
      const message = event.data;
      if (!message || typeof message.type !== 'string') return;
      if (message.type === 'arm') {
        this.armed = true;
        this.originFrame = -1;
        this.chunkStartFrame = -1;
        this.writeIndex = 0;
      } else if (message.type === 'disarm') {
        this.flush();
        this.armed = false;
        this.port.postMessage({ type: 'disarmed', originFrame: this.originFrame });
      }
    };
  }

  flush() {
    if (this.writeIndex === 0) return;
    const samples = this.chunk.slice(0, this.writeIndex);
    this.port.postMessage(
      { frameIndex: this.chunkStartFrame, samples, originFrame: this.originFrame },
      [samples.buffer],
    );
    this.writeIndex = 0;
    this.chunkStartFrame = -1;
  }

  process(inputs, outputs) {
    // We own a silent output path (mic.ts connects us to a zero-gain node) so the
    // render graph keeps pulling us; keep that output at exactly zero.
    const output = outputs[0];
    if (output) {
      for (let c = 0; c < output.length; c++) output[c].fill(0);
    }

    if (!this.armed) return true;

    const input = inputs[0];
    const channel = input && input.length > 0 && input[0] ? input[0] : null;

    if (this.originFrame < 0) {
      this.originFrame = currentFrame;
      this.port.postMessage({ type: 'origin', originFrame: this.originFrame });
    }

    for (let i = 0; i < 128; i++) {
      if (this.writeIndex === 0) this.chunkStartFrame = currentFrame + i;
      this.chunk[this.writeIndex++] = channel ? channel[i] : 0;
      if (this.writeIndex >= CHUNK_FRAMES) this.flush();
    }
    return true;
  }
}

registerProcessor('loop-recorder-processor', RecorderProcessor);
