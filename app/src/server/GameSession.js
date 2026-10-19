import {
  AREA_COUNT,
  DIFFICULTY_MAX_DRIFT,
  ARTIST_AREA_CHANCE,
  ARTIST_TAG_HIDDEN,
  ARTIST_TAG_PREFIX,
  DOOR_ROLL_MS,
  KEYS_REQUIRED,
  MAX_SONGS_PER_ANIME_PER_AREA,
  MAX_START_FRACTION,
  SERVER_TICK_MS,
  STARTING_REROLLS,
} from '../config.js';
import { Emitter } from '../core/emitter.js';
import { createRandomRng, createRng } from '../core/rng.js';
import { findMatchingAnswer, isCorrectAnswer } from '../game/answers.js';
import { bandDistance, floorBand, songsForBand } from '../game/difficulty.js';
import {
  areAdjacent, cellCoords, cellIndex, generateFloor, NEUTRAL_AREA, pickTags, VOID_AREA,
} from '../game/dungeon.js';
import { Expedition } from './Expedition.js';
import { PlayerState } from './PlayerState.js';

/** @typedef {import('../data/SongPool.js').SongPool} SongPool */
/** @typedef {import('../game/types.js').GameSettings} GameSettings */
/** @typedef {import('../game/types.js').Song} Song */

/**
 * Result of a player action: `{ ok: true }` or `{ ok: false, error }`.
 * @typedef {{ ok: boolean, error?: string, result?: object }} ActionResult
 */

const fail = (error) => ({ ok: false, error });
const OK = { ok: true };
const SECTOR_LETTERS = ['A', 'B', 'C', 'D', 'E'];

/**
 * Rules of one co-op game: every player walks their own dot on a shared map. Explored tiles,
 * tile songs, keys and doors belong to the team; rerolls and songs guessed are personal.
 *
 * Events:
 * - `floor`: the shared map changed (every player needs a new view)
 * - `player` (playerId): only that player's view changed
 * - `positions`: someone moved
 * - `result` (playerId, result): challenge news for a player who did not act (teammate guessed…)
 * - `announce` (message): team-wide message
 * - `leaderboard`, `end` (results)
 */
export class GameSession extends Emitter {
  /** @type {Map<string, PlayerState>} */ players = new Map();
  expedition = new Expedition();
  /** @type {SongPool} */ #pool;
  /** @type {SongPool | null} Library songs matching the settings, used once #pool runs dry. */
  #fillPool;
  /** @type {GameSettings} */ #settings;
  #rng = createRandomRng();
  #seed;
  #tagPool;
  #timer = null;
  #rollTimer = null;
  #rollCount = 0;
  /** Post-game review of every floor played (see #archiveFloor), oldest first. */
  #floorReviews = [];
  #currentFloorArchived = false;
  ended = false;
  startedAt;
  endsAt;

  /**
   * @param {object} options
   * @param {SongPool} options.pool
   * @param {SongPool | null} [options.fillPool]  Tops up `pool`: a tile whose theme has no
   *   unplayed song left in `pool` takes one from here (same theme and difficulty).
   * @param {GameSettings} options.settings
   * @param {{id: string, name: string, avatar?: string, color?: number}[]} options.players
   * @param {number} [options.now]
   */
  constructor({ pool, fillPool = null, settings, players, now = Date.now() }) {
    super();
    this.#pool = pool;
    this.#fillPool = fillPool;
    this.#settings = settings;
    this.#seed = Math.floor(this.#rng.next() * 2 ** 32);
    this.#tagPool = this.#themes();
    this.expedition.revealAfter = settings.revealAfter;
    this.startedAt = now;
    this.endsAt = now + settings.timeLimitMin * 60_000;

    const firstRng = createRng(`${this.#seed}:first`);
    const firstTags = this.#withArtistAreas(firstRng, pickTags(firstRng, this.#tagPool, AREA_COUNT));
    this.expedition.enterFloor(this.#buildFloor(1, firstTags));
    for (const player of players) this.#createPlayer(player, now);
  }

  /** A new dot at the entrance of the current floor, with the starting rerolls. */
  #createPlayer(player, now) {
    const rerolls = Math.min(STARTING_REROLLS, this.#settings.maxRerolls);
    const state = new PlayerState({
      playerId: player.id,
      name: player.name,
      avatar: player.avatar ?? '',
      color: player.color ?? 0,
      position: this.expedition.startIndex,
      rerolls,
      nextRerollAt: rerolls < this.#settings.maxRerolls ? now + this.#rerollIntervalMs : null,
    });
    this.players.set(player.id, state);
    return state;
  }

  /**
   * Late join: a new player starts at the entrance of the current floor.
   * @param {{id: string, name: string, avatar?: string, color?: number}} player
   * @param {number} [now]
   * @returns {boolean} False when the game is over or the player already plays.
   */
  addPlayer(player, now = Date.now()) {
    if (this.ended || this.expedition.finished || this.players.has(player.id)) return false;
    this.#createPlayer(player, now);
    this.emit('positions');
    this.emit('leaderboard');
    return true;
  }

  get settings() {
    return this.#settings;
  }

  /**
   * Area themes come from the pool; a pool too small to theme every sector borrows the fill
   * pool's themes (those areas then play filler songs).
   */
  #themes() {
    const own = this.#pool.eligibleTags();
    if (!this.#fillPool || own.length >= AREA_COUNT) return own;
    return [...new Set([...own, ...this.#fillPool.eligibleTags()])];
  }

  get #rerollIntervalMs() {
    return this.#settings.rerollIntervalSec * 1000;
  }

  start() {
    this.#timer = setInterval(() => this.tick(Date.now()), SERVER_TICK_MS);
  }

  stop() {
    clearInterval(this.#timer);
    clearTimeout(this.#rollTimer);
    this.#timer = null;
    this.#rollTimer = null;
  }

  /** Floors are seeded by the game seed + floor + themes. */
  #buildFloor(floorNumber, areaTags) {
    const rng = createRng(`${this.#seed}:${floorNumber}:${areaTags.join('|')}`);
    const floor = generateFloor({
      rng,
      floorNumber,
      areaTags,
      tagPool: this.#tagPool,
      tilesPerArea: this.#settings.tilesPerArea,
    });
    const artistRng = createRng(`${this.#seed}:${floorNumber}:artists`);
    for (const door of floor.doors) door.tags = this.#withArtistAreas(artistRng, door.tags);
    return floor;
  }

  /**
   * Anime mode: turns some themes into artist areas (only 2 artists' songs play there).
   * Not in S/A mode, where the theme would give the artist away, nor when the host turned them off.
   */
  #withArtistAreas(rng, tags) {
    if (this.#settings.answerMode !== 'anime' || this.#settings.artistAreas === 'off') return tags;
    return tags.map((tag) => {
      if (rng.next() >= ARTIST_AREA_CHANCE) return tag;
      return this.#pool.createArtistTag(rng, this.#settings.tilesPerArea) ?? tag;
    });
  }

  /** Theme as players see it: artist areas lose their artists when the host hides them. */
  #tagLabel(tag) {
    const hidden = this.#settings.artistAreas === 'hidden' && tag?.startsWith(ARTIST_TAG_PREFIX);
    return hidden ? ARTIST_TAG_HIDDEN : tag;
  }

  #activePlayer(playerId) {
    if (this.ended || this.expedition.finished) return null;
    return this.players.get(playerId) ?? null;
  }

  /** The shared song of the tile a player stands on, if that tile is unexplored. */
  #challengeOf(player) {
    const { expedition } = this;
    if (expedition.cleared.has(player.position)) return null;
    return expedition.tileSongs.get(player.position) ?? null;
  }

  #playersOn(index, exceptId = null) {
    return [...this.players.values()].filter((p) => p.position === index && p.playerId !== exceptId);
  }

  /**
   * Moves a player's dot to an adjacent cell. Stepping onto an unexplored cell plays its song;
   * from an unexplored cell the player may only step back onto explored ground.
   * @returns {ActionResult}
   */
  move(playerId, x, y) {
    const player = this.#activePlayer(playerId);
    if (!player) return fail('The expedition is over.');
    const { expedition } = this;
    const size = expedition.floor.size;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= size || y >= size) {
      return fail('You cannot leave the map.');
    }
    const target = cellIndex(x, y, size);
    if (!areAdjacent(player.position, target, size)) return fail('Move one tile at a time.');
    if (!expedition.isWalkable(target)) return fail('There is nothing there.');
    const targetCleared = expedition.cleared.has(target);
    if (!expedition.cleared.has(player.position) && !targetCleared) {
      return fail('Guess this song (or reroll it) before going further.');
    }
    if (!targetCleared && !expedition.tileSongs.has(target) && !this.#assignSong(target)) {
      return fail('No song available for this tile.');
    }
    player.position = target;
    this.emit('player', playerId);
    this.emit('positions');
    return OK;
  }

  #assignSong(index) {
    const { expedition } = this;
    const cell = expedition.floor.cells[index];
    const tag = cell.areaIndex >= 0 ? expedition.floor.areas[cell.areaIndex].tag : null;
    const band = floorBand(expedition.floorNumber, this.#settings.floors);
    const candidates = this.#candidatesFor(tag, cell.areaIndex, band);
    if (candidates.length === 0) return false;
    const song = this.#rng.pick(candidates);
    expedition.recordPlay(cell.areaIndex, song);
    expedition.tileSongs.set(index, {
      song,
      tag,
      startFraction: this.#rng.next() * MAX_START_FRACTION,
      id: ++expedition.challengeCount,
    });
    return true;
  }

  /**
   * Songs a tile may draw. Difficulty comes first: songsForBand (game/difficulty.js) keeps the
   * songs closest to the floor's band, unheard ones first. The options below are tried in order
   * and the first one that stays within DIFFICULTY_MAX_DRIFT of the band wins:
   *   lists with the anime quota (MAX_SONGS_PER_ANIME_PER_AREA), lists without it,
   *   then (fill pool) the library with the quota, without it.
   * The lists only count as fitting if they still have an unheard song (else the fill pool tops
   * them up). When nothing fits, the option whose songs are closest to the band is used.
   * Finally songs already waiting on another tile (or being rerolled away) are skipped.
   */
  #candidatesFor(tag, areaIndex, band) {
    const { expedition } = this;
    const plays = (song) => expedition.songPlayCount(song.id);
    const underQuota = (songs) => songs.filter((song) =>
      expedition.animePlayCount(areaIndex, song.animeId) < MAX_SONGS_PER_ANIME_PER_AREA);
    const fits = (songs, needFresh) => songs.length > 0
      && songs.every((song) => bandDistance(song, band) <= DIFFICULTY_MAX_DRIFT)
      && (!needFresh || songs.some((song) => plays(song) === 0));

    const fill = this.#fillPool;
    // Artist areas exist in one pool only.
    const inList = !tag || this.#pool.hasTheme(tag);
    const inFill = Boolean(fill) && (!tag || fill.hasTheme(tag));
    const sources = [
      inList && { songs: this.#pool.candidatesFor(tag), needFresh: inFill },
      inFill && { songs: fill.candidatesFor(tag), needFresh: false },
    ].filter(Boolean);
    const options = sources.flatMap(({ songs, needFresh }) => [
      { songs: underQuota(songs), needFresh },
      { songs, needFresh },
    ]).map(({ songs, needFresh }) => ({ picked: songsForBand(songs, band, plays), needFresh }));

    const farthest = (songs) => Math.max(...songs.map((song) => bandDistance(song, band)));
    const chosen = options.find(({ picked, needFresh }) => fits(picked, needFresh))
      ?? options.filter(({ picked }) => picked.length > 0)
        .reduce((best, option) => (!best || farthest(option.picked) < farthest(best.picked) ? option : best), null);
    const songs = chosen?.picked ?? [];
    const busy = new Set([...expedition.tileSongs.values()].map((tile) => tile.song.id));
    const free = songs.filter((song) => !busy.has(song.id));
    return free.length > 0 ? free : songs;
  }

  /**
   * Checks an answer for the song of the tile the player stands on. A wrong answer changes
   * nothing. Anime mode: a right anime name explores the tile. S/A mode: each part (song name,
   * artist, group member) is checked on its own and kept for the team; the tile is explored
   * once the song name and the artist are both found.
   * @param {string} playerId
   * @param {string | { text?: string, song?: string, artist?: string }} submitted
   * @returns {ActionResult}
   */
  guess(playerId, submitted) {
    const player = this.#activePlayer(playerId);
    const challenge = player && this.#challengeOf(player);
    if (!challenge) return fail('There is no song to guess here.');
    if (this.#settings.answerMode === 'songArtist') return this.#guessSongArtist(player, challenge, submitted);

    const text = typeof submitted === 'string' ? submitted : submitted?.text;
    if (typeof text !== 'string' || !text.trim()) return fail('Type an anime name first.');
    const guess = text.trim();
    if (!this.#pool.isAnimeAnswer(challenge.song, guess, { anySeason: this.#settings.anySeason })) {
      return { ok: true, result: { kind: 'wrong', correct: false, guess } };
    }
    return this.#solveTile(player, challenge, [player.playerId], guess);
  }

  /** Explores the player's tile for the team; every contributor scores one song. */
  #solveTile(player, challenge, contributorIds, guess) {
    const index = player.position;
    const answer = this.#describeSong(challenge.song);
    const solvers = [];
    for (const id of new Set(contributorIds)) {
      const contributor = this.players.get(id);
      if (!contributor) continue;
      contributor.stats.guessed++;
      solvers.push(contributor.name);
    }
    this.expedition.solvers.set(index, solvers);
    const reward = this.expedition.clearCell(index, answer);
    for (const teammate of this.#playersOn(index, player.playerId)) {
      this.emit('result', teammate.playerId, { kind: 'teammate', by: player.name, reward, answer });
    }
    if (reward) this.emit('announce', `${player.name} found the ${this.#describeReward(index, reward)}`);
    this.emit('floor');
    this.emit('leaderboard');
    return { ok: true, result: { kind: 'correct', correct: true, guess, reward, answer } };
  }

  /**
   * S/A mode: `submitted` may hold the song name, the artist, or both. The artist part is found
   * by naming the artist/group (or an alias), or by naming every member of the group.
   */
  #guessSongArtist(player, challenge, submitted) {
    const title = typeof submitted?.song === 'string' ? submitted.song.trim() : '';
    const artist = typeof submitted?.artist === 'string' ? submitted.artist.trim() : '';
    if (!title && !artist) return fail('Type the song name or the artist.');

    const { song } = challenge;
    const artistKeys = this.#pool.artistKeysFor(song);
    const progress = this.expedition.progressFor(player.position, artistKeys.members.length);
    const found = [];
    const missed = [];

    if (title && !progress.song) {
      if (isCorrectAnswer(title, this.#pool.titleKeysFor(song))) {
        progress.song = true;
        player.stats.songsFound++;
        found.push('song');
      } else {
        missed.push('song');
      }
    }
    if (artist && !progress.artist) {
      const member = findMatchingAnswer(artist, artistKeys.members);
      if (isCorrectAnswer(artist, artistKeys.aliases)) {
        progress.artist = true;
        player.stats.artistsFound++;
        found.push('artist');
      } else if (member >= 0 && !progress.members.has(member)) {
        progress.members.add(member);
        found.push('member');
        if (progress.members.size === progress.memberCount) {
          progress.artist = true;
          player.stats.artistsFound++;
        }
      } else if (member < 0) {
        missed.push('artist');
      }
    }

    if (found.length > 0) progress.contributors.add(player.playerId);
    if (progress.song && progress.artist) {
      return this.#solveTile(player, challenge, [...progress.contributors], [title, artist].filter(Boolean).join(' — '));
    }
    if (found.length === 0) {
      const guess = [title, artist].filter(Boolean).join(' — ');
      return { ok: true, result: { kind: missed.length ? 'wrong' : 'known', correct: false, guess, missed } };
    }

    const summary = this.#progressView(progress, song);
    for (const teammate of this.#playersOn(player.position, player.playerId)) {
      this.emit('result', teammate.playerId, { kind: 'progress', by: player.name, found, summary });
    }
    this.emit('floor');
    this.emit('leaderboard');
    return { ok: true, result: { kind: 'progress', correct: false, found, missed, summary } };
  }

  /** What the team found on a tile, with the found texts (shown in the Signal panel). */
  #progressView(progress, song) {
    return {
      song: progress.song ? song.title : null,
      artist: progress.artist ? song.artist : null,
      members: [...progress.members].sort((a, b) => a - b).map((index) => song.artistMembers[index][0]),
      memberCount: progress.memberCount,
    };
  }

  #describeReward(index, reward) {
    const { areaIndex } = this.expedition.floor.cells[index];
    const where = areaIndex === NEUTRAL_AREA ? 'center' : `sector ${SECTOR_LETTERS[areaIndex]}`;
    return `${reward} of the ${where}!`;
  }

  #describeSong(song) {
    const anime = this.#pool.getAnime(song);
    return {
      anime: anime.displayName,
      englishName: anime.englishName,
      title: song.title,
      artist: song.artist,
      type: song.type,
      number: song.number,
      guessRate: song.guessRate,
    };
  }

  /** Swaps the song of the player's tile (for everyone on it), using one of their rerolls. */
  reroll(playerId, now = Date.now()) {
    const player = this.#activePlayer(playerId);
    const challenge = player && this.#challengeOf(player);
    if (!challenge) return fail('Step onto an unexplored tile before rerolling.');
    if (player.rerolls <= 0) return fail('No reroll available yet.');
    if (!this.#assignSong(player.position)) return fail('No other song available.');
    this.expedition.recordReroll(player.position, challenge.song, player.name);
    this.expedition.tileProgress.delete(player.position); // a new song starts from scratch
    player.rerolls--;
    player.stats.rerollsUsed++;
    if (player.nextRerollAt === null) player.nextRerollAt = now + this.#rerollIntervalMs;

    const answer = this.#describeSong(challenge.song);
    for (const teammate of this.#playersOn(player.position, playerId)) {
      this.emit('result', teammate.playerId, { kind: 'rerolled', by: player.name, answer });
      this.emit('player', teammate.playerId);
    }
    this.emit('player', playerId);
    return { ok: true, result: { kind: 'rerolled', answer } };
  }

  /**
   * Votes for a discovered door; voting for the same door again withdraws the vote. Alone, the
   * vote opens the door at once (see #settleVote for the team rules).
   * @returns {ActionResult}
   */
  enterDoor(playerId, areaIndex, now = Date.now()) {
    const player = this.#activePlayer(playerId);
    if (!player) return fail('The expedition is over.');
    const { expedition } = this;
    if (expedition.doorRoll) return fail('The team is already rolling for a door.');
    const door = expedition.floor.doors.find((candidate) => candidate.areaIndex === areaIndex);
    if (!door || !expedition.foundDoors.has(areaIndex)) return fail('Nobody has found this door yet.');
    if (expedition.keys < KEYS_REQUIRED) return fail(`The team needs ${KEYS_REQUIRED} keys to open a door.`);

    if (expedition.doorVotes.get(playerId) === areaIndex) expedition.doorVotes.delete(playerId);
    else expedition.doorVotes.set(playerId, areaIndex);
    if (!this.#settleVote(now, player)) this.emit('floor');
    return OK;
  }

  /**
   * Opens the most voted door once every online player voted, or as soon as one door holds a
   * strict majority (later votes could not change the outcome). A tie starts a roll.
   * @param {number} now
   * @param {PlayerState} [lastVoter]
   * @returns {boolean} Whether the vote is over.
   */
  #settleVote(now, lastVoter) {
    const voters = [...this.players.values()].filter((player) => player.online);
    const tally = new Map();
    for (const voter of voters) {
      const areaIndex = this.expedition.doorVotes.get(voter.playerId);
      if (areaIndex !== undefined) tally.set(areaIndex, (tally.get(areaIndex) ?? 0) + 1);
    }
    if (tally.size === 0) return false;
    const best = Math.max(...tally.values());
    const everyoneVoted = voters.every((voter) => this.expedition.doorVotes.has(voter.playerId));
    if (best * 2 <= voters.length && !everyoneVoted) return false;

    const leaders = [...tally].filter(([, count]) => count === best).map(([areaIndex]) => areaIndex);
    if (leaders.length > 1) {
      this.#startRoll(leaders, now);
      return true;
    }
    const opener = voters.length === 1 && lastVoter
      ? `${lastVoter.name} opened ${this.#doorName(leaders[0])}`
      : `The team voted for ${this.#doorName(leaders[0])}`;
    this.#openDoor(leaders[0], now, opener);
    return true;
  }

  /** Tie: the winner is drawn now; clients animate the roll before the door opens. */
  #startRoll(candidates, now) {
    const winner = this.#rng.pick(candidates);
    this.expedition.doorRoll = { id: ++this.#rollCount, candidates, winner, resolveAt: now + DOOR_ROLL_MS };
    clearTimeout(this.#rollTimer);
    this.#rollTimer = setTimeout(() => this.#finishRoll(Date.now()), DOOR_ROLL_MS);
    // Node (tests) must not stay alive for a pending roll; browsers return a plain number.
    this.#rollTimer.unref?.();
    const names = candidates.map((index) => this.#doorName(index)).join(', ');
    this.emit('announce', `Tie between ${names}: rolling…`);
    this.emit('floor');
  }

  #finishRoll(now) {
    const roll = this.expedition.doorRoll;
    if (!roll || this.ended) return;
    clearTimeout(this.#rollTimer);
    this.#rollTimer = null;
    this.expedition.doorRoll = null;
    this.#openDoor(roll.winner, now, `The roll picked ${this.#doorName(roll.winner)}`);
  }

  #doorName(areaIndex) {
    return areaIndex === NEUTRAL_AREA ? 'the center door' : `door ${SECTOR_LETTERS[areaIndex]}`;
  }

  /** Uses the team's keys to take everyone through a door. */
  #openDoor(areaIndex, now, opener) {
    const { expedition } = this;
    const door = expedition.floor.doors.find((candidate) => candidate.areaIndex === areaIndex);
    const nextFloor = expedition.floorNumber + 1;
    this.#archiveFloor();
    // The last floor's door leads to the summit: every one of settings.floors floors is played.
    if (expedition.floorNumber >= this.#settings.floors) {
      expedition.finish(expedition.floorNumber, now);
      this.emit('announce', `${opener}. The summit is reached!`);
      this.emit('leaderboard');
      this.end();
      return;
    }
    expedition.enterFloor(this.#buildFloor(nextFloor, door.tags));
    this.#currentFloorArchived = false;
    for (const other of this.players.values()) other.position = expedition.startIndex;
    this.emit('announce', `${opener}: welcome to floor ${nextFloor}.`);
    this.emit('floor');
    this.emit('positions');
    this.emit('leaderboard');
  }

  /**
   * A player connected or disconnected. A disconnected player's door vote is dropped, which
   * may complete the vote of the players still there.
   * @param {string} playerId
   * @param {boolean} online
   * @param {number} [now]
   */
  setOnline(playerId, online, now = Date.now()) {
    const player = this.players.get(playerId);
    if (!player || player.online === online) return;
    player.online = online;
    if (this.ended || this.expedition.finished) return;
    if (!online) this.expedition.doorVotes.delete(playerId);
    if (this.expedition.doorRoll || !this.#settleVote(now)) this.emit('floor');
  }

  /** Grants rerolls on cooldown and ends the game when time runs out. */
  tick(now) {
    if (this.ended) return;
    if (now >= this.endsAt) {
      this.end();
      return;
    }
    if (this.expedition.doorRoll && now >= this.expedition.doorRoll.resolveAt) this.#finishRoll(now);
    for (const player of this.players.values()) {
      if (player.nextRerollAt === null || now < player.nextRerollAt) continue;
      player.rerolls++;
      player.nextRerollAt = player.rerolls < this.#settings.maxRerolls ? now + this.#rerollIntervalMs : null;
      this.emit('player', player.playerId);
    }
  }

  end() {
    if (this.ended) return;
    if (!this.#currentFloorArchived) this.#archiveFloor();
    this.ended = true;
    this.stop();
    this.emit('end', this.results());
  }

  remainingMs(now = Date.now()) {
    return Math.max(0, this.endsAt - now);
  }

  /** Where everyone stands. */
  positions() {
    const size = this.expedition.floor.size;
    return [...this.players.values()].map((player) => ({
      ...player.identity,
      ...cellCoords(player.position, size),
    }));
  }

  /** Full view for one player: shared map + their own dot, song and rerolls. */
  viewFor(playerId, now = Date.now()) {
    const player = this.players.get(playerId);
    if (!player) return null;
    const { expedition } = this;
    const challenge = this.#challengeOf(player);
    const size = expedition.floor.size;
    const progress = challenge && this.#settings.answerMode === 'songArtist'
      ? this.#progressView(expedition.tileProgress.get(player.position) ?? {
        song: false, artist: false, members: new Set(), memberCount: challenge.song.artistMembers.length,
      }, challenge.song)
      : null;
    return {
      floor: expedition.floorNumber,
      finished: expedition.finished,
      keys: expedition.keys,
      /** Sector of each collected key, in pick-up order (colors the HUD key slots). */
      keyAreas: [...expedition.collectedKeys],
      /** Answer of the explored tile the player stands on, if it had a song. */
      tileAnswer: expedition.cleared.has(player.position)
        ? expedition.solvedAnswers.get(player.position) ?? null
        : null,
      rerolls: player.rerolls,
      rerollInMs: player.nextRerollAt === null ? null : Math.max(0, player.nextRerollAt - now),
      stats: { ...player.stats },
      position: cellCoords(player.position, size),
      players: this.positions(),
      grid: expedition.gridView(
        [...this.players.values()].map((p) => p.position),
        (tag) => this.#tagLabel(tag),
      ),
      /** Tie between doors: clients animate the roll, the winner opens after remainingMs. */
      doorRoll: expedition.doorRoll && {
        id: expedition.doorRoll.id,
        candidates: [...expedition.doorRoll.candidates],
        winner: expedition.doorRoll.winner,
        remainingMs: Math.max(0, expedition.doorRoll.resolveAt - now),
      },
      challenge: challenge && {
        ...cellCoords(player.position, size),
        tag: this.#tagLabel(challenge.tag),
        type: challenge.song.type,
        id: challenge.id,
        media: this.#pool.mediaUrls(challenge.song),
        startFraction: challenge.startFraction,
        progress,
      },
      remainingMs: this.remainingMs(now),
    };
  }

  /**
   * Saves the current floor for the post-game map review: the whole map (no fog) and, per tile,
   * its answer and solvers, the song left unanswered, and the songs rerolled away. The game is
   * over when this is sent, so answers and real themes can be shown.
   */
  #archiveFloor() {
    const { expedition } = this;
    const { floor } = expedition;
    const describeRerolls = (index) => (expedition.rerolledSongs.get(index) ?? [])
      .map(({ song, by }) => ({ answer: this.#describeSong(song), by }));
    this.#floorReviews.push({
      number: expedition.floorNumber,
      size: floor.size,
      areas: floor.areas.map((area) => ({ index: area.index, tag: area.tag })),
      cells: floor.cells.map((cell, index) => {
        if (cell.areaIndex === VOID_AREA) return { state: 'void' };
        const cleared = expedition.cleared.has(index);
        const pending = expedition.tileSongs.get(index);
        return {
          area: cell.areaIndex,
          content: cell.content,
          state: cleared ? 'answered' : pending ? 'unanswered' : 'unvisited',
          answer: cleared ? expedition.solvedAnswers.get(index) ?? null
            : pending ? this.#describeSong(pending.song) : null,
          solvers: expedition.solvers.get(index) ?? [],
          rerolls: describeRerolls(index),
        };
      }),
    });
    this.#currentFloorArchived = true;
  }

  /** Players sorted by songs guessed, then fewest rerolls. */
  #rankedPlayers() {
    return [...this.players.values()].sort((a, b) =>
      b.stats.guessed - a.stats.guessed || a.stats.rerollsUsed - b.stats.rerollsUsed);
  }

  leaderboard() {
    return this.#rankedPlayers().map((player, rank) => ({
      rank: rank + 1,
      ...player.identity,
      guessed: player.stats.guessed,
      songsFound: player.stats.songsFound,
      artistsFound: player.stats.artistsFound,
    }));
  }

  results() {
    const { expedition } = this;
    return {
      totalFloors: this.#settings.floors,
      floorReached: expedition.floorNumber,
      finished: expedition.finished,
      answerMode: this.#settings.answerMode,
      floors: this.#floorReviews,
      durationMs: (expedition.finishedAt ?? Math.min(Date.now(), this.endsAt)) - this.startedAt,
      players: this.#rankedPlayers().map((player, rank) => ({
        rank: rank + 1,
        ...player.identity,
        guessed: player.stats.guessed,
        rerollsUsed: player.stats.rerollsUsed,
        songsFound: player.stats.songsFound,
        artistsFound: player.stats.artistsFound,
      })),
    };
  }
}
