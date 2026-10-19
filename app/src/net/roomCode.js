import { PEER_ID_PREFIX, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../config.js';

/**
 * Generates a random room code like "K7QM2X".
 * @returns {string}
 */
export function generateRoomCode() {
  const values = crypto.getRandomValues(new Uint32Array(ROOM_CODE_LENGTH));
  return Array.from(values, (value) => ROOM_CODE_ALPHABET[value % ROOM_CODE_ALPHABET.length])
    .join('');
}

/**
 * Cleans user input (spaces, dashes, lowercase).
 * @param {string} input
 * @returns {string}
 */
export function normalizeRoomCode(input) {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, ROOM_CODE_LENGTH);
}

/**
 * @param {string} code
 * @returns {boolean}
 */
export function isValidRoomCode(code) {
  return code.length === ROOM_CODE_LENGTH && [...code].every((c) => ROOM_CODE_ALPHABET.includes(c));
}

/**
 * @param {string} code
 * @returns {string} PeerJS id of the host.
 */
export function peerIdForCode(code) {
  return PEER_ID_PREFIX + code;
}
