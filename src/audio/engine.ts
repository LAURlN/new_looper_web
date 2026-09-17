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
import { MicError, MicRecorder, openMicrophone, type MicTake } from './mic';
import type { MonoBuffer } from './dsp';

export type EngineStateName = 'IDLE' | 'RECORDING' | 'OVERDUBBING' | 'FULL';
export type MicState = 'unknown' | 'ready' | 'denied' | 'unavailable' | 'unsupported' | 'error';

export const MAX_LAYERS = 5;
export const MAX_OVERDUBS = MAX_LAYERS - 1;

/** Takes shorter than this are treated as accidental double taps and discarded. */
const MIN_TAKE_SECONDS = 0.05;
/** Silence between the last take and the first loop cycle, so the loop starts cleanly. */
const LOOP_START_LEAD_SECONDS = 0.1;
/** How far ahead cycles are scheduled on the audio clock. */
const SCHEDULE_LOOKAHEAD_SECONDS = 1.5;
/** How often the scheduler wakes up to top up the lookahead window. */
const SCHEDULER_INTERVAL_MS = 250;
/** A cycle boundary closer than this is skipped rather than scheduled late. */
const MIN_CYCLE_LEAD_SECONDS = 0.02;
/** Overdubs start at the first loop point at least this far in the future. */
const OVERDUB_QUANTIZE_LEAD_SECONDS = 0.05;

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
  /** Length of one loop cycle in seconds, or null before the first take exists. */
  loopSeconds: number | null;
  /** True while an overdub is armed but has not reached the loop point yet. */
  waitingForLoopPoint: boolean;
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
  /** Segments scheduled on the audio clock, with the frame each one starts at. */
  private scheduled: Array<{ node: AudioBufferSourceNode; startFrame: number }> = [];
  private bufferCache = new WeakMap<Layer, AudioBuffer>();
  private loopLengthFrames = 0;
  private loopAnchorFrame = 0;
  private nextCycleFrame = 0;
  private schedulerTimer: number | null = null;
  private waitingForLoopPoint = false;
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
      loopSeconds: null,
      waitingForLoopPoint: false,
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
        if (this.layers.length === 0) {
          this.stopLoop();
        } else {
          // The current cycle keeps playing; the removed layer simply does not come back.
          this.rescheduleLoop();
        }
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
    this.stopLoop();
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
    // The first take *is* the loop: its length defines the cycle, and because it was
    // recorded as the only layer there is nothing to align it against, so shift 0.
    this.layers.push({
      id: this.nextLayerId++,
      samples: take.samples,
      originFrame: take.originFrame,
      shiftFrames: 0,
    });
    this.loopLengthFrames = take.samples.length;
    this.startLoop();
    this.setState(this.layers.length >= MAX_LAYERS ? 'FULL' : 'IDLE', { message: null });
  }

  private async beginOverdubPass(): Promise<void> {
    const recorder = this.requireRecorder();
    // The loop is already running, so the overdub has to enter at a loop point, not
    // wherever the finger landed. Everything before that is pre-roll and is trimmed away
    // when the take is committed.
    const passOriginFrame = this.nextCycleBoundaryFrame(OVERDUB_QUANTIZE_LEAD_SECONDS);
    await recorder.arm();
    this.passOriginFrame = passOriginFrame;
    this.waitingForLoopPoint = Math.round(this.requireCtx().currentTime * this.requireCtx().sampleRate) < passOriginFrame;
    this.setState('OVERDUBBING', {
      overdubIndex: this.layers.length,
      waitingForLoopPoint: this.waitingForLoopPoint,
      message: null,
    });
    void this.requestWakeLock();
  }

  private async commitOverdub(): Promise<void> {
    const take = await this.requireRecorder().disarm();
    this.releaseWakeLock();
    this.waitingForLoopPoint = false;
    // Everything captured before the loop point belongs to the previous cycle.
    const aligned = this.trimToPassOrigin(take);
    if (!this.isTakeUsable(aligned.samples.length)) {
      this.abortPass();
      this.patch({ message: 'Take too short — nothing recorded' });
      return;
    }

    // Sample 0 is now the loop point, so the whole compensation is the round trip.
    // The performer plays in time with the monitor, which they hear delayed by output
    // latency, and their performance is captured delayed again by input latency. The
    // measured round trip is exactly output + input, so pulling the new layer earlier by
    // that much lines it up with the loop as the performer heard it.
    let shiftFrames = -this.latencyFrames();
    if (shiftFrames < -aligned.samples.length) {
      console.warn(
        `[loop-recorder] latency shift (${shiftFrames} frames) exceeds take length (${aligned.samples.length}); clamping`,
      );
      shiftFrames = -aligned.samples.length;
    }
    this.layers.push({
      id: this.nextLayerId++,
      samples: aligned.samples,
      originFrame: aligned.originFrame,
      shiftFrames,
    });
    // Cycles already scheduled do not know about the new layer; rebuild the ones that
    // have not sounded yet so the layer joins at the very next loop point.
    this.rescheduleLoop();
    this.setState(this.layers.length >= MAX_LAYERS ? 'FULL' : 'IDLE', { message: null });
  }

  /**
   * Drops the pre-roll captured before the loop point, so sample 0 of the take lines up
   * with musical position 0 of the cycle.
   */
  private trimToPassOrigin(take: MicTake): MicTake {
    const cut = Math.max(0, Math.min(take.samples.length, this.passOriginFrame - take.originFrame));
    if (cut === 0) return take;
    return { samples: take.samples.slice(cut), originFrame: take.originFrame + cut };
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
    // The loop keeps running: cancelling an overdub should not take the backing loop away.
    this.waitingForLoopPoint = false;
    this.releaseWakeLock();
    const current = this.state.get().state;
    this.setState(current === 'FULL' ? 'FULL' : 'IDLE', { overdubIndex: 0, waitingForLoopPoint: false });
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

  // ------------------------------------------------------- loop playback

  /**
   * The loop is the first take: its length defines the cycle. Cycles are scheduled ahead
   * of time as individual AudioBufferSourceNodes confined to their own cycle, so nothing
   * drifts and no source can bleed into the next cycle.
   */
  private startLoop(): void {
    const ctx = this.requireCtx();
    this.loopAnchorFrame = Math.round((ctx.currentTime + LOOP_START_LEAD_SECONDS) * ctx.sampleRate);
    this.nextCycleFrame = this.loopAnchorFrame;
    this.scheduleHorizon();
    if (this.schedulerTimer === null) {
      // This interval only *triggers* scheduling. Every audible time comes from the
      // AudioContext clock via source.start(when, ...) — never from a timer.
      this.schedulerTimer = window.setInterval(() => this.scheduleHorizon(), SCHEDULER_INTERVAL_MS);
    }
  }

  private stopLoop(): void {
    if (this.schedulerTimer !== null) {
      window.clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    this.stopAllSources();
    this.loopLengthFrames = 0;
    this.loopAnchorFrame = 0;
    this.nextCycleFrame = 0;
  }

  private scheduleHorizon(): void {
    const ctx = this.ctx;
    if (!ctx || this.loopLengthFrames <= 0 || this.layers.length === 0) return;
    const sampleRate = ctx.sampleRate;
    const horizon = Math.round((ctx.currentTime + SCHEDULE_LOOKAHEAD_SECONDS) * sampleRate);
    const minLead = Math.round((ctx.currentTime + MIN_CYCLE_LEAD_SECONDS) * sampleRate);
    // Skipping a whole cycle keeps the phase locked to the loop anchor.
    while (this.nextCycleFrame < minLead) this.nextCycleFrame += this.loopLengthFrames;

    let guard = 0;
    while (this.nextCycleFrame < horizon && guard++ < 64) {
      this.scheduleCycle(this.nextCycleFrame);
      this.nextCycleFrame += this.loopLengthFrames;
    }
  }

  private scheduleCycle(cycleFrame: number): void {
    const ctx = this.requireCtx();
    const master = this.requireMaster();
    const sampleRate = ctx.sampleRate;
    const loopFrames = this.loopLengthFrames;

    for (const layer of this.layers) {
      const takeFrames = layer.samples.length;
      // Musical position j inside the cycle maps to take sample index j - shiftFrames.
      // A negative shift (the usual case) therefore skips the take's head, which is
      // capture that belongs *before* the loop point. A positive shift pads silence.
      const startIndex = Math.max(0, -layer.shiftFrames);
      const startDelay = Math.max(0, layer.shiftFrames);
      const frames = Math.min(takeFrames - startIndex, loopFrames - startDelay);
      if (frames <= 0) continue;

      const source = ctx.createBufferSource();
      source.buffer = this.bufferFor(layer);
      source.connect(master);
      // `duration` confines this segment to its own cycle: anything past the loop point
      // belongs to the next cycle, which schedules itself.
      source.start((cycleFrame + startDelay) / sampleRate, startIndex / sampleRate, frames / sampleRate);
      this.scheduled.push({ node: source, startFrame: cycleFrame + startDelay });
    }
  }

  private bufferFor(layer: Layer): AudioBuffer {
    const cached = this.bufferCache.get(layer);
    if (cached) return cached;
    const ctx = this.requireCtx();
    const buffer = ctx.createBuffer(1, Math.max(1, layer.samples.length), ctx.sampleRate);
    buffer.copyToChannel(layer.samples, 0);
    this.bufferCache.set(layer, buffer);
    return buffer;
  }

  /** Frame of the first cycle boundary at least `leadSeconds` in the future. */
  private nextCycleBoundaryFrame(leadSeconds: number): number {
    const ctx = this.requireCtx();
    const earliest = Math.round((ctx.currentTime + leadSeconds) * ctx.sampleRate);
    if (this.loopLengthFrames <= 0) return earliest;
    const cycles = Math.ceil((earliest - this.loopAnchorFrame) / this.loopLengthFrames);
    return this.loopAnchorFrame + cycles * this.loopLengthFrames;
  }

  /** Drops segments that have not started yet so future cycles can be rebuilt. */
  private cancelFutureSources(): number | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    const threshold = Math.round((ctx.currentTime + 0.002) * ctx.sampleRate);
    let earliest: number | null = null;
    const keep: typeof this.scheduled = [];
    for (const entry of this.scheduled) {
      if (entry.startFrame > threshold) {
        try {
          entry.node.stop();
          entry.node.disconnect();
        } catch {
          /* already gone */
        }
        if (earliest === null || entry.startFrame < earliest) earliest = entry.startFrame;
      } else {
        keep.push(entry);
      }
    }
    this.scheduled = keep;
    return earliest;
  }

  /** Rebuilds the not-yet-audible part of the loop after the layer set changed. */
  private rescheduleLoop(): void {
    const earliest = this.cancelFutureSources();
    if (earliest !== null) this.nextCycleFrame = Math.min(this.nextCycleFrame, earliest);
    // Always top the horizon back up: this call also covers the case where the scheduler
    // interval has been throttled (background tab) and no cycle is booked ahead yet.
    this.scheduleHorizon();
  }

  private stopAllSources(): void {
    for (const entry of this.scheduled) {
      try {
        entry.node.stop();
      } catch {
        /* already stopped */
      }
      try {
        entry.node.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.scheduled = [];
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

      // Tell the UI when the quantised overdub actually lands on the loop point.
      const ctx = this.ctx;
      if (this.waitingForLoopPoint && ctx && Math.round(ctx.currentTime * ctx.sampleRate) >= this.passOriginFrame) {
        this.waitingForLoopPoint = false;
        this.patch({ waitingForLoopPoint: false });
      }
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
      loopSeconds: this.loopSeconds(),
      ...patch,
    });
  }

  private loopSeconds(): number | null {
    const sampleRate = this.ctx?.sampleRate ?? null;
    if (this.loopLengthFrames <= 0 || sampleRate === null) return null;
    return this.loopLengthFrames / sampleRate;
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
      loopSeconds: this.loopSeconds(),
    });
  }
}
