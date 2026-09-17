/**
 * Microphone capture.
 *
 * WHY AN AUDIOWORKLET AND NOT MEDIARECORDER:
 * MediaRecorder hands back compressed blobs on their own timeline, so a sample in the
 * blob cannot be mapped to an AudioContext frame. Sample-accurate overdubs need the mic
 * samples on the *same* clock as playback, so we capture raw 32-bit float frames in a
 * worklet and tag every chunk with its absolute `currentFrame`.
 */
import { computeRms, type MonoBuffer } from './dsp';

export interface MicTake {
  /** Mono samples at `ctx.sampleRate`, index 0 == `originFrame`. */
  samples: MonoBuffer;
  /** AudioContext frame of the first captured sample. */
  originFrame: number;
}

export type MicErrorKind = 'unsupported' | 'denied' | 'unavailable' | 'worklet' | 'unknown';

export class MicError extends Error {
  readonly kind: MicErrorKind;

  constructor(kind: MicErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = 'MicError';
    this.kind = kind;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

interface ChunkMessage {
  frameIndex: number;
  samples: MonoBuffer;
  originFrame: number;
}

interface OriginMessage {
  type: 'origin';
  originFrame: number;
}

interface DisarmedMessage {
  type: 'disarmed';
  originFrame: number;
}

type WorkletMessage = ChunkMessage | OriginMessage | DisarmedMessage;

const CHUNK_TIMEOUT_MS = 4000;
const PROCESSOR_NAME = 'loop-recorder-processor';

// Vite must serve the worklet verbatim, so the file lives in `public/` and is loaded by
// absolute URL (BASE_URL keeps this working for sub-path deploys).
const WORKLET_URL = new URL(`${import.meta.env.BASE_URL}recorder-processor.js`, location.href).href;

function isOriginMessage(message: WorkletMessage): message is OriginMessage {
  return (message as OriginMessage).type === 'origin';
}

function isDisarmedMessage(message: WorkletMessage): message is DisarmedMessage {
  return (message as DisarmedMessage).type === 'disarmed';
}

/** Opens the mic with every browser audio "helper" disabled. */
export async function openMicrophone(): Promise<MediaStream> {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
    throw new MicError(
      'unsupported',
      'Microphone unavailable — use https:// or localhost (getUserMedia needs a secure context)',
    );
  }
  try {
    // echoCancellation / noiseSuppression / autoGainControl being OFF is NOT optional.
    // These DSP stages duck, gate and time-shift the signal, which destroys both the
    // round-trip latency measurement and overdub alignment.
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
  } catch (error) {
    const name = errorName(error);
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new MicError('denied', 'Microphone permission denied — enable it in browser settings', error);
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      throw new MicError('unavailable', 'No microphone found on this device', error);
    }
    if (name === 'NotReadableError') {
      throw new MicError('unavailable', 'Microphone is in use by another app', error);
    }
    throw new MicError('unknown', 'Could not start the microphone', error);
  }
}

/** Browsers throw DOMException, but be tolerant of anything with a `name`. */
function errorName(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error) {
    return String((error as { name: unknown }).name);
  }
  return '';
}

/**
 * Owns the mic graph: source -> worklet node -> zero-gain sink -> destination.
 *
 * The recorder node is *not* routed to the speakers. It does need a path to the
 * destination though: a worklet node that is not reachable from the destination is not
 * guaranteed to be pulled by the render graph, and a node that never runs never captures.
 * A zero-gain sink gives us the pull without any audible path, so there is no feedback.
 */
export class MicRecorder {
  private chunks: ChunkMessage[] = [];
  /** True from arm() until the worklet confirms it has flushed everything. */
  private capturing = false;
  private originFrame = -1;
  private disarmPromise: Promise<MicTake> | null = null;
  private armedResolve: ((originFrame: number) => void) | null = null;
  private armedTimer: ReturnType<typeof setTimeout> | null = null;
  private disarmedResolve: ((take: MicTake) => void) | null = null;

  /** RMS of the most recent capture chunk, for the disc level meter. */
  onLevel: ((rms: number) => void) | null = null;

  private constructor(
    private readonly source: MediaStreamAudioSourceNode,
    private readonly node: AudioWorkletNode,
    private readonly sink: GainNode,
  ) {
    this.node.port.onmessage = (event: MessageEvent<WorkletMessage>) => this.handleMessage(event.data);
  }

  static async create(ctx: AudioContext, stream: MediaStream): Promise<MicRecorder> {
    try {
      await ctx.audioWorklet.addModule(WORKLET_URL);
    } catch (error) {
      throw new MicError('worklet', 'AudioWorklet failed to load — recording is unavailable', error);
    }

    let node: AudioWorkletNode;
    try {
      node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
      });
    } catch (error) {
      throw new MicError('worklet', 'AudioWorklet could not be created — recording is unavailable', error);
    }

    const source = ctx.createMediaStreamSource(stream);
    const sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(node);
    node.connect(sink);
    sink.connect(ctx.destination);
    return new MicRecorder(source, node, sink);
  }

  get isArmed(): boolean {
    return this.capturing;
  }

  /** Starts capture. Resolves with the AudioContext frame of the first captured sample. */
  arm(): Promise<number> {
    this.chunks = [];
    this.originFrame = -1;
    this.capturing = true;
    this.disarmPromise = null;
    this.clearArmedWaiter();

    return new Promise<number>((resolve, reject) => {
      this.armedResolve = resolve;
      this.armedTimer = setTimeout(() => {
        this.clearArmedWaiter();
        reject(new MicError('worklet', 'Recorder did not start — no audio callback received'));
      }, CHUNK_TIMEOUT_MS);
      this.node.port.postMessage({ type: 'arm' });
    });
  }

  /** Stops capture and returns everything recorded since `arm()`. */
  disarm(): Promise<MicTake> {
    // Chunks continue to arrive between `disarm` and the worklet's final flush, so the
    // capture flag stays up until the "disarmed" message lands.
    if (!this.capturing) return Promise.resolve(this.assemble());
    if (this.disarmPromise) return this.disarmPromise;
    this.disarmPromise = new Promise<MicTake>((resolve) => {
      this.disarmedResolve = resolve;
      this.node.port.postMessage({ type: 'disarm' });
    });
    return this.disarmPromise;
  }

  dispose(): void {
    this.clearArmedWaiter();
    this.node.port.onmessage = null;
    this.onLevel = null;
    try {
      this.source.disconnect();
      this.node.disconnect();
      this.sink.disconnect();
    } catch {
      /* already torn down */
    }
    for (const track of this.source.mediaStream.getTracks()) track.stop();
  }

  private handleMessage(message: WorkletMessage): void {
    if (isOriginMessage(message)) {
      this.originFrame = message.originFrame;
      const resolve = this.armedResolve;
      this.clearArmedWaiter();
      resolve?.(message.originFrame);
      return;
    }
    if (isDisarmedMessage(message)) {
      if (message.originFrame >= 0) this.originFrame = message.originFrame;
      this.capturing = false;
      const resolve = this.disarmedResolve;
      this.disarmedResolve = null;
      this.disarmPromise = null;
      resolve?.(this.assemble());
      return;
    }
    if (!this.capturing) return;
    if (this.originFrame < 0) this.originFrame = message.originFrame;
    this.chunks.push(message);
    this.onLevel?.(computeRms(message.samples));
  }

  private assemble(): MicTake {
    const origin = this.originFrame;
    if (origin < 0 || this.chunks.length === 0) {
      return { samples: new Float32Array(0), originFrame: Math.max(0, origin) };
    }
    let end = origin;
    for (const chunk of this.chunks) end = Math.max(end, chunk.frameIndex + chunk.samples.length);
    const samples = new Float32Array(Math.max(0, end - origin));
    for (const chunk of this.chunks) {
      const offset = chunk.frameIndex - origin;
      if (offset >= 0) samples.set(chunk.samples, offset);
      else samples.set(chunk.samples.subarray(-offset), 0);
    }
    this.chunks = [];
    return { samples, originFrame: origin };
  }

  private clearArmedWaiter(): void {
    if (this.armedTimer !== null) clearTimeout(this.armedTimer);
    this.armedTimer = null;
    this.armedResolve = null;
  }
}
