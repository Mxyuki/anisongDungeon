/**
 * Text helpers: normalization and fuzzy comparison for answer checking and search.
 */

/**
 * Letters that do not decompose to a-z (checked after NFKD and accent stripping), mapped to the
 * Latin letters a player would type instead. Built from every character found in the song
 * library; uppercase keys exist only where the capital looks different (Δ like A, δ like d).
 * Anything else that is not a-z / 0-9 becomes a space.
 */
const LETTER_FOLDS = Object.freeze({
  Δ: 'a', δ: 'd', Λ: 'a', λ: 'a', α: 'a', β: 'b', γ: 'y', ε: 'e', ζ: 'z', θ: 'o', ι: 'i',
  μ: 'u', ο: 'o', ρ: 'p', ς: 'c', σ: 'o', υ: 'u', φ: 'o', ψ: 'y', Ω: 'o', ω: 'w', ϛ: 's',
  я: 'r', ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', ð: 'd', đ: 'd', þ: 'p', ł: 'l', ı: 'i', ħ: 'h',
  ə: 'e', ǝ: 'e', ɪ: 'i', ᴜ: 'u', ↄ: 'c', ƶ: 'z', 〇: 'o',
});
const PLAIN_CHAR = /^[a-z0-9]$/;
const MARKS = /\p{M}/gu;
/** @type {Map<string, string>} */
const foldCache = new Map();

/**
 * What one character becomes in normalized text: a-z / 0-9 letters, or a space.
 * @param {string} char  One code point.
 * @returns {string}
 */
function foldChar(char) {
  let folded = foldCache.get(char);
  if (folded !== undefined) return folded;
  folded = '';
  for (const part of char.normalize('NFKD').replace(MARKS, '')) {
    const mapped = LETTER_FOLDS[part] ?? LETTER_FOLDS[part.toLowerCase()]
      ?? part.toLowerCase().replace(MARKS, '');
    for (const out of mapped) folded += PLAIN_CHAR.test(out) ? out : ' ';
  }
  foldCache.set(char, folded);
  return folded;
}

/**
 * Normalizes text and records, for each normalized character, the index of the original
 * character it came from (used to highlight a match inside the original text).
 * @param {string} text
 * @returns {{ text: string, map: number[] }}
 */
export function normalizeWithMap(text) {
  const source = String(text ?? '');
  let result = '';
  const map = [];
  let index = 0;
  for (const char of source) {
    for (const out of foldChar(char)) {
      // Collapse runs of spaces and drop leading ones.
      if (out === ' ' && (result === '' || result.endsWith(' '))) continue;
      result += out;
      map.push(index);
    }
    index += char.length;
  }
  if (result.endsWith(' ')) {
    result = result.slice(0, -1);
    map.pop();
  }
  return { text: result, map };
}

/**
 * Lowercases, strips accents, folds look-alike letters (é → e, ø → o, μ → u) and turns every
 * other symbol into a space, so "Shingeki no Kyojin: Season 2!" and "shingeki no kyojin
 * season 2" compare equal.
 * @param {string} text
 * @returns {string}
 */
export function normalizeText(text) {
  return normalizeWithMap(text).text;
}

/**
 * Normalized text without spaces ("re zero" and "rezero" compare equal).
 * @param {string} normalized  Output of normalizeText().
 * @returns {string}
 */
export function compactText(normalized) {
  return normalized.replaceAll(' ', '');
}

/**
 * Levenshtein edit distance (two-row dynamic programming).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * Similarity in [0, 1], 1 meaning identical.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function similarity(a, b) {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - editDistance(a, b) / longest;
}

/**
 * Clamps a number into [min, max]; returns `fallback` when the value is not a finite number.
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
export function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/**
 * Trims a user-provided string and limits its length.
 * @param {unknown} value
 * @param {number} maxLength
 * @returns {string}
 */
export function cleanString(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}
