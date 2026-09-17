/**
 * Round-trip latency calibration.
 *
 * Plays three short broadband transients out of the speaker and looks for them in the
 * *recorded* mic signal. The delay between "scheduled on the AudioContext clock" and
 * "found in the recording" is exactly output latency + acoustic flight + input latency,
 * which is the number overdub alignment needs.
 */
import { crossCorrelateMax, detectOnset, normalizeToPeak, type MonoBuffer } from './dsp';
import type { MicRecorder } from './mic';

export interface CalibrationRecord {
  roundTripMs: number;
  sampleRate: number;
  measuredAt: number;
}

export const CALIBRATION_KEY = 'looprecorder.calibration';

const PROBE_SPACING_MS = 600;
const PROBE_LEAD_SECONDS = 0.15;
const TAIL_WAIT_MS = 500;
const SEARCH_BACK_SECONDS = 0.05;
const SEARCH_FORWARD_SECONDS = 0.5;
const MIN_PEAK = 0.3;
/** A marginal correlation is still usable if the onset detector agrees with it. */
const MIN_PEAK_WITH_ONSET_AGREEMENT = 0.15;
const ONSET_AGREEMENT_MS = 20;
const OUTLIER_MS = 30;
const MIN_LATENCY_MS = 0;
const MAX_LATENCY_MS = 400;

export interface CalibrationProbe {
  kind: 'impulse' | 'noise' | 'chirp';
  /** null when the probe could not be located. */
  lagMs: number | null;
  peak: number;
  accepted: boolean;
  note?: string;
}

export interface CalibrationResult {
  ok: boolean;
  roundTripMs?: number;
  probes: CalibrationProbe[];
  message: string;
}

export interface CalibrationIO {
  ctx: AudioContext;
  /** Monitoring bus: every probe is played through here. */
  output: AudioNode;
  recorder: MicRecorder;
  onStatus?: (status: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Short raised-cosine fade at both edges: kills clicks/DC without softening the onset. */
function applyEdgeFade(samples: Float32Array, fade: number): Float32Array {
  const count = Math.max(0, Math.min(fade, Math.floor(samples.length / 4)));
  for (let i = 0; i < count; i++) {
    const gain = 0.5 - 0.5 * Math.cos((Math.PI * i) / count);
    samples[i] *= gain;
    samples[samples.length - 1 - i] *= gain;
  }
  return samples;
}

function hannWindow(samples: Float32Array): Float32Array {
  const n = samples.length;
  for (let i = 0; i < n; i++) samples[i] *= 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return samples;
}

/**
 * 2 ms full-scale bipolar impulse. Alternating polarity keeps it DC-free (a windowed
 * one-sided impulse carries a DC step that smears the correlation peak).
 */
export function buildImpulseProbe(sampleRate: number): MonoBuffer {
  const length = Math.max(8, Math.round(0.002 * sampleRate));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = i % 2 === 0 ? 1 : -1;
  return normalizeToPeak(applyEdgeFade(out, Math.max(2, Math.round(length / 8))), 0.9);
}

/** 30 ms Hann-windowed white noise burst. */
export function buildNoiseProbe(sampleRate: number): MonoBuffer {
  const length = Math.max(32, Math.round(0.03 * sampleRate));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = Math.random() * 2 - 1;
  return normalizeToPeak(hannWindow(out), 0.9);
}

/** 20 ms linear chirp 500 Hz -> 4 kHz, Hann-windowed. */
export function buildChirpProbe(sampleRate: number, f0 = 500, f1 = 4000): MonoBuffer {
  const length = Math.max(32, Math.round(0.02 * sampleRate));
  const duration = length / sampleRate;
  const sweep = (f1 - f0) / duration;
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    out[i] = Math.sin(2 * Math.PI * (f0 * t + 0.5 * sweep * t * t));
  }
  return normalizeToPeak(hannWindow(out), 0.9);
}

export function loadCalibration(): CalibrationRecord | null {
  try {
    const raw = localStorage.getItem(CALIBRATION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CalibrationRecord>;
    if (typeof parsed.roundTripMs !== 'number' || !Number.isFinite(parsed.roundTripMs)) return null;
    if (typeof parsed.sampleRate !== 'number' || !Number.isFinite(parsed.sampleRate)) return null;
    return {
      roundTripMs: parsed.roundTripMs,
      sampleRate: parsed.sampleRate,
      measuredAt: typeof parsed.measuredAt === 'number' ? parsed.measuredAt : 0,
    };
  } catch {
    return null;
  }
}

export function saveCalibration(record: CalibrationRecord): void {
  try {
    localStorage.setItem(CALIBRATION_KEY, JSON.stringify(record));
  } catch {
    /* private mode / quota — calibration simply will not persist */
  }
}

export function clearStoredCalibration(): void {
  try {
    localStorage.removeItem(CALIBRATION_KEY);
  } catch {
    /* ignore */
  }
}

/** A stored measurement is only valid for the sample rate it was taken at. */
export function isCalibrationUsable(
  record: CalibrationRecord | null,
  sampleRate: number | null,
): record is CalibrationRecord {
  if (!record) return false;
  if (sampleRate === null) return true;
  return Math.abs(record.sampleRate - sampleRate) < 1;
}

/**
 * Robust combination of the per-probe lags: median as the reference, drop anything more
 * than `OUTLIER_MS` away from it, then average the survivors.
 */
export function combineLags(lagsMs: number[], outlierMs = OUTLIER_MS): number | null {
  if (lagsMs.length === 0) return null;
  const sorted = [...lagsMs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const survivors = sorted.filter((lag) => Math.abs(lag - median) <= outlierMs);
  if (survivors.length === 0) return median;
  const sum = survivors.reduce((acc, lag) => acc + lag, 0);
  return sum / survivors.length;
}

interface ScheduledProbe {
  kind: CalibrationProbe['kind'];
  samples: MonoBuffer;
  scheduledFrame: number;
}

export interface ProbeLagArgs {
  /** Slice of the recording that should contain the echo. */
  window: Float32Array;
  /** The known probe waveform. */
  template: Float32Array;
  /** Absolute AudioContext frame of `window[0]`. */
  windowStartFrame: number;
  /** Absolute frame the probe was scheduled to start at. */
  scheduledFrame: number;
  sampleRate: number;
}

export type ProbeLagEstimate = Omit<CalibrationProbe, 'kind'>;

/** Locates one probe inside the recording slice and converts the match to a lag. */
export function estimateProbeLag(args: ProbeLagArgs): ProbeLagEstimate {
  const { window, template, windowStartFrame, scheduledFrame, sampleRate } = args;
  const { index, peak } = crossCorrelateMax(window, template);
  const lagMs = ((windowStartFrame + index - scheduledFrame) / sampleRate) * 1000;

  let accepted = peak >= MIN_PEAK;
  let note: string | undefined;
  if (!accepted && peak >= MIN_PEAK_WITH_ONSET_AGREEMENT) {
    const onset = detectOnset(window, { sampleRate });
    if (onset >= 0) {
      const onsetLagMs = ((windowStartFrame + onset - scheduledFrame) / sampleRate) * 1000;
      if (Math.abs(onsetLagMs - lagMs) <= ONSET_AGREEMENT_MS) {
        accepted = true;
        note = 'weak but agreed with onset detector';
      }
    }
  }
  if (!accepted) note = note ?? 'correlation too weak';
  return { lagMs, peak, accepted, note };
}

export async function calibrate(io: CalibrationIO): Promise<CalibrationResult> {
  const { ctx, output, recorder, onStatus } = io;
  const sampleRate = ctx.sampleRate;
  const probes: ScheduledProbe[] = [
    { kind: 'impulse', samples: buildImpulseProbe(sampleRate), scheduledFrame: 0 },
    { kind: 'noise', samples: buildNoiseProbe(sampleRate), scheduledFrame: 0 },
    { kind: 'chirp', samples: buildChirpProbe(sampleRate), scheduledFrame: 0 },
  ];

  if (ctx.state !== 'running') await ctx.resume();

  onStatus?.('Arming microphone…');
  try {
    await recorder.arm();
  } catch (error) {
    return {
      ok: false,
      probes: probes.map((probe) => ({ kind: probe.kind, lagMs: null, peak: 0, accepted: false })),
      message: error instanceof Error ? error.message : 'Could not arm the recorder',
    };
  }

  for (let index = 0; index < probes.length; index++) {
    const probe = probes[index];
    onStatus?.(`Playing test sound ${index + 1} of ${probes.length}…`);
    const buffer = ctx.createBuffer(1, probe.samples.length, sampleRate);
    buffer.copyToChannel(probe.samples, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(output);
    const startTime = ctx.currentTime + PROBE_LEAD_SECONDS;
    source.start(startTime);
    probe.scheduledFrame = Math.round(startTime * sampleRate);
    await sleep(PROBE_SPACING_MS);
    try {
      source.disconnect();
    } catch {
      /* already finished */
    }
  }

  onStatus?.('Listening for the echoes…');
  // The echo of the last probe can arrive up to MAX_LATENCY_MS later.
  await sleep(TAIL_WAIT_MS);

  const take = await recorder.disarm();
  if (take.samples.length === 0) {
    return {
      ok: false,
      probes: probes.map((probe) => ({ kind: probe.kind, lagMs: null, peak: 0, accepted: false })),
      message: 'The microphone recorded nothing — check the mic and try again',
    };
  }

  const reports: CalibrationProbe[] = [];
  const acceptedLags: number[] = [];

  for (const probe of probes) {
    const windowStart = Math.max(
      0,
      Math.round(probe.scheduledFrame - SEARCH_BACK_SECONDS * sampleRate - take.originFrame),
    );
    const windowEnd = Math.min(
      take.samples.length,
      Math.round(probe.scheduledFrame + SEARCH_FORWARD_SECONDS * sampleRate - take.originFrame),
    );
    if (windowEnd - windowStart < probe.samples.length + 1) {
      reports.push({ kind: probe.kind, lagMs: null, peak: 0, accepted: false, note: 'window too small' });
      continue;
    }

    const estimate = estimateProbeLag({
      window: take.samples.subarray(windowStart, windowEnd),
      template: probe.samples,
      windowStartFrame: windowStart + take.originFrame,
      scheduledFrame: probe.scheduledFrame,
      sampleRate,
    });
    if (estimate.accepted && estimate.lagMs !== null) acceptedLags.push(estimate.lagMs);
    reports.push({ ...estimate, kind: probe.kind });
  }

  if (acceptedLags.length === 0) {
    return { ok: false, probes: reports, message: 'No reliable echo found — try again with the phone on a hard surface' };
  }

  const combined = combineLags(acceptedLags);
  if (combined === null || combined < MIN_LATENCY_MS || combined > MAX_LATENCY_MS) {
    return {
      ok: false,
      probes: reports,
      message: `Measured latency out of range (${combined === null ? 'n/a' : Math.round(combined)} ms) — keeping the previous calibration`,
    };
  }

  return {
    ok: true,
    roundTripMs: combined,
    probes: reports,
    message: `Round-trip latency ${Math.round(combined)} ms from ${acceptedLags.length}/${probes.length} probes`,
  };
}
