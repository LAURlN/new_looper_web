/** Small hand-rolled DSP helpers. Deliberately dependency-free: direct O(N*M) maths. */

export interface CorrelationResult {
  /** Offset inside the search window where the template best matches. */
  index: number;
  /** Normalised peak in [0, 1]. Low values mean "no reliable match". */
  peak: number;
}

/**
 * Mono float samples backed by a plain ArrayBuffer — what Web Audio APIs accept
 * (`copyToChannel`, `getFloatTimeDomainData`). The default `Float32Array` alias is
 * parameterised on `ArrayBufferLike`, which those APIs reject, so stored buffers use
 * this alias while the read-only DSP helpers stay permissive.
 */
export type MonoBuffer = Float32Array<ArrayBuffer>;

export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

export function peakAmplitude(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = Math.abs(samples[i]);
    if (value > peak) peak = value;
  }
  return peak;
}

/** Scales a copy of `samples` so its loudest sample equals `target`. */
export function normalizeToPeak(samples: Float32Array, target = 0.9): MonoBuffer {
  const peak = peakAmplitude(samples);
  const out = new Float32Array(samples.length);
  if (peak === 0) return out;
  const gain = target / peak;
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * gain;
  return out;
}

/**
 * Normalised cross-correlation: slides `template` across `search` and returns the
 * offset with the highest correlation coefficient.
 *
 * Direct O(N*M) — a few million multiply-adds for a 1k-sample template inside a
 * 26k-sample window, which is fine on a phone and keeps this readable.
 */
export function crossCorrelateMax(search: Float32Array, template: Float32Array): CorrelationResult {
  const n = template.length;
  if (n === 0 || search.length < n) return { index: 0, peak: 0 };

  let templateEnergy = 0;
  for (let i = 0; i < n; i++) templateEnergy += template[i] * template[i];
  if (templateEnergy <= 0) return { index: 0, peak: 0 };

  const prefix = new Float64Array(search.length + 1);
  for (let i = 0; i < search.length; i++) prefix[i + 1] = prefix[i] + search[i] * search[i];

  const candidates = search.length - n + 1;
  let bestIndex = 0;
  let bestPeak = 0;
  for (let lag = 0; lag < candidates; lag++) {
    let dot = 0;
    for (let i = 0; i < n; i++) dot += search[lag + i] * template[i];
    const windowEnergy = prefix[lag + n] - prefix[lag];
    const denom = Math.sqrt(windowEnergy * templateEnergy);
    const score = denom > 0 ? dot / denom : 0;
    if (score > bestPeak) {
      bestPeak = score;
      bestIndex = lag;
    }
  }
  return { index: bestIndex, peak: bestPeak };
}

export interface OnsetOptions {
  sampleRate: number;
  /** Envelope window used to integrate energy, in ms. */
  windowMs?: number;
  /** Fraction of the loudest envelope value that counts as "sound started". */
  thresholdRatio?: number;
  /** Absolute floor so silence never reports an onset. */
  noiseFloor?: number;
}

/**
 * Crude onset detector: first sample where a short trailing-RMS envelope crosses a
 * fraction of its own maximum. Used as a sanity check alongside cross-correlation.
 * Returns -1 when nothing crosses the floor.
 */
export function detectOnset(samples: Float32Array, options: OnsetOptions): number {
  const { sampleRate } = options;
  const windowMs = options.windowMs ?? 3;
  const thresholdRatio = options.thresholdRatio ?? 0.35;
  const noiseFloor = options.noiseFloor ?? 0.005;
  const window = Math.max(1, Math.round((sampleRate * windowMs) / 1000));
  if (samples.length === 0) return -1;

  const prefix = new Float64Array(samples.length + 1);
  for (let i = 0; i < samples.length; i++) prefix[i + 1] = prefix[i] + samples[i] * samples[i];

  const envelope = (endExclusive: number): number => {
    const start = Math.max(0, endExclusive - window);
    const count = endExclusive - start;
    if (count <= 0) return 0;
    return Math.sqrt((prefix[endExclusive] - prefix[start]) / count);
  };

  let max = 0;
  for (let i = 1; i <= samples.length; i++) {
    const value = envelope(i);
    if (value > max) max = value;
  }
  if (max < noiseFloor) return -1;

  const threshold = Math.max(noiseFloor, max * thresholdRatio);
  for (let i = 1; i <= samples.length; i++) {
    if (envelope(i) >= threshold) return i - 1;
  }
  return -1;
}
