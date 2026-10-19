/**
 * Seedable pseudo-random number generation. Game logic must use these instead of Math.random()
 * so floors are reproducible from a seed.
 */

/**
 * Hashes a string into a 32-bit unsigned integer (FNV-1a).
 * @param {string} text
 * @returns {number}
 */
export function hashString(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * @typedef {object} Rng
 * @property {() => number} next        Float in [0, 1).
 * @property {(min: number, max: number) => number} int  Integer in [min, max].
 * @property {<T>(items: T[]) => T} pick
 * @property {<T>(items: T[]) => T[]} shuffle  Returns a shuffled copy.
 */

/**
 * Creates a deterministic generator (mulberry32).
 * @param {number | string} seed
 * @returns {Rng}
 */
export function createRng(seed) {
  let state = typeof seed === 'string' ? hashString(seed) : seed >>> 0;

  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const int = (min, max) => min + Math.floor(next() * (max - min + 1));

  const pick = (items) => items[Math.floor(next() * items.length)];

  const shuffle = (items) => {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };

  return { next, int, pick, shuffle };
}

/**
 * Creates a non-deterministic generator for places that do not need reproducibility.
 * @returns {Rng}
 */
export function createRandomRng() {
  return createRng(Math.floor(Math.random() * 2 ** 32));
}
