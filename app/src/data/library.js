import { LIBRARY_TYPE_MAP, LIBRARY_URL, UNKNOWN_GUESS_RATE } from '../config.js';
import { seasonIndex } from '../game/settings.js';

/** @typedef {import('../game/types.js').Anime} Anime */
/** @typedef {import('../game/types.js').Song} Song */

const SUPPORTED_FORMAT = 4;

/**
 * @typedef {object} Library
 * @property {Map<number, Anime>} animeById
 * @property {Map<number, number[]>} animeIdsByAniList  AniList id → library anime ids.
 * @property {Song[]} songs
 * @property {string[]} songTitles   Every distinct song title (S/A mode suggestions).
 * @property {string[]} artistNames  Every distinct artist, group, member and alias name.
 */

/**
 * Downloads and decodes the song library exported by tools/export-library.mjs.
 * @param {string} [url]
 * @returns {Promise<Library>}
 */
export async function loadLibrary(url = LIBRARY_URL) {
  let response;
  try {
    response = await fetch(url);
  } catch {
    throw new Error('Could not load the song library. Is the launcher still running?');
  }
  if (!response.ok) {
    throw new Error(`No song library found (${response.status}). Put library.db in the data `
      + 'folder (needs Node.js) or library.json in app/data, then restart the launcher.');
  }
  const raw = await response.json();
  if (raw.version !== SUPPORTED_FORMAT) {
    throw new Error(`Unsupported library format ${raw.version}. Re-export the library.`);
  }
  return decodeLibrary(raw);
}

/**
 * Converts the compact array format into typed objects.
 * @param {{anime: any[][], songs: any[][], artists?: Record<string, [string[], string[][]]>}} raw
 * @returns {Library}
 */
export function decodeLibrary(raw) {
  const artistTable = raw.artists ?? {};
  const animeById = new Map();
  const animeIdsByAniList = new Map();

  for (const [id, aniListId, nameJa, nameEn, otherNames, genres, tags, year, season] of raw.anime) {
    const names = [...new Set([nameJa, nameEn, ...otherNames].filter(Boolean))];
    animeById.set(id, {
      id,
      aniListId,
      displayName: nameJa || nameEn,
      englishName: nameEn && nameEn !== nameJa ? nameEn : '',
      names,
      genres,
      tags,
      season: year > 0 && season >= 0 ? seasonIndex(year, season) : -1,
    });
    if (aniListId) {
      if (!animeIdsByAniList.has(aniListId)) animeIdsByAniList.set(aniListId, []);
      animeIdsByAniList.get(aniListId).push(id);
    }
  }

  const songs = [];
  for (const [id, animeId, title, artist, type, number, guessRate, file, altAnswers, artistRef] of raw.songs) {
    if (!animeById.has(animeId) || !LIBRARY_TYPE_MAP[type]) continue;
    songs.push({
      id,
      animeId,
      title,
      artist,
      type: LIBRARY_TYPE_MAP[type],
      number,
      guessRate: guessRate < 0 ? UNKNOWN_GUESS_RATE : guessRate,
      file,
      altAnswers: altAnswers ?? [],
      /** Same value for every song of one artist/group ("a<id>" / "g<id>", or the name). */
      artistRef: artistRef ?? `name:${artist}`,
      artistAliases: artistTable[artistRef]?.[0] ?? [artist],
      artistMembers: artistTable[artistRef]?.[1] ?? [],
    });
  }

  const songTitles = [...new Set(songs.map((song) => song.title).filter(Boolean))];
  const artistNames = [...new Set(
    Object.values(artistTable).flatMap(([aliases, members]) => [...aliases, ...members.flat()])
      .concat(songs.map((song) => song.artist)),
  )].filter(Boolean);
  return { animeById, animeIdsByAniList, songs, songTitles, artistNames };
}
