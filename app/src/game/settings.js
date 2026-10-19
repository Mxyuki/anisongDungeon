import {
  ANSWER_MODES,
  AREA_COUNT,
  ARTIST_AREA_MODES,
  DEFAULT_SETTINGS,
  SEASONS,
  SETTINGS_LIMITS,
  SONG_TYPES,
} from '../config.js';
import { clampNumber } from '../core/text.js';

/** @typedef {import('./types.js').GameSettings} GameSettings */

const BOOLEAN_SETTINGS = ['anySeason', 'seasonRange', 'lateJoin'];

/**
 * Merges untrusted input onto the previous settings and clamps every field.
 * @param {unknown} input
 * @param {GameSettings} [previous]
 * @returns {GameSettings}
 */
export function sanitizeSettings(input, previous = DEFAULT_SETTINGS) {
  const source = input && typeof input === 'object' ? input : {};
  const settings = { ...DEFAULT_SETTINGS, ...previous };

  if (Array.isArray(source.songTypes)) {
    const types = Object.keys(SONG_TYPES).filter((type) => source.songTypes.includes(type));
    if (types.length > 0) settings.songTypes = types;
  }

  if (typeof source.answerMode === 'string' && source.answerMode in ANSWER_MODES) {
    settings.answerMode = source.answerMode;
  }

  if (typeof source.artistAreas === 'string' && source.artistAreas in ARTIST_AREA_MODES) {
    settings.artistAreas = source.artistAreas;
  }

  for (const key of BOOLEAN_SETTINGS) {
    if (typeof source[key] === 'boolean') settings[key] = source[key];
  }

  for (const [key, limits] of Object.entries(SETTINGS_LIMITS)) {
    if (key in source) {
      settings[key] = clampNumber(source[key], limits.min, limits.max, settings[key]);
    }
  }
  return orderSeasonRange(settings, 'toYear' in source || 'toSeason' in source);
}

/** Moving one end of the season range past the other drags the other end along. */
function orderSeasonRange(settings, movedEnd) {
  const from = seasonIndex(settings.fromYear, settings.fromSeason);
  const to = seasonIndex(settings.toYear, settings.toSeason);
  if (from <= to) return settings;
  if (movedEnd) return { ...settings, fromYear: settings.toYear, fromSeason: settings.toSeason };
  return { ...settings, toYear: settings.fromYear, toSeason: settings.fromSeason };
}

/**
 * Number of floors players explore: every floor is played, and opening a door on the last one
 * reaches the summit (the end of the run).
 * @param {GameSettings} settings
 * @returns {number}
 */
export function playableFloors(settings) {
  return settings.floors;
}

/**
 * Songs needed to give every tile of every playable floor its own song (rerolls not counted).
 * @param {GameSettings} settings
 * @returns {number}
 */
export function songsNeeded(settings) {
  return playableFloors(settings) * (AREA_COUNT + 1) * settings.tilesPerArea;
}

/**
 * Sortable number of an anime season: seasons of one year follow each other.
 * @param {number} year
 * @param {number} season  0 Winter … 3 Fall.
 * @returns {number}
 */
export function seasonIndex(year, season) {
  return year * SEASONS.length + season;
}

/**
 * The season range the host picked, or null when every season is allowed.
 * @param {GameSettings} settings
 * @returns {{ from: number, to: number } | null}
 */
export function seasonBounds(settings) {
  if (!settings.seasonRange) return null;
  return {
    from: seasonIndex(settings.fromYear, settings.fromSeason),
    to: seasonIndex(settings.toYear, settings.toSeason),
  };
}
