import {
  DIFFICULTY_EASY_CENTER,
  DIFFICULTY_HALF_WIDTH,
  DIFFICULTY_HARD_CENTER,
  DIFFICULTY_MIN_CANDIDATES,
} from '../config.js';

/** @typedef {import('./types.js').Song} Song */
/** @typedef {import('../core/rng.js').Rng} Rng */

const BAND_GROWTH = 1.5;
const MAX_BAND = 100;

/**
 * Difficulty in [0, 1] for a floor: 0 on floor 1, 1 on the last playable floor.
 * @param {number} floor
 * @param {number} totalFloors  Floor number that ends the run.
 * @returns {number}
 */
export function floorDifficulty(floor, totalFloors) {
  const lastPlayable = totalFloors - 1;
  if (lastPlayable <= 1) return 0;
  return Math.min(1, Math.max(0, (floor - 1) / (lastPlayable - 1)));
}

/**
 * Guess rate (0-100) the song picker aims for at a given difficulty.
 * @param {number} difficulty
 * @returns {number}
 */
export function targetGuessRate(difficulty) {
  return DIFFICULTY_EASY_CENTER + (DIFFICULTY_HARD_CENTER - DIFFICULTY_EASY_CENTER) * difficulty;
}

/**
 * Picks a song close to the target guess rate, preferring songs the player has not heard.
 * The acceptance band widens until enough candidates exist.
 * @param {object} options
 * @param {Rng} options.rng
 * @param {Song[]} options.candidates
 * @param {number} options.difficulty
 * @param {Set<number>} [options.excludeIds]
 * @returns {Song | null}
 */
export function pickSong({ rng, candidates, difficulty, excludeIds = new Set() }) {
  const fresh = candidates.filter((song) => !excludeIds.has(song.id));
  const pool = fresh.length > 0 ? fresh : candidates;
  if (pool.length === 0) return null;

  const target = targetGuessRate(difficulty);
  for (let width = DIFFICULTY_HALF_WIDTH; width < MAX_BAND; width *= BAND_GROWTH) {
    const inBand = pool.filter((song) => Math.abs(song.guessRate - target) <= width);
    if (inBand.length >= DIFFICULTY_MIN_CANDIDATES) return rng.pick(inBand);
  }
  return rng.pick(pool);
}
