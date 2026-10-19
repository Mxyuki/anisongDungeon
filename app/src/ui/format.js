import { SONG_TYPES } from '../config.js';

/** Display helpers shared by screens. */

/**
 * @param {string | null} tag
 * @returns {string}
 */
export function formatTag(tag) {
  return tag ?? 'Mixed';
}

/**
 * "OP2" style label.
 * @param {string} type
 * @param {number} number
 */
export function formatSongSlot(type, number) {
  return number ? `${type}${number}` : type;
}

/**
 * Singular name of a song type ("Opening").
 * @param {string} type
 */
export function formatSongType(type) {
  return (SONG_TYPES[type] ?? type).replace(/s$/, '');
}

/**
 * Two-digit index label ("01").
 * @param {number} value
 */
export function pad2(value) {
  return String(value).padStart(2, '0');
}
