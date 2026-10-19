import {
  DIFFICULTY_FIRST_FLOOR,
  DIFFICULTY_LAST_FLOOR,
  DIFFICULTY_LAST_FLOOR_IDEAL,
  DIFFICULTY_MAX_DRIFT,
  DIFFICULTY_MIN_CANDIDATES,
} from '../config.js';

/** @typedef {import('./types.js').Song} Song */

/**
 * Guess-rate band of a floor (% of players who know the song). Floor 1 uses
 * DIFFICULTY_FIRST_FLOOR, the last floor DIFFICULTY_LAST_FLOOR (or its IDEAL part when enough
 * songs fit), and the floors between move by equal steps.
 * @typedef {{ min: number, max: number, ideal: { min: number, max: number } | null }} Band
 */

/**
 * @param {number} floor
 * @param {number} floorCount  Floors played (the last one leads to the summit).
 * @returns {Band}
 */
export function floorBand(floor, floorCount) {
  const progress = floorCount <= 1 ? 0 : Math.min(1, Math.max(0, (floor - 1) / (floorCount - 1)));
  const lerp = (from, to) => from + (to - from) * progress;
  return {
    min: lerp(DIFFICULTY_FIRST_FLOOR.min, DIFFICULTY_LAST_FLOOR.min),
    max: lerp(DIFFICULTY_FIRST_FLOOR.max, DIFFICULTY_LAST_FLOOR.max),
    ideal: progress === 1 && floorCount > 1 ? DIFFICULTY_LAST_FLOOR_IDEAL : null,
  };
}

/**
 * How far a song's guess rate is outside a band (0 inside).
 * @param {Song} song
 * @param {{ min: number, max: number }} band
 * @returns {number}
 */
export function bandDistance(song, band) {
  if (song.guessRate < band.min) return band.min - song.guessRate;
  if (song.guessRate > band.max) return song.guessRate - band.max;
  return 0;
}

/**
 * The songs closest to a band: every song inside it, or (too few inside) the
 * DIFFICULTY_MIN_CANDIDATES nearest ones, ties included.
 */
function closest(songs, band) {
  if (songs.length === 0) return [];
  const sorted = [...songs].sort((a, b) => bandDistance(a, band) - bandDistance(b, band));
  const limit = bandDistance(sorted[Math.min(DIFFICULTY_MIN_CANDIDATES, sorted.length) - 1], band);
  return sorted.filter((song) => bandDistance(song, band) <= limit);
}

/**
 * Songs a tile of this floor may play, by difficulty first: the closest to the band, never a
 * random one. Among them, songs played the fewest times this game come first, unless that would
 * drift more than DIFFICULTY_MAX_DRIFT out of the band (then a repeat that fits wins).
 * @param {Song[]} songs
 * @param {Band} band
 * @param {(song: Song) => number} playCount  Times the song was played this game.
 * @returns {Song[]}
 */
export function songsForBand(songs, band, playCount = () => 0) {
  if (songs.length === 0) return [];
  let fewest = Infinity;
  for (const song of songs) fewest = Math.min(fewest, playCount(song));
  const freshest = songs.filter((song) => playCount(song) === fewest);

  if (band.ideal) {
    const ideal = freshest.filter((song) => bandDistance(song, band.ideal) === 0);
    if (ideal.length >= DIFFICULTY_MIN_CANDIDATES) return ideal;
  }
  const near = closest(freshest, band);
  if (near.every((song) => bandDistance(song, band) <= DIFFICULTY_MAX_DRIFT)) return near;
  // The fresh songs are all far from the band: repeat the least played of the closest ones.
  const closestAll = closest(songs, band);
  const least = Math.min(...closestAll.map(playCount));
  return closestAll.filter((song) => playCount(song) === least);
}
