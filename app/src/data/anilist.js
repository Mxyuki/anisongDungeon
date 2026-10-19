import { ANILIST_API_URL, ANILIST_MAX_RETRIES, ANILIST_PER_CHUNK, LIST_STATUSES } from '../config.js';
import { wait } from '../core/time.js';

const LIST_QUERY = `
query ($userName: String, $chunk: Int, $perChunk: Int) {
  MediaListCollection(userName: $userName, type: ANIME, chunk: $chunk, perChunk: $perChunk) {
    hasNextChunk
    lists { entries { mediaId status } }
  }
}`;

const DEFAULT_RETRY_SECONDS = 5;

/**
 * Sends a GraphQL request to AniList, retrying when rate limited.
 * @param {string} query
 * @param {object} variables
 * @returns {Promise<any>} The `data` field.
 */
async function anilistRequest(query, variables) {
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await fetch(ANILIST_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
    } catch {
      throw new Error('AniList is unreachable. Check your internet connection.');
    }

    if (response.status === 429 && attempt < ANILIST_MAX_RETRIES) {
      const retryAfter = Number(response.headers.get('Retry-After')) || DEFAULT_RETRY_SECONDS;
      await wait(retryAfter * 1000);
      continue;
    }

    const body = await response.json().catch(() => ({}));
    if (response.status === 404 || body.errors?.some((error) => error.status === 404)) {
      throw new Error('AniList user not found.');
    }
    if (!response.ok || body.errors) {
      const message = body.errors?.[0]?.message ?? `HTTP ${response.status}`;
      throw new Error(`AniList error: ${message}`);
    }
    return body.data;
  }
}

/**
 * @typedef {object} ListEntry
 * @property {number} mediaId
 * @property {string} status   One of the LIST_STATUSES keys (REPEATING is folded into CURRENT).
 */

const STATUS_KEY_BY_ANILIST = Object.fromEntries(
  LIST_STATUSES.flatMap((status) => status.anilist.map((value) => [value, status.key])),
);

/**
 * Fetches every entry of a user's anime list, whatever its status.
 * @param {string} userName
 * @returns {Promise<ListEntry[]>}
 */
export async function fetchAnimeList(userName) {
  const entries = new Map();
  for (let chunk = 1; ; chunk++) {
    const data = await anilistRequest(LIST_QUERY, { userName, chunk, perChunk: ANILIST_PER_CHUNK });
    const collection = data.MediaListCollection;
    for (const list of collection?.lists ?? []) {
      for (const entry of list.entries) {
        const status = STATUS_KEY_BY_ANILIST[entry.status];
        if (status) entries.set(entry.mediaId, { mediaId: entry.mediaId, status });
      }
    }
    if (!collection?.hasNextChunk) break;
  }
  return [...entries.values()];
}

/**
 * Media ids of the entries whose status the player selected.
 * @param {ListEntry[]} entries
 * @param {string[]} statuses
 * @returns {number[]}
 */
export function filterByStatus(entries, statuses) {
  const allowed = new Set(statuses);
  return entries.filter((entry) => allowed.has(entry.status)).map((entry) => entry.mediaId);
}
