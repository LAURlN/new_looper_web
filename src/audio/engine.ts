/**
 * Audio engine: AudioContext lifecycle, graph, layer store, state machine.
 *
 * Everything musical is scheduled on the AudioContext clock — there is no setTimeout
 * anywhere in the timing path.
 */
import { Observable } from '../util/observable';
import {
  calibrate,
  clearStoredCalibration,
  isCalibrationUsable,
  loadCalibration,
  saveCalibration,
  type CalibrationRecord,
  type CalibrationResult,
} from './calibration';
import { MicError, MicRecorder, openMicrophone } from './mic';
import type { MonoBuffer } from './dsp';

export type EngineStateName = 'IDLE' | 'RECORDING' | 'OVERDUBBING' | 'FULL';
export type MicState = 'unknown' | 'ready' | 'denied' | 'unavailable' | 'unsupported' | 'error';

export const MAX_LAYERS = 5;
export const MAX_OVERDUBS = MAX_LAYERS - 1;

/** Scheduling lead for overdub passes: long enough that every source lands sample-accurately. */
const PASS_LEAD_SECONDS = 0.08;
/** Takes shorter than this are treated as accidental double taps and discarded. */
const MIN_TAKE_SECONDS = 0.05;
const RESUME_LEAD_SECONDS = 0.005;

export interface Layer {
  id: number;
  /** Mono, ctx.sampleRate. */
  samples: MonoBuffer;
  /** AudioContext frame when the take began. */
  originFrame: number;
  /** Latency compensation, usually negative. */
  shiftFrames: number;
}

export interface EngineSnapshot {
  state: EngineStateName;
  layerCount: number;
  maxLayers: number;
  /** 1..4 while OVERDUBBING (which overdub is being recorded), otherwise 0. */
  overdubIndex: number;
  canUndo: boolean;
  calibrated: boolean;
  calibratedMs: number | null;
  micState: MicState;
  message: string | null;
  contextState: AudioContextState | 'none';
}

export interface AudioInfo {
  contextState: AudioContextState | 'none';
  sampleRate: number | null;
  baseLatencyMs: number | null;
  outputLatencyMs: number | null;
  calibration: CalibrationRecord | null;
  calibrationUsable: boolean;
  calibratedMs: number | null;
  micState: MicState;
  micMessage: string | null;
}

/** `null` when the audio context + microphone are usable, otherwise a user-facing reason. */
export type ReadyProblem = string | null;

interface WakeLockSentinelLike {
  release(): Promise<void>;
}

interface NavigatorWithWakeLock {
  wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
}

export class LoopEngine {
  readonly state: Observable<EngineSnapshot>;
  readonly level: Observable<number>;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private recorder: MicRecorder | null = null;
  private stream: MediaStream | null = null;
  private layers: Layer[] = [];
  private activeSources: AudioBufferSourceNode[] = [];
  private calibration: CalibrationRecord | null = null;
  private nextLayerId = 1;
  private transitioning = false;
  private fatal: string | null = null;
  private wakeLock: WakeLockSentinelLike | null = null;
  private micLevel = 0;
  private smoothedLevel = 0;
  private levelRaf = 0;
  private analyserBuffer: MonoBuffer | null = null;
  private passOriginFrame = 0;

  constructor() {
    this.state = new Observable<EngineSnapshot>({
      state: 'IDLE',
      layerCount: 0,
      maxLayers: MAX_LAYERS,
      overdubIndex: 0,
      canUndo: false,
      calibrated: false,
      calibratedMs: null,
      micState: 'unknown',
      message: null,
      contextState: 'none',
    });
    this.level = new Observable<number>(0);
    this.calibration = loadCalibration();
    this.refreshSnapshot();
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * Creates the AudioContext (+ mic graph) on the first user gesture. Creates the context
   * only once, keeps the mic stream alive for the whole session, and is safe to call from
   * every pointerdown.
   */
  async ensureReady(): Promise<ReadyProblem> {
    if (this.fatal) return this.fatal;

    if (!this.ctx) {
      // Must happen synchronously inside the gesture handler; no await before resume().
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = ctx;
      const master = ctx.createGain();
      master.gain.value = 1;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      // master -> analyser -> destination: the analyser sits in the live path so the
      // render graph always pulls it (a dangling analyser is not guaranteed to run).
      master.connect(analyser);
      analyser.connect(ctx.destination);
      this.master = master;
      this.analyser = analyser;
      this.startLevelLoop();
      ctx.addEventListener('statechange', () => {
        this.refreshSnapshot();
      });
      void ctx.resume();
    }

    const ctx = this.ctx;
    if (ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch {
        /* still suspended; the banner keeps prompting the user */
      }
    }

    if (!this.recorder) {
      try {
        this.stream = await openMicrophone();
        this.recorder = await MicRecorder.create(ctx, this.stream);
        this.recorder.onLevel = (rms) => {
          this.micLevel = Math.max(this.micLevel, rms);
        };
        this.patch({ micState: 'ready', message: null });
      } catch (error) {
        // Do not leak a granted stream when the worklet graph fails to build.
        this.stream?.getTracks().forEach((track) => track.stop());
        this.stream = null;
        if (error instanceof MicError) {
          const micState: MicState =
            error.kind === 'denied'
              ? 'denied'
              : error.kind === 'unsupported'
                ? 'unsupported'
                : error.kind === 'worklet'
                  ? 'error'
                  : 'unavailable';
          const fatal = error.kind === 'worklet' ? error.message : null;
          this.fatal = fatal;
          this.patch({ micState, message: error.message });
          return error.message;
        }
        const message = 'Could not start audio — check the microphone permission';
        this.patch({ micState: 'error', message });
        return message;
      }
    }

    return null;
  }

  /** Cheap resume hook for "any pointerdown anywhere". */
  resumeIfNeeded(): void {
    const ctx = this.ctx;
    if (ctx && ctx.state !== 'running') void ctx.resume();
  }

  // ------------------------------------------------------------------ actions

  async tap(): Promise<void> {
    if (this.transitioning) return; // re-entrant taps are ignored
    if (this.state.get().state === 'FULL') return; // 5 layers: undo to continue
    this.transitioning = true;
    try {
      const problem = await this.ensureReady();
      if (problem !== null) return;

      switch (this.state.get().state) {
        case 'IDLE':
          if (this.layers.length === 0) await this.beginFirstTake();
          else await this.beginOverdubPass();
          break;
        case 'RECORDING':
          await this.commitFirstTake();
          break;
        case 'OVERDUBBING':
          await this.commitOverdub();
          break;
        case 'FULL':
          break;
      }
    } catch (error) {
      this.patch({ message: error instanceof Error ? error.message : 'Audio error' });
      this.abortPass();
    } finally {
      this.transitioning = false;
    }
  }

  async undo(): Promise<void> {
    if (this.transitioning) return;
    this.transitioning = true;
    try {
      const current = this.state.get().state;
      if (current === 'RECORDING' || current === 'OVERDUBBING') {
        await this.discardInFlightTake('Take discarded');
        return;
      }
      if (this.layers.length > 0) {
        this.layers.pop();
        // Also covers FULL: undoing frees a slot, so the disc becomes tappable again.
        this.setState('IDLE', { message: 'Layer removed' });
      }
    } finally {
      this.transitioning = false;
    }
  }

  /** iOS/Android suspend the context when the app is backgrounded; drop any in-flight take. */
  async handleBackgrounded(): Promise<void> {
    const current = this.state.get().state;
    if (current !== 'RECORDING' && current !== 'OVERDUBBING') return;
    if (this.transitioning) return;
    this.transitioning = true;
    try {
      await this.discardInFlightTake('Take discarded — app went to the background');
    } finally {
      this.transitioning = false;
    }
  }

  async calibrate(onStatus?: (status: string) => void): Promise<CalibrationResult> {
    const problem = await this.ensureReady();
    if (problem !== null) return { ok: false, probes: [], message: problem };
    if (!this.ctx || !this.master || !this.recorder) {
      return { ok: false, probes: [], message: 'Audio not ready' };
    }
    if (this.state.get().state !== 'IDLE') {
      return { ok: false, probes: [], message: 'Stop the current take before calibrating' };
    }
    const result = await calibrate({
      ctx: this.ctx,
      output: this.master,
      recorder: this.recorder,
      onStatus,
    });
    if (result.ok && result.roundTripMs !== undefined) {
      const record: CalibrationRecord = {
        roundTripMs: result.roundTripMs,
        sampleRate: this.ctx.sampleRate,
        measuredAt: Date.now(),
      };
      saveCalibration(record);
      this.calibration = record;
      this.refreshSnapshot();
    }
    return result;
  }

  clearCalibration(): void {
    clearStoredCalibration();
    this.calibration = null;
    this.refreshSnapshot();
  }

  getAudioInfo(): AudioInfo {
    const ctx = this.ctx;
    const sampleRate = ctx ? ctx.sampleRate : null;
    const usable = isCalibrationUsable(this.calibration, sampleRate);
    const snapshot = this.state.get();
    return {
      contextState: ctx ? ctx.state : 'none',
      sampleRate,
      baseLatencyMs: ctx && typeof ctx.baseLatency === 'number' ? ctx.baseLatency * 1000 : null,
      outputLatencyMs:
        ctx && typeof ctx.outputLatency === 'number' ? ctx.outputLatency * 1000 : null,
      calibration: this.calibration,
      calibrationUsable: usable,
      calibratedMs: usable && this.calibration ? this.calibration.roundTripMs : null,
      micState: snapshot.micState,
      micMessage: snapshot.message,
    };
  }

  /** Re-attempts the microphone after the user grants permission in browser settings. */
  async retryMicrophone(): Promise<void> {
    this.fatal = null;
    this.patch({ micState: 'unknown', message: null });
    await this.ensureReady();
    this.refreshSnapshot();
  }

  dispose(): void {
    if (this.levelRaf) cancelAnimationFrame(this.levelRaf);
    this.abortPass();
    this.recorder?.dispose();
    this.recorder = null;
    this.stream = null;
    void this.ctx?.close();
    this.ctx = null;
  }

  // -------------------------------------------------------------- take control

  private async beginFirstTake(): Promise<void> {
    const ctx = this.requireCtx();
    const recorder = this.requireRecorder();
    const originFrame = await recorder.arm();
    // The base take defines the timeline, so its own origin is the reference: shift 0.
    this.passOriginFrame = originFrame;
    this.setState('RECORDING', { overdubIndex: 0, message: null });
    void this.requestWakeLock();
    if (ctx.state !== 'running') await ctx.resume();
  }

  private async commitFirstTake(): Promise<void> {
    const take = await this.requireRecorder().disarm();
    this.releaseWakeLock();
    if (!this.isTakeUsable(take.samples.length)) {
      this.abortPass();
      this.patch({ message: 'Take too short — nothing recorded' });
      return;
    }
    this.layers.push({
      id: this.nextLayerId++,
      samples: take.samples,
      originFrame: take.originFrame,
      shiftFrames: 0,
    });
    this.setState(this.layers.length >= MAX_LAYERS ? 'FULL' : 'IDLE', { message: null });
  }

  private async beginOverdubPass(): Promise<void> {
    const ctx = this.requireCtx();
    const recorder = this.requireRecorder();

    // Arm first so we know the exact capture origin, then schedule the pass slightly in
    // the future. Both the playback and the recording origin are on the same clock.
    // Arming first also tells us how much pre-roll gets captured; that offset is folded
    // into the layer shift below so the pass stays sample-accurate.
    await recorder.arm();
    const startTime = ctx.currentTime + PASS_LEAD_SECONDS;
    const passOriginFrame = Math.round(startTime * ctx.sampleRate);
    this.passOriginFrame = passOriginFrame;
    this.startPass(startTime);
    this.setState('OVERDUBBING', {
      overdubIndex: this.layers.length,
      // Pre-roll between arming and the pass start is captured too; it is accounted for
      // in the layer shift and trimmed on playback.
      message: null,
    });
    void this.requestWakeLock();
  }

  private async commitOverdub(): Promise<void> {
    const take = await this.requireRecorder().disarm();
    this.releaseWakeLock();
    this.stopSources();
    if (!this.isTakeUsable(take.samples.length)) {
      this.abortPass();
      this.patch({ message: 'Take too short — nothing recorded' });
      return;
    }

    const latencyFrames = this.latencyFrames();
    // The performer plays in time with the monitor, which they hear delayed by output
    // latency, and their performance is captured delayed again by input latency. The
    // measured round trip is exactly output + input, so pulling the new layer earlier by
    // that amount (plus the capture pre-roll) lines it up with what they actually heard.
    let shiftFrames = take.originFrame - this.passOriginFrame - latencyFrames;
    if (shiftFrames < -take.samples.length) {
      console.warn(
        `[loop-recorder] latency shift (${shiftFrames} frames) exceeds take length; clamping`,
      );
      shiftFrames = -take.samples.length;
    }
    this.layers.push({
      id: this.nextLayerId++,
      samples: take.samples,
      originFrame: take.originFrame,
      shiftFrames,
    });
    this.setState(this.layers.length >= MAX_LAYERS ? 'FULL' : 'IDLE', { message: null });
  }

  private async discardInFlightTake(message: string): Promise<void> {
    const recorder = this.recorder;
    if (recorder?.isArmed) {
      try {
        await recorder.disarm();
      } catch {
        /* nothing to salvage */
      }
    }
    this.releaseWakeLock();
    this.abortPass();
    this.setState('IDLE', { message });
  }

  private abortPass(): void {
    this.stopSources();
    this.releaseWakeLock();
    const current = this.state.get().state;
    this.setState(current === 'FULL' ? 'FULL' : 'IDLE', { overdubIndex: 0 });
  }

  private isTakeUsable(frameCount: number): boolean {
    return frameCount >= Math.round(MIN_TAKE_SECONDS * this.requireCtx().sampleRate);
  }

  /** Frames of measured round-trip latency, or 0 when uncalibrated. */
  private latencyFrames(): number {
    const ctx = this.requireCtx();
    const usable = isCalibrationUsable(this.calibration, ctx.sampleRate);
    if (!usable || !this.calibration) return 0;
    return Math.round((this.calibration.roundTripMs / 1000) * ctx.sampleRate);
  }

  // ---------------------------------------------------------------- playback

  private startPass(startTime: number): void {
    const ctx = this.requireCtx();
    const master = this.requireMaster();
    const sampleRate = ctx.sampleRate;
    this.stopSources();
    this.activeSources = [];

    for (const layer of this.layers) {
      if (layer.samples.length === 0) continue;
      const buffer = ctx.createBuffer(1, layer.samples.length, sampleRate);
      buffer.copyToChannel(layer.samples, 0);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(master);

      // Latency compensation is applied by moving the schedule point (and, when the
      // shift pushes the start into the past, by skipping the head of the buffer).
      // The stored take itself is never modified.
      const shiftSeconds = layer.shiftFrames / sampleRate;
      const shiftedStart = startTime + shiftSeconds;
      const earliest = ctx.currentTime + RESUME_LEAD_SECONDS;
      const when = Math.max(shiftedStart, earliest);
      const offsetSeconds = when - shiftedStart;
      if (offsetSeconds < layer.samples.length / sampleRate) {
        source.start(when, offsetSeconds);
      }
      this.activeSources.push(source);
    }
  }

  private stopSources(): void {
    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
      try {
        source.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.activeSources = [];
  }

  // ------------------------------------------------------------------- level

  private startLevelLoop(): void {
    if (this.levelRaf) return;
    const tick = (): void => {
      this.levelRaf = requestAnimationFrame(tick);
      const analyser = this.analyser;
      if (!analyser) return;
      if (!this.analyserBuffer || this.analyserBuffer.length !== analyser.fftSize) {
        this.analyserBuffer = new Float32Array(analyser.fftSize);
      }
      analyser.getFloatTimeDomainData(this.analyserBuffer);
      let peak = 0;
      for (let i = 0; i < this.analyserBuffer.length; i++) {
        const value = Math.abs(this.analyserBuffer[i]);
        if (value > peak) peak = value;
      }
      const target = Math.max(peak, this.micLevel);
      this.micLevel *= 0.88;
      this.smoothedLevel = target > this.smoothedLevel ? target : this.smoothedLevel * 0.9;
      this.level.set(Math.min(1, this.smoothedLevel * 1.8));
    };
    this.levelRaf = requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------------ wake lock

  private async requestWakeLock(): Promise<void> {
    try {
      const nav = navigator as unknown as NavigatorWithWakeLock;
      if (!nav.wakeLock) return;
      this.wakeLock = await nav.wakeLock.request('screen');
    } catch {
      /* wake lock is a nice-to-have */
    }
  }

  private releaseWakeLock(): void {
    const lock = this.wakeLock;
    this.wakeLock = null;
    try {
      void lock?.release();
    } catch {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------- helpers

  private requireCtx(): AudioContext {
    if (!this.ctx) throw new Error('AudioContext not created yet');
    return this.ctx;
  }

  private requireMaster(): GainNode {
    if (!this.master) throw new Error('Master gain not created yet');
    return this.master;
  }

  private requireRecorder(): MicRecorder {
    if (!this.recorder) throw new Error('Microphone not ready');
    return this.recorder;
  }

  private setState(next: EngineStateName, patch: Partial<EngineSnapshot> = {}): void {
    this.patch({
      state: next,
      layerCount: this.layers.length,
      canUndo: this.layers.length > 0 || next === 'RECORDING' || next === 'OVERDUBBING',
      ...patch,
    });
  }

  private patch(patch: Partial<EngineSnapshot>): void {
    this.state.set({ ...this.state.get(), ...patch });
  }

  private refreshSnapshot(): void {
    const info = this.getAudioInfo();
    const current = this.state.get();
    this.patch({
      layerCount: this.layers.length,
      canUndo: this.layers.length > 0 || current.state === 'RECORDING' || current.state === 'OVERDUBBING',
      calibrated: info.calibratedMs !== null,
      calibratedMs: info.calibratedMs,
      contextState: info.contextState,
    });
  }
}
