/**
 * Room naming and the shareable invite link.
 *
 * The room id lives in the URL **fragment** (`#room=…`) on purpose: browsers do
 * not send the fragment to the server, so it cannot leak through server logs or
 * a `Referer` header the way a query string would. `history.replaceState` is
 * used so that generating or clearing a room never reloads the page or adds
 * history entries.
 */

const ROOM_PARAM = 'room';
/** Crockford-style alphabet: no I/L/O/U, so ids survive being read aloud or typed. */
const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const ROOM_LENGTH = 16;

export function generateRoomId(): string {
  const bytes = new Uint8Array(ROOM_LENGTH);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < ROOM_LENGTH; i++) out += ROOM_ALPHABET[bytes[i] % ROOM_ALPHABET.length];
  return out;
}

/** Strips anything that is not a room-character and normalises case. */
export function normalizeRoomId(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, ROOM_LENGTH);
}

function hashParams(): URLSearchParams {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  return new URLSearchParams(hash);
}

export function readRoomId(): string | null {
  try {
    const value = hashParams().get(ROOM_PARAM);
    if (!value) return null;
    const normalized = normalizeRoomId(value);
    return normalized.length > 0 ? normalized : null;
  } catch {
    return null;
  }
}

function writeRoomId(roomId: string | null): void {
  try {
    const params = hashParams();
    if (roomId) params.set(ROOM_PARAM, roomId);
    else params.delete(ROOM_PARAM);
    const next = params.toString();
    history.replaceState(null, '', `${location.pathname}${location.search}${next ? `#${next}` : ''}`);
  } catch {
    /* history unavailable — the room still works for this session */
  }
}

export function setRoomId(roomId: string): void {
  writeRoomId(roomId);
}

export function clearRoomId(): void {
  writeRoomId(null);
}

/** The whole invite: just this URL. No accounts, no emails, no backend invites. */
export function buildShareUrl(roomId: string): string {
  const { origin, pathname, search } = location;
  const params = new URLSearchParams({ [ROOM_PARAM]: roomId });
  return `${origin}${pathname}${search}#${params.toString()}`;
}
