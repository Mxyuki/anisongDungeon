import {
  ANILIST_NAME_MAX_LENGTH,
  DEFAULT_LIST_STATUSES,
  DEFAULT_SETTINGS,
  LIST_STATUSES,
  MAX_PLAYERS,
  MIN_SONGS_PER_TAG,
  NAME_MAX_LENGTH,
  PLAYER_COLOR_COUNT,
  REJOIN_PROBE_MS,
  SHORTAGE_CHOICES,
} from '../config.js';
import { cleanString, normalizeText } from '../core/text.js';
import { fetchAnimeList, filterByStatus } from '../data/anilist.js';
import { loadAvatarCatalog } from '../data/avatars.js';
import { loadLibrary } from '../data/library.js';
import { SongPool } from '../data/SongPool.js';
import { sanitizeSettings, seasonBounds, songsNeeded } from '../game/settings.js';
import { MSG, PHASE, PROTOCOL_VERSION } from '../net/protocol.js';
import { createLoopbackPair, HostTransport } from '../net/transport.js';
import { GameSession } from './GameSession.js';

/** @typedef {import('../net/transport.js').Connection} Connection */

/**
 * @typedef {object} PlayerRecord
 * @property {string} id
 * @property {string} token        Client-chosen secret used to reconnect.
 * @property {string} name
 * @property {string} anilist
 * @property {string[]} statuses   List statuses (LIST_STATUSES keys) the player plays from.
 * @property {{state: 'none'|'checking'|'ok'|'error', count: number, error: string}} anilistStatus
 * @property {string} avatar       Avatar id ('' = colored dot).
 * @property {number} color        Fallback dot color index.
 * @property {boolean} ready
 * @property {boolean} isHost
 * @property {boolean} online
 * @property {Connection | null} connection
 */

/**
 * The authoritative game server. Runs inside the host's browser tab and serves every client,
 * including the host's own (through a loopback connection).
 */
export class HostServer {
  /** @type {Map<string, PlayerRecord>} */ #players = new Map();
  /** @type {Map<Connection, string>} */ #playerIdByConnection = new Map();
  /** @type {Map<Connection, string>} Mid-game newcomers asked for their name → their token. */
  #pendingRejoins = new Map();
  /** @type {Map<Connection, (alive: boolean) => void>} Pending liveness checks. */
  #probes = new Map();
  /** @type {Map<string, Promise<import('../data/anilist.js').ListEntry[]>>} By lowercase user. */
  #anilistCache = new Map();
  #transport;
  #library;
  /** @type {import('../data/avatars.js').Avatar[]} */ #avatars;
  #settings = sanitizeSettings(DEFAULT_SETTINGS);
  #phase = PHASE.LOBBY;
  /** @type {GameSession | null} */ #session = null;
  #lastResults = null;
  #nextPlayerNumber = 1;
  /** @type {Map<string, object>} Autocomplete lists per answer mode (built once). */
  #suggestions = new Map();
  /** Summary of the current song pool shown to players. */
  #poolInfo = null;
  #handlers;

  /**
   * Registers a room code and loads the song library and avatars in parallel.
   * @returns {Promise<HostServer>}
   */
  static async start() {
    const [transport, library, avatars] = await Promise.all([
      HostTransport.create(),
      loadLibrary(),
      loadAvatarCatalog(),
    ]);
    return new HostServer(transport, library, avatars);
  }

  constructor(transport, library, avatars = []) {
    this.#transport = transport;
    this.#library = library;
    this.#avatars = avatars;
    transport.on('connection', (connection) => this.#attach(connection, false));
    this.#handlers = {
      [MSG.PROFILE]: this.#onProfile,
      [MSG.READY]: this.#onReady,
      [MSG.SETTINGS]: this.#onSettings,
      [MSG.START]: this.#onStart,
      [MSG.MOVE]: this.#onMove,
      [MSG.GUESS]: this.#onGuess,
      [MSG.REROLL]: this.#onReroll,
      [MSG.ENTER_DOOR]: this.#onEnterDoor,
      [MSG.RETURN_TO_LOBBY]: this.#onReturnToLobby,
    };
  }

  get code() {
    return this.#transport.code;
  }

  /**
   * Creates the host's own client connection.
   * @returns {Connection} Client side of the loopback pair.
   */
  connectLocal() {
    const [serverSide, clientSide] = createLoopbackPair('local');
    this.#attach(serverSide, true);
    return clientSide;
  }

  shutdown() {
    this.#session?.stop();
    this.#transport.destroy();
  }

  // ------------------------------------------------------------------ connections

  #attach(connection, isLocal) {
    connection.on('message', (message) => this.#route(connection, isLocal, message));
    connection.on('close', () => this.#onDisconnect(connection));
  }

  #route(connection, isLocal, message) {
    try {
      this.#probes.get(connection)?.(true);
      if (message.type === MSG.HELLO) {
        this.#onHello(connection, isLocal, message);
        return;
      }
      if (message.type === MSG.REJOIN) {
        this.#onRejoin(connection, message);
        return;
      }
      const player = this.#players.get(this.#playerIdByConnection.get(connection));
      const handler = this.#handlers[message.type];
      if (player && handler) handler.call(this, player, message);
    } catch (error) {
      console.error('[HostServer] failed to handle', message?.type, error);
    }
  }

  #onHello(connection, isLocal, message) {
    if (message.version !== PROTOCOL_VERSION) {
      this.#reject(connection, 'Your game files are a different version than the host\'s.');
      return;
    }
    const token = cleanString(message.token, 64);
    const returning = token && [...this.#players.values()].find((p) => p.token === token);
    if (returning && !returning.isHost) {
      this.#reclaim(returning, connection, token);
      return;
    }
    if (this.#phase !== PHASE.LOBBY) {
      // Lost players come back from a new tab or device: they prove who they are by name.
      this.#pendingRejoins.set(connection, token);
      connection.send({ type: MSG.REJOIN_PROMPT, error: '' });
      return;
    }
    if (this.#players.size >= MAX_PLAYERS) {
      this.#reject(connection, `The room is full (${MAX_PLAYERS} players).`);
      return;
    }
    const player = this.#createPlayer(token, isLocal, message);
    this.#players.set(player.id, player);
    this.#refreshAniList(player);
    this.#bind(player, connection);
  }

  /**
   * Mid-game: a newcomer names the disconnected player they were.
   * @param {Connection} connection
   * @param {{ name?: unknown }} message
   */
  #onRejoin(connection, message) {
    if (!this.#pendingRejoins.has(connection) || this.#phase === PHASE.LOBBY) return;
    const name = normalizeText(cleanString(message.name, NAME_MAX_LENGTH));
    const player = name && [...this.#players.values()]
      .find((p) => !p.isHost && normalizeText(p.name) === name
        && (!this.#session || this.#session.players.has(p.id)));
    if (!player) {
      connection.send({ type: MSG.REJOIN_PROMPT, error: 'Nobody with this name played in this game.' });
      return;
    }
    this.#reclaim(player, connection, this.#pendingRejoins.get(connection));
  }

  /**
   * Gives a player slot to a new connection. If the host still thinks the player is online,
   * their old connection must fail a ping first (a dead link the host has not noticed yet).
   */
  async #reclaim(player, connection, token) {
    if (player.online && player.connection && await this.#isAlive(player.connection)) {
      if (this.#pendingRejoins.has(connection)) {
        connection.send({ type: MSG.REJOIN_PROMPT, error: `${player.name} is still connected.` });
      } else {
        this.#reject(connection, 'This player is already connected in another window.');
      }
      return;
    }
    if (connection.closed) return;
    const stale = player.connection;
    if (stale) {
      this.#playerIdByConnection.delete(stale);
      stale.close();
    }
    this.#pendingRejoins.delete(connection);
    if (token) player.token = token;
    this.#bind(player, connection);
  }

  /** Resolves true if the connection answers a ping within REJOIN_PROBE_MS. */
  #isAlive(connection) {
    if (connection.closed) return Promise.resolve(false);
    return new Promise((resolve) => {
      const finish = (alive) => {
        clearTimeout(timer);
        this.#probes.delete(connection);
        resolve(alive);
      };
      const timer = setTimeout(() => finish(false), REJOIN_PROBE_MS);
      this.#probes.set(connection, finish);
      connection.send({ type: MSG.PING });
    });
  }

  #createPlayer(token, isHost, message) {
    const number = this.#nextPlayerNumber++;
    const id = `p${number}`;
    return {
      id,
      token,
      name: cleanString(message.name, NAME_MAX_LENGTH) || `Operator-${number}`,
      anilist: cleanString(message.anilist, ANILIST_NAME_MAX_LENGTH),
      statuses: this.#cleanStatuses(message.statuses),
      anilistStatus: { state: 'none', count: 0, error: '' },
      avatar: this.#cleanAvatar(message.avatar),
      color: (number - 1) % PLAYER_COLOR_COUNT,
      ready: isHost,
      isHost,
      online: true,
      connection: null,
    };
  }

  #bind(player, connection) {
    player.connection = connection;
    player.online = true;
    this.#playerIdByConnection.set(connection, player.id);
    connection.send({ type: MSG.WELCOME, playerId: player.id, isHost: player.isHost, code: this.code });
    connection.send({ type: MSG.AVATARS, avatars: this.#avatars });
    this.#broadcastLobby();
    if (this.#phase === PHASE.PLAYING) {
      this.#session?.setOnline(player.id, true);
      this.#sendGameState(player);
      for (const other of this.#players.values()) {
        if (other !== player) this.#notice(other, `${player.name} reconnected.`, 'info');
      }
      this.#broadcast({ type: MSG.LEADERBOARD, entries: this.#leaderboard() });
    }
    if (this.#phase === PHASE.RESULTS) connection.send({ type: MSG.GAME_END, results: this.#lastResults });
  }

  #reject(connection, message) {
    connection.send({ type: MSG.ERROR, message, fatal: true });
    setTimeout(() => connection.close(), 500);
  }

  #onDisconnect(connection) {
    this.#pendingRejoins.delete(connection);
    this.#probes.get(connection)?.(false);
    const playerId = this.#playerIdByConnection.get(connection);
    this.#playerIdByConnection.delete(connection);
    const player = this.#players.get(playerId);
    if (!player || player.connection !== connection) return;
    player.online = false;
    player.connection = null;
    if (this.#phase === PHASE.LOBBY) this.#players.delete(playerId);
    this.#broadcastLobby();
    if (this.#session) {
      this.#session.setOnline(playerId, false);
      this.#broadcast({ type: MSG.LEADERBOARD, entries: this.#leaderboard() });
      this.#broadcastPositions();
    }
  }

  #send(playerId, message) {
    this.#players.get(playerId)?.connection?.send(message);
  }

  #broadcast(message) {
    for (const player of this.#players.values()) player.connection?.send(message);
  }

  #notice(player, message, kind = 'error') {
    player.connection?.send({ type: MSG.NOTICE, message, kind });
  }

  // ------------------------------------------------------------------ lobby

  #lobbyView() {
    return {
      code: this.code,
      phase: this.#phase,
      settings: this.#settings,
      players: [...this.#players.values()].map((player) => ({
        id: player.id,
        name: player.name,
        anilist: player.anilist,
        statuses: [...player.statuses],
        anilistStatus: { ...player.anilistStatus },
        avatar: player.avatar,
        color: player.color,
        ready: player.ready,
        isHost: player.isHost,
        online: player.online,
      })),
    };
  }

  #broadcastLobby() {
    this.#broadcast({ type: MSG.LOBBY, lobby: this.#lobbyView() });
  }

  #onProfile(player, message) {
    if (this.#phase !== PHASE.LOBBY) return;
    player.name = cleanString(message.name, NAME_MAX_LENGTH) || player.name;
    player.avatar = this.#cleanAvatar(message.avatar);
    const anilist = cleanString(message.anilist, ANILIST_NAME_MAX_LENGTH);
    const statuses = this.#cleanStatuses(message.statuses);
    if (anilist !== player.anilist || statuses.join() !== player.statuses.join()) {
      player.anilist = anilist;
      player.statuses = statuses;
      this.#refreshAniList(player);
    }
    this.#broadcastLobby();
  }

  #cleanAvatar(value) {
    return this.#avatars.some((avatar) => avatar.id === value) ? value : '';
  }

  #cleanStatuses(value) {
    if (!Array.isArray(value)) return [...DEFAULT_LIST_STATUSES];
    return LIST_STATUSES.map((status) => status.key).filter((key) => value.includes(key));
  }

  /** Every entry of a user's list (cached; failures are retried next time). */
  #anilistEntries(userName) {
    const key = userName.toLowerCase();
    if (!this.#anilistCache.has(key)) {
      const request = fetchAnimeList(userName);
      request.catch(() => this.#anilistCache.delete(key));
      this.#anilistCache.set(key, request);
    }
    return this.#anilistCache.get(key);
  }

  /** AniList media ids of a player's list, limited to the statuses they picked. */
  async #playerListIds(player) {
    return filterByStatus(await this.#anilistEntries(player.anilist), player.statuses);
  }

  async #refreshAniList(player) {
    const userName = player.anilist;
    const statuses = player.statuses;
    if (!userName) {
      player.anilistStatus = { state: 'none', count: 0, error: '' };
      return;
    }
    player.anilistStatus = { state: 'checking', count: 0, error: '' };
    try {
      const ids = await this.#playerListIds(player);
      if (player.anilist !== userName || player.statuses !== statuses) return;
      player.anilistStatus = { state: 'ok', count: ids.length, error: '' };
    } catch (error) {
      if (player.anilist !== userName) return;
      player.anilistStatus = { state: 'error', count: 0, error: error.message };
    }
    this.#broadcastLobby();
  }

  #onReady(player, message) {
    if (this.#phase !== PHASE.LOBBY || player.isHost) return;
    player.ready = Boolean(message.ready);
    this.#broadcastLobby();
  }

  #onSettings(player, message) {
    if (this.#phase !== PHASE.LOBBY || !player.isHost) return;
    this.#settings = sanitizeSettings(message.settings, this.#settings);
    this.#broadcastLobby();
  }

  // ------------------------------------------------------------------ game lifecycle

  /**
   * Host only. When the pool is too small for every floor, the host is asked (POOL_SHORTAGE)
   * and starts again with `message.shortage` set to their choice.
   */
  async #onStart(player, message) {
    if (this.#phase !== PHASE.LOBBY || !player.isHost) return;
    const waiting = [...this.#players.values()].filter((p) => p.online && !p.ready);
    if (waiting.length > 0) {
      this.#notice(player, `Waiting for: ${waiting.map((p) => p.name).join(', ')}`);
      return;
    }
    const shortage = Object.hasOwn(SHORTAGE_CHOICES, message.shortage) ? message.shortage : null;

    this.#phase = PHASE.LOADING;
    this.#broadcastLobby();
    try {
      this.#broadcast({ type: MSG.LOADING, message: 'Loading AniList lists…' });
      const { pool, fillPool } = await this.#buildPools();
      const needed = songsNeeded(this.#settings);
      const canFill = fillPool.songs.length > pool.songs.length;
      // Not worth asking when the pool is unplayable anyway: the error below explains it.
      const worthAsking = canFill || pool.songs.length >= MIN_SONGS_PER_TAG;
      if (pool.songs.length < needed && !shortage && worthAsking) {
        this.#phase = PHASE.LOBBY;
        this.#broadcastLobby();
        player.connection?.send({
          type: MSG.POOL_SHORTAGE,
          songCount: pool.songs.length,
          needed,
          canFill,
          fromLists: pool.fromLists,
        });
        return;
      }
      const filling = shortage === 'fill' && canFill;
      const usable = filling ? fillPool.songs.length : pool.songs.length;
      if (usable < MIN_SONGS_PER_TAG) {
        throw new Error(`Only ${usable} songs match your lists and settings. ` +
          'Add more song types, AniList accounts or seasons.');
      }
      this.#broadcast({ type: MSG.LOADING, message: 'Generating the dungeon…' });
      this.#beginSession(pool, filling ? fillPool : null);
    } catch (error) {
      this.#phase = PHASE.LOBBY;
      this.#broadcast({ type: MSG.ERROR, message: error.message, fatal: false });
      this.#broadcastLobby();
    }
  }

  /**
   * The game's pool (players' lists, or the whole library) and the fill pool (the whole library
   * with the same song types and seasons), both limited by the settings.
   */
  async #buildPools() {
    const players = [...this.#players.values()].filter((p) => p.online && p.anilist);
    const lists = await Promise.allSettled(players.map((p) => this.#playerListIds(p)));
    const aniListIds = [...new Set(lists.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])))];

    const options = { songTypes: this.#settings.songTypes, seasons: seasonBounds(this.#settings) };
    const fillPool = new SongPool(this.#library, { ...options, aniListIds: null });
    if (aniListIds.length === 0) return { pool: fillPool, fillPool };
    return { pool: new SongPool(this.#library, { ...options, aniListIds }), fillPool };
  }

  #beginSession(pool, fillPool) {
    const players = [...this.#players.values()].filter((p) => p.online);
    this.#session = new GameSession({ pool, fillPool, settings: this.#settings, players });
    const mode = this.#settings.answerMode;
    if (!this.#suggestions.has(mode)) this.#suggestions.set(mode, pool.suggestions(mode));
    this.#poolInfo = {
      fromLists: pool.fromLists,
      filled: fillPool !== null,
      songCount: pool.songs.length,
      tagCount: pool.eligibleTags().length,
    };

    this.#session.on('floor', () => {
      for (const player of players) this.#sendRun(player.id);
    });
    this.#session.on('player', (playerId) => this.#sendRun(playerId));
    this.#session.on('positions', () => this.#broadcastPositions());
    this.#session.on('result', (playerId, result) => {
      this.#send(playerId, { type: MSG.CHALLENGE_RESULT, result });
    });
    this.#session.on('announce', (message) => {
      for (const player of players) this.#notice(player, message, 'info');
    });
    this.#session.on('leaderboard', () => {
      this.#broadcast({ type: MSG.LEADERBOARD, entries: this.#leaderboard() });
    });
    this.#session.on('end', (results) => this.#onSessionEnd(results));

    this.#phase = PHASE.PLAYING;
    this.#session.start();
    this.#broadcastLobby();
    for (const player of players) this.#sendGameState(player);
  }

  #broadcastPositions() {
    this.#broadcast({ type: MSG.POSITIONS, players: this.#session.positions() });
  }

  #sendGameState(player) {
    if (!this.#session?.players.has(player.id)) return;
    player.connection?.send({
      type: MSG.GAME_START,
      settings: this.#session.settings,
      remainingMs: this.#session.remainingMs(),
      pool: this.#poolInfo,
      suggestions: this.#suggestions.get(this.#session.settings.answerMode),
    });
    this.#sendRun(player.id);
    player.connection?.send({ type: MSG.LEADERBOARD, entries: this.#leaderboard() });
  }

  #sendRun(playerId) {
    this.#send(playerId, { type: MSG.RUN, run: this.#session.viewFor(playerId) });
  }

  #leaderboard() {
    if (!this.#session) return [];
    return this.#session.leaderboard().map((entry) => ({
      ...entry,
      online: this.#players.get(entry.id)?.online ?? false,
    }));
  }

  #onSessionEnd(results) {
    this.#phase = PHASE.RESULTS;
    this.#lastResults = results;
    this.#broadcast({ type: MSG.GAME_END, results });
    this.#broadcastLobby();
  }

  /** Host only: from the results or mid-game, everyone goes back to the lobby (same room code). */
  #onReturnToLobby(player) {
    const canReturn = this.#phase === PHASE.RESULTS || this.#phase === PHASE.PLAYING;
    if (!player.isHost || !canReturn) return;
    if (this.#phase === PHASE.PLAYING) {
      this.#session.stop();
      for (const other of this.#players.values()) {
        if (other !== player) this.#notice(other, `${player.name} ended the expedition and returned to the lobby.`, 'info');
      }
    }
    this.#session = null;
    this.#lastResults = null;
    this.#phase = PHASE.LOBBY;
    for (const [id, other] of this.#players) {
      if (!other.online) this.#players.delete(id);
      else other.ready = other.isHost;
    }
    this.#broadcastLobby();
  }

  // ------------------------------------------------------------------ gameplay

  #playing() {
    return this.#phase === PHASE.PLAYING && this.#session !== null;
  }

  #reportFailure(player, outcome) {
    if (!outcome.ok) this.#notice(player, outcome.error);
  }

  #onMove(player, message) {
    if (!this.#playing()) return;
    this.#reportFailure(player, this.#session.move(player.id, message.x, message.y));
  }

  #onGuess(player, message) {
    if (!this.#playing()) return;
    const { text, song, artist } = message;
    this.#sendChallengeOutcome(player, this.#session.guess(player.id, { text, song, artist }));
  }

  #onReroll(player) {
    if (!this.#playing()) return;
    this.#sendChallengeOutcome(player, this.#session.reroll(player.id));
  }

  #sendChallengeOutcome(player, outcome) {
    if (!outcome.ok) {
      this.#notice(player, outcome.error);
      return;
    }
    player.connection?.send({ type: MSG.CHALLENGE_RESULT, result: outcome.result });
  }

  #onEnterDoor(player, message) {
    if (!this.#playing()) return;
    this.#reportFailure(player, this.#session.enterDoor(player.id, Number(message.areaIndex)));
  }
}
