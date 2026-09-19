/**
 * Clip encoding and content addressing.
 *
 * The wire format is deliberately boring: 16-bit PCM inside a WAV container. It
 * is larger than Opus would be, but every browser that can decode audio at all
 * can decode it, which is exactly what "must work on iOS Safari" requires. It
 * is also trivially streamable from an `ArrayBuffer`, so no container parser is
 * needed on the receiving side.
 *
 * A useful consequence of using `AudioContext.decodeAudioData` for playback is
 * that it **resamples to the context's own sample rate automatically**. So a
 * clip recorded at 44.1 kHz on one phone plays correctly on a 48 kHz device
 * without a hand-written resampler — the browser does the resampling once, at
 * ingest.
 *
 * Opus is the natural future optimisation (roughly 8x smaller). It is
 * deliberately not wired up here: it needs a container the decoder understands
 * and its iOS support is version-dependent, so it belongs behind a capability
 * probe with this WAV path as the fallback. See `docs/multiplayer-architecture.md` §6.3.
 */
import type { ClipCodec } from './types';

export const DEFAULT_CODEC: ClipCodec = 'wav16';

const WAV_HEADER_BYTES = 44;

/** Encodes mono float samples as a PCM16 little-endian WAV file. */
export function encodeWav16(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const frames = samples.length;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + frames * 2);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + frames * 2, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // format = PCM
  view.setUint16(22, 1, true); // channels = mono
  view.setUint32(24, Math.round(sampleRate), true);
  view.setUint32(28, Math.round(sampleRate) * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, frames * 2, true);

  let offset = WAV_HEADER_BYTES;
  for (let i = 0; i < frames; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

/** Copies a decoded channel into a plain-ArrayBuffer-backed buffer. */
function toMono(channel: Float32Array): Float32Array<ArrayBuffer> {
  const out = new Float32Array(channel.length);
  out.set(channel);
  return out;
}

/**
 * Decodes encoded clip bytes for playback.
 *
 * The input is copied because `decodeAudioData` detaches (neuters) the buffer it
 * is given, and the stored blob is kept for re-seeding to other peers.
 */
export async function decodeClip(bytes: ArrayBuffer, ctx: AudioContext): Promise<Float32Array<ArrayBuffer>> {
  const decoded = await ctx.decodeAudioData(bytes.slice(0));
  if (decoded.numberOfChannels === 0 || decoded.length === 0) return new Float32Array(0);
  return toMono(decoded.getChannelData(0));
}

/** SHA-256 in hex: the blob's content address, and how a receiver verifies a transfer. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('SHA-256 unavailable — a secure context (https:// or localhost) is required');
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Short, human-facing hash for diagnostics. */
export function shortHash(hash: string): string {
  return hash.slice(0, 8);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
