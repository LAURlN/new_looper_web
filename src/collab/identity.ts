/**
 * Anonymous, zero-cost identity.
 *
 * There is no sign-up and no server. A stable random id plus a friendly display
 * name are generated on first launch and kept in localStorage. The id is what
 * clip authorship is recorded against, so it must survive reloads — otherwise
 * reloading the page would make you a stranger to your own clips (and "undo my
 * last clip" would stop working).
 */

export interface PeerIdentity {
  id: string;
  name: string;
  color: string;
}

const STORAGE_KEY = 'looprecorder.identity';

const ADJECTIVES = [
  'Amber', 'Brisk', 'Cosmic', 'Drifting', 'Electric', 'Golden', 'Hollow', 'Ivory',
  'Lunar', 'Mellow', 'Neon', 'Ocean', 'Quiet', 'Rusty', 'Silver', 'Velvet',
];

const NOUNS = [
  'Badger', 'Comet', 'Dune', 'Ember', 'Finch', 'Glacier', 'Heron', 'Ion',
  'Juniper', 'Kestrel', 'Lantern', 'Mirage', 'Nimbus', 'Orbit', 'Pixel', 'Quartz',
];

const COLORS = ['#4da3ff', '#ffb020', '#ff3b30', '#48d597', '#c084fc', '#f472b6', '#38bdf8', '#facc15'];

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

/** Random lowercase hex string. Falls back to Math.random outside secure contexts. */
export function randomId(bytes = 16): string {
  const out = new Uint8Array(bytes);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(out);
  } else {
    for (let i = 0; i < out.length; i++) out[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(out, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** RFC4122-ish v4 id, with a fallback for browsers/contexts without randomUUID. */
export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const hex = randomId(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function generate(): PeerIdentity {
  return {
    id: randomId(16),
    name: `${pick(ADJECTIVES)} ${pick(NOUNS)}`,
    color: pick(COLORS),
  };
}

export function saveIdentity(identity: PeerIdentity): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  } catch {
    /* private mode / quota — identity simply will not persist */
  }
}

export function loadIdentity(): PeerIdentity {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PeerIdentity>;
      if (typeof parsed.id === 'string' && parsed.id.length >= 8) {
        const fallback = generate();
        return {
          id: parsed.id,
          name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name : fallback.name,
          color: typeof parsed.color === 'string' && parsed.color.trim() ? parsed.color : fallback.color,
        };
      }
    }
  } catch {
    /* malformed or unavailable — regenerate below */
  }
  const identity = generate();
  saveIdentity(identity);
  return identity;
}
