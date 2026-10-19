/**
 * Central configuration. Every tunable constant of the app lives here.
 */

export const APP_NAME = 'Anisong Dungeon';

// ---------------------------------------------------------------- Network
export const PEER_ID_PREFIX = 'anisong-dungeon-v1-';
export const ROOM_CODE_LENGTH = 6;
/** Unambiguous characters only (no 0/O, 1/I/L). */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PEER_OPTIONS = {
  debug: 1,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ],
  },
};
export const CONNECT_TIMEOUT_MS = 15000;
/** Messages larger than this are split into chunks (WebRTC message size limits). */
export const MAX_MESSAGE_CHARS = 16000;
export const MAX_HOST_ID_ATTEMPTS = 5;
/**
 * Rejoining as a player the host still thinks is online: their old connection gets this long
 * to answer a ping; silent connections are dead links and are replaced.
 */
export const REJOIN_PROBE_MS = 3000;

// ---------------------------------------------------------------- Players
export const MAX_PLAYERS = 12;
export const NAME_MAX_LENGTH = 20;
export const ANILIST_NAME_MAX_LENGTH = 32;

// ---------------------------------------------------------------- Dungeon
export const GRID_SIZE = 15;
export const AREA_COUNT = 3;
/** Layout retries before accepting a floor with undersized areas or dead ends. */
export const MAP_GENERATION_ATTEMPTS = 60;
/** Correct guesses inside a sector after which its key and door locations are shown. */
export const AREA_REVEAL_GUESSES = 3;
export const KEYS_REQUIRED = 3;
export const DOOR_TAG_COUNT = 3;
/** A tag can theme an area only if the pool has at least this many songs for it. */
export const MIN_SONGS_PER_TAG = 15;
/**
 * Anime mode: chance for each sector theme (first floor and door themes) to be an artist area
 * instead: only songs of 2 artists play there. Each artist needs ARTIST_AREA_MIN_SONGS songs in
 * the pool (no one-off artists), and together they must cover every tile of the area.
 */
export const ARTIST_AREA_CHANCE = 0.15;
export const ARTIST_AREA_MIN_SONGS = 10;
export const ARTIST_AREA_PICK_ATTEMPTS = 20;
/** Theme label of an artist area: prefix + "Artist A & Artist B". */
export const ARTIST_TAG_PREFIX = 'Artists: ';
/** Host choice (anime mode): artist areas show their 2 artists, hide them, or never appear. */
export const ARTIST_AREA_MODES = Object.freeze({
  shown: 'Show artists',
  hidden: 'Hide artists',
  off: 'No artist areas',
});
/** Label players see for an artist area whose artists are hidden. */
export const ARTIST_TAG_HIDDEN = `${ARTIST_TAG_PREFIX}??? & ???`;
/**
 * Door vote: once every online player voted (or a door holds a strict majority), the most voted
 * door opens. A tie is settled by a roll that clients animate for this long.
 */
export const DOOR_ROLL_MS = 3200;

// ---------------------------------------------------------------- Songs
export const SONG_TYPES = Object.freeze({ OP: 'Openings', ED: 'Endings', IN: 'Inserts' });
/** What players must name: the anime, or the song title + its artist ("S/A"). */
export const ANSWER_MODES = Object.freeze({ anime: 'Name the anime', songArtist: 'Song + artist' });
/** Library numeric type → song type key. */
export const LIBRARY_TYPE_MAP = Object.freeze({ 1: 'OP', 2: 'ED', 3: 'IN' });
export const LIBRARY_URL = 'data/library.json';
/** Mirrors that serve library mp3 files, tried in order. */
export const MEDIA_HOSTS = [
  'https://naedist.animemusicquiz.com/',
  'https://nawdist.animemusicquiz.com/',
  'https://eudist.animemusicquiz.com/',
];
/** Guess rate (0-100, % of players who know the song) assumed when the library has none. */
export const UNKNOWN_GUESS_RATE = 25;
/** Most songs of one anime that can be served in the same area of a floor (anti-spam). */
export const MAX_SONGS_PER_ANIME_PER_AREA = 2;
/** Guess-rate window center on the first and last playable floor. Higher = easier. */
export const DIFFICULTY_EASY_CENTER = 58;
export const DIFFICULTY_HARD_CENTER = 12;
export const DIFFICULTY_HALF_WIDTH = 22;
export const DIFFICULTY_MIN_CANDIDATES = 6;
/** The song starts at a random point within this fraction of its length. */
export const MAX_START_FRACTION = 0.45;
/** Seconds of audio that should remain after the random start point. */
export const MIN_PLAY_SECONDS = 25;
/** Anime seasons, in library order (index = the library's season number). */
export const SEASONS = Object.freeze(['Winter', 'Spring', 'Summer', 'Fall']);
/**
 * Host choices when the pool has fewer songs than the floors need (see songsNeeded()):
 * repeat songs of the pool, or top it up with library songs matching the settings.
 */
export const SHORTAGE_CHOICES = Object.freeze({
  duplicates: 'Allow duplicates',
  fill: 'Fill with random songs',
});

/** Thematic AniList tags allowed as area themes, in addition to every genre. */
export const THEME_TAGS = [
  'Isekai', 'School', 'Magic', 'Super Power', 'Military', 'Historical', 'Swordplay', 'Space',
  'Idol', 'Demons', 'Aliens', 'Robots', 'Super Robot', 'Real Robot', 'Vampire', 'Cyberpunk',
  'Post-Apocalyptic', 'Dystopian', 'Time Manipulation', 'Martial Arts', 'Survival', 'Detective',
  'Video Games', 'Band', 'Gods', 'Shounen', 'Seinen', 'Shoujo', 'Josei', 'Kids', 'Tragedy',
  'Parody', 'Henshin', 'Cute Girls Doing Cute Things', 'Iyashikei', 'Revenge', 'War', 'Ninja',
  'Samurai', 'Pirates', 'Dragons', 'Zombie', 'Ghost', 'Yokai', 'Food', 'Cooking', 'Baseball',
  'Basketball', 'Football', 'Volleyball', 'Racing', 'Card Battle', 'Gambling', 'Spearplay',
];
export const EXCLUDED_GENRES = ['Hentai'];

// ---------------------------------------------------------------- AniList
export const ANILIST_API_URL = 'https://graphql.anilist.co';
export const ANILIST_PER_CHUNK = 500;
/** List statuses a player can include, as shown in the lobby. REPEATING counts as Watching. */
export const LIST_STATUSES = Object.freeze([
  { key: 'CURRENT', label: 'Watching', anilist: ['CURRENT', 'REPEATING'] },
  { key: 'COMPLETED', label: 'Completed', anilist: ['COMPLETED'] },
  { key: 'PAUSED', label: 'On Hold', anilist: ['PAUSED'] },
  { key: 'DROPPED', label: 'Dropped', anilist: ['DROPPED'] },
  { key: 'PLANNING', label: 'Plan to Watch', anilist: ['PLANNING'] },
]);
export const DEFAULT_LIST_STATUSES = ['CURRENT', 'COMPLETED', 'PAUSED', 'DROPPED'];
export const ANILIST_MAX_RETRIES = 2;

// ---------------------------------------------------------------- Avatars
/** Served by the launcher: JSON array of the image files found in app/avatars/. */
export const AVATAR_LIST_URL = 'avatars/list.json';
export const AVATAR_DIR = 'avatars/';
/** Avatars are shrunk to this square size (px) before being sent to players. */
export const AVATAR_SIZE = 96;
export const MAX_AVATARS = 80;
/** Number of fallback dot colors (players without an avatar). Matches tokens.css. */
export const PLAYER_COLOR_COUNT = 8;

// ---------------------------------------------------------------- Game settings
export const DEFAULT_SETTINGS = Object.freeze({
  songTypes: ['OP'],
  floors: 5,
  timeLimitMin: 30,
  rerollIntervalSec: 45,
  maxRerolls: 3,
  tilesPerArea: 15,
  answerMode: 'anime',
  artistAreas: 'shown',
  /** Anime mode: accept any season/entry of the franchise, not only the exact anime. */
  anySeason: false,
  /** Only anime aired between these seasons (inclusive) are used when true. */
  seasonRange: false,
  fromYear: 2000,
  fromSeason: 0,
  toYear: 2009,
  toSeason: 3,
});

export const SETTINGS_LIMITS = Object.freeze({
  floors: { min: 2, max: 20 },
  timeLimitMin: { min: 5, max: 180 },
  rerollIntervalSec: { min: 10, max: 600 },
  maxRerolls: { min: 1, max: 10 },
  tilesPerArea: { min: 6, max: 40 },
  fromYear: { min: 1920, max: 2030 },
  fromSeason: { min: 0, max: SEASONS.length - 1 },
  toYear: { min: 1920, max: 2030 },
  toSeason: { min: 0, max: SEASONS.length - 1 },
});

export const STARTING_REROLLS = 1;
export const SERVER_TICK_MS = 1000;
/** Minimum delay between two moves when a movement key is held down. */
export const MOVE_REPEAT_MS = 110;
/** Fuzzy matching: minimum similarity (0-1) and minimum length for typo tolerance. */
export const ANSWER_SIMILARITY = 0.88;
/**
 * Franchise names: guessing the name of an anime whose title starts the answer's title is
 * accepted ("Symphogear" for "Senki Zesshou Symphogear G"), if that prefix is at least this long.
 */
export const FRANCHISE_PREFIX_MIN_LENGTH = 4;
export const ANSWER_FUZZY_MIN_LENGTH = 6;
export const AUTOCOMPLETE_MAX_RESULTS = 60;

// ---------------------------------------------------------------- Storage keys
export const STORAGE_KEYS = Object.freeze({
  profile: 'ad.profile',
  volume: 'ad.volume',
  clientToken: 'ad.clientToken',
});
