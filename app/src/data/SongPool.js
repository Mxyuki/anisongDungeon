import {
  ARTIST_AREA_MIN_SONGS,
  ARTIST_AREA_PICK_ATTEMPTS,
  ARTIST_TAG_PREFIX,
  EXCLUDED_GENRES,
  FRANCHISE_PREFIX_MIN_LENGTH,
  MEDIA_HOSTS,
  MIN_SONGS_PER_TAG,
  THEME_TAGS,
} from '../config.js';
import { normalizeText } from '../core/text.js';
import { buildAnswerKeys, isCorrectAnswer } from '../game/answers.js';

/** @typedef {import('../game/types.js').Song} Song */
/** @typedef {import('../game/types.js').Anime} Anime */
/** @typedef {import('./library.js').Library} Library */
/** @typedef {import('../core/rng.js').Rng} Rng */

const THEME_TAG_SET = new Set(THEME_TAGS);

/**
 * The songs available for one game, indexed by theme tag.
 */
export class SongPool {
  /** @type {Song[]} */ songs;
  /** @type {Map<string, Song[]>} */ #byTag = new Map();
  /** @type {Map<string, Song[]>} Artist area themes created so far. */
  #byArtistTag = new Map();
  /** @type {{ name: string, songs: Song[] }[] | null} Artists eligible for artist areas. */
  #areaArtists = null;
  /** @type {Map<string, string[]>} Cached answer keys by "<kind>:<song id>". */
  #answerKeys = new Map();
  /** @type {Map<string, Anime[]>} Normalized anime name → anime carrying it. */
  #animeByKey = new Map();
  /** @type {Library} */ #library;
  /** True when built from players' AniList lists, false for the whole library. */
  fromLists;

  /**
   * @param {Library} library
   * @param {object} options
   * @param {string[]} options.songTypes
   * @param {number[] | null} options.aniListIds  null = use the whole library.
   * @param {{ from: number, to: number } | null} [options.seasons]  Aired season range
   *   (seasonIndex() values, inclusive); null = any season.
   */
  constructor(library, { songTypes, aniListIds, seasons = null }) {
    this.#library = library;
    this.fromLists = Array.isArray(aniListIds) && aniListIds.length > 0;
    const animeIds = this.fromLists ? resolveAnimeIds(library, aniListIds) : null;
    const types = new Set(songTypes);

    this.songs = library.songs.filter((song) => {
      if (!types.has(song.type)) return false;
      if (animeIds && !animeIds.has(song.animeId)) return false;
      const anime = library.animeById.get(song.animeId);
      if (seasons && !(anime.season >= seasons.from && anime.season <= seasons.to)) return false;
      return !anime.genres.some((genre) => EXCLUDED_GENRES.includes(genre));
    });
    this.#indexTags();
    this.#indexAnimeNames();
  }

  #indexAnimeNames() {
    for (const anime of this.#library.animeById.values()) {
      for (const name of anime.names) {
        const key = normalizeText(name);
        if (!this.#animeByKey.has(key)) this.#animeByKey.set(key, []);
        this.#animeByKey.get(key).push(anime);
      }
    }
  }

  /**
   * Franchise names: when an anime's name starts one of `names` word by word, its names are
   * accepted, alone and followed by the rest of the title.
   * e.g. "Senki Zesshou Symphogear G" → "Senki Zesshou Symphogear", "Symphogear", "Symphogear G".
   * @param {string[]} names
   * @returns {string[]}
   */
  #franchiseNames(names) {
    const result = [];
    for (const name of names) {
      const words = normalizeText(name).split(' ');
      for (let length = 1; length < words.length; length++) {
        const prefix = words.slice(0, length).join(' ');
        if (prefix.length < FRANCHISE_PREFIX_MIN_LENGTH) continue;
        const rest = words.slice(length).join(' ');
        for (const anime of this.#animeByKey.get(prefix) ?? []) {
          for (const alias of anime.names) result.push(alias, `${alias} ${rest}`);
        }
      }
    }
    return result;
  }

  #cachedKeys(kind, song, buildNames) {
    const cacheKey = `${kind}:${song.id}`;
    if (!this.#answerKeys.has(cacheKey)) this.#answerKeys.set(cacheKey, buildAnswerKeys(buildNames()));
    return this.#answerKeys.get(cacheKey);
  }

  #indexTags() {
    for (const song of this.songs) {
      const anime = this.getAnime(song);
      const themes = [...anime.genres, ...anime.tags.filter((tag) => THEME_TAG_SET.has(tag))];
      for (const theme of themes) {
        if (!this.#byTag.has(theme)) this.#byTag.set(theme, []);
        this.#byTag.get(theme).push(song);
      }
    }
  }

  /**
   * Tags with enough songs to theme an area, most common first.
   * @returns {string[]}
   */
  eligibleTags() {
    return [...this.#byTag.entries()]
      .filter(([, songs]) => songs.length >= MIN_SONGS_PER_TAG)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([tag]) => tag);
  }

  /**
   * Artists with at least ARTIST_AREA_MIN_SONGS songs in the pool (computed once).
   * @returns {{ name: string, songs: Song[] }[]}
   */
  #artistsForAreas() {
    if (this.#areaArtists) return this.#areaArtists;
    const byArtist = new Map();
    for (const song of this.songs) {
      if (!byArtist.has(song.artistRef)) byArtist.set(song.artistRef, { name: song.artist, songs: [] });
      byArtist.get(song.artistRef).songs.push(song);
    }
    this.#areaArtists = [...byArtist.values()]
      .filter((artist) => artist.songs.length >= ARTIST_AREA_MIN_SONGS)
      .sort((a, b) => a.name.localeCompare(b.name));
    return this.#areaArtists;
  }

  /**
   * Picks 2 artists whose songs together fill an area and registers them as a theme: only their
   * songs play under it.
   * @param {Rng} rng
   * @param {number} minSongs  Songs the 2 artists need together (the area's tile count).
   * @returns {string | null} The theme label, or null when no pair fits.
   */
  createArtistTag(rng, minSongs) {
    const artists = this.#artistsForAreas();
    if (artists.length < 2) return null;
    for (let attempt = 0; attempt < ARTIST_AREA_PICK_ATTEMPTS; attempt++) {
      const first = rng.int(0, artists.length - 1);
      let second = rng.int(0, artists.length - 2);
      if (second >= first) second++;
      const [a, b] = [artists[first], artists[second]].sort((x, y) => x.name.localeCompare(y.name));
      if (a.songs.length + b.songs.length < minSongs) continue;
      const tag = `${ARTIST_TAG_PREFIX}${a.name} & ${b.name}`;
      if (!this.#byArtistTag.has(tag)) this.#byArtistTag.set(tag, [...a.songs, ...b.songs]);
      return tag;
    }
    return null;
  }

  /**
   * Whether this pool has songs for a theme (genre/tag or one of its artist areas).
   * @param {string} tag
   * @returns {boolean}
   */
  hasTheme(tag) {
    return this.#byTag.has(tag) || this.#byArtistTag.has(tag);
  }

  /**
   * @param {string | null} tag  null = any song.
   * @returns {Song[]}
   */
  candidatesFor(tag) {
    if (!tag) return this.songs;
    return this.#byTag.get(tag) ?? this.#byArtistTag.get(tag) ?? this.songs;
  }

  /**
   * @param {Song} song
   * @returns {Anime}
   */
  getAnime(song) {
    return this.#library.animeById.get(song.animeId);
  }

  /**
   * Normalized accepted anime answers for a song: its anime's names and the other anime sharing
   * the song; with `anySeason`, franchise names too (cached).
   * @param {Song} song
   * @param {{ anySeason?: boolean }} [options]
   * @returns {string[]}
   */
  answerKeysFor(song, { anySeason = false } = {}) {
    const names = () => [...this.getAnime(song).names, ...song.altAnswers];
    if (!anySeason) return this.#cachedKeys('anime', song, names);
    return this.#cachedKeys('franchise', song, () => [...names(), ...this.#franchiseNames(names())]);
  }

  /**
   * Checks an anime-mode guess. Without `anySeason`, only the exact anime counts: naming another
   * entry of the library (another season, a sequel…) is wrong even when it looks like a typo.
   * @param {Song} song
   * @param {string} guess
   * @param {{ anySeason?: boolean }} [options]
   * @returns {boolean}
   */
  isAnimeAnswer(song, guess, { anySeason = false } = {}) {
    const keys = this.answerKeysFor(song, { anySeason });
    if (anySeason) return isCorrectAnswer(guess, keys);
    const normalized = normalizeText(guess);
    if (this.#animeByKey.has(normalized) && !keys.includes(normalized)) return false;
    return isCorrectAnswer(guess, keys, { sameNumbers: true });
  }

  /**
   * Normalized accepted song titles (S/A mode).
   * @param {Song} song
   * @returns {string[]}
   */
  titleKeysFor(song) {
    return this.#cachedKeys('title', song, () => [song.title]);
  }

  /**
   * Normalized accepted artist answers (S/A mode): `aliases` (the artist/group and its other
   * names) and, for groups, the names of each member.
   * @param {Song} song
   * @returns {{ aliases: string[], members: string[][] }}
   */
  artistKeysFor(song) {
    return {
      aliases: this.#cachedKeys('artist', song, () => song.artistAliases),
      members: song.artistMembers.map((names, index) =>
        this.#cachedKeys(`member${index}`, song, () => names)),
    };
  }

  /**
   * Autocomplete lists for an answer mode. They cover the whole library so they do not reveal
   * which songs are in the pool.
   * @param {'anime' | 'songArtist'} mode
   * @returns {{ anime?: string[], songs?: string[], artists?: string[] }}
   */
  suggestions(mode) {
    const sorted = (values) => [...new Set(values)].sort((a, b) => a.localeCompare(b));
    if (mode === 'songArtist') {
      return { songs: sorted(this.#library.songTitles), artists: sorted(this.#library.artistNames) };
    }
    return { anime: sorted([...this.#library.animeById.values()].flatMap((anime) => anime.names)) };
  }

  /**
   * Media URLs for a song, one per mirror (clients fall back in order).
   * @param {Song} song
   * @returns {string[]}
   */
  mediaUrls(song) {
    return MEDIA_HOSTS.map((host) => host + song.file);
  }
}

function resolveAnimeIds(library, aniListIds) {
  const ids = new Set();
  for (const aniListId of aniListIds) {
    for (const id of library.animeIdsByAniList.get(aniListId) ?? []) ids.add(id);
  }
  return ids;
}
