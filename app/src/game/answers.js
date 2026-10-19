import { ANSWER_FUZZY_MIN_LENGTH, ANSWER_SIMILARITY } from '../config.js';
import { compactText, normalizeText, similarity } from '../core/text.js';

/**
 * Builds the normalized, de-duplicated list of accepted answers. "&" is accepted both as a
 * space (like every symbol) and spelled "and".
 * @param {string[]} names
 * @returns {string[]}
 */
export function buildAnswerKeys(names) {
  const keys = new Set();
  for (const name of names) {
    for (const variant of [name, String(name ?? '').replaceAll('&', ' and ')]) {
      const key = normalizeText(variant);
      if (key) keys.add(key);
    }
  }
  return [...keys];
}

/** Exact match, ignoring spaces ("rezero" for "Re:Zero"). */
function matchesExactly(normalized, answerKeys) {
  if (answerKeys.includes(normalized)) return true;
  const compact = compactText(normalized);
  return answerKeys.some((key) => compactText(key) === compact);
}

const numbersOf = (text) => (text.match(/\d+/g) ?? []).join(' ');

/**
 * Checks a guess against accepted answers. Exact (normalized) matches always pass; longer
 * guesses also pass with small typos.
 * @param {string} guess
 * @param {string[]} answerKeys  Output of buildAnswerKeys().
 * @param {{ sameNumbers?: boolean }} [options]  sameNumbers: a typo may not change a number,
 *   so "Season 3" is no typo of "Season 2".
 * @returns {boolean}
 */
export function isCorrectAnswer(guess, answerKeys, { sameNumbers = false } = {}) {
  const normalized = normalizeText(guess);
  if (!normalized) return false;
  if (matchesExactly(normalized, answerKeys)) return true;
  if (normalized.length < ANSWER_FUZZY_MIN_LENGTH) return false;
  const numbers = numbersOf(normalized);
  return answerKeys.some((key) => (!sameNumbers || numbersOf(key) === numbers)
    && similarity(normalized, key) >= ANSWER_SIMILARITY);
}

/**
 * Which of several answer lists a guess matches (e.g. which group member was named).
 * An exact match wins; otherwise the closest list within the typo tolerance, so "Singer B"
 * never counts as "Singer A".
 * @param {string} guess
 * @param {string[][]} answerKeyLists  One buildAnswerKeys() result per candidate.
 * @returns {number} Index of the matched list, or -1.
 */
export function findMatchingAnswer(guess, answerKeyLists) {
  const normalized = normalizeText(guess);
  if (!normalized) return -1;
  const exact = answerKeyLists.findIndex((keys) => matchesExactly(normalized, keys));
  if (exact >= 0 || normalized.length < ANSWER_FUZZY_MIN_LENGTH) return exact;
  let best = -1;
  let bestScore = ANSWER_SIMILARITY;
  answerKeyLists.forEach((keys, index) => {
    for (const key of keys) {
      const score = similarity(normalized, key);
      if (score >= bestScore) {
        best = index;
        bestScore = score;
      }
    }
  });
  return best;
}
