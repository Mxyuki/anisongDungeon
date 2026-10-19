import { DEFAULT_LIST_STATUSES, STORAGE_KEYS } from '../config.js';
import { Emitter } from '../core/emitter.js';
import { MSG, PHASE, PROTOCOL_VERSION } from '../net/protocol.js';
import { connectToRoom } from '../net/transport.js';

/** @typedef {import('./store.js').Store} Store */
/** @typedef {import('../net/transport.js').Connection} Connection */

/** Storage can be missing or blocked (private mode, tests); the app must work without it. */
const STORAGES = { local: () => globalThis.localStorage, session: () => globalThis.sessionStorage };

function readStorage(kind, key, fallback) {
  try {
    const value = STORAGES[kind]().getItem(key);
    return value === null ? fallback : JSON.parse(value);
  } catch {
    return fallback;
  }
}

function writeStorage(kind, key, value) {
  try {
    STORAGES[kind]().setItem(key, JSON.stringify(value));
  } catch {
    // Not persisted; fine.
  }
}

/** Per-tab token so a refreshed tab can reclaim its player slot mid-game. */
function getClientToken() {
  let token = readStorage('session', STORAGE_KEYS.clientToken, null);
  if (!token) {
    token = crypto.randomUUID();
    writeStorage('session', STORAGE_KEYS.clientToken, token);
  }
  return token;
}

/**
 * Client-side endpoint: sends player intents to the server and turns server messages into
 * store updates. Emits `notice` (string) for transient messages.
 */
export class GameClient extends Emitter {
  /** @type {Store} */ #store;
  /** @type {Connection | null} */ #connection = null;
  #resultSeq = 0;

  /** @param {Store} store */
  constructor(store) {
    super();
    this.#store = store;
  }

  /** Saved profile: { name, anilist, statuses, avatar }. */
  get savedProfile() {
    const saved = readStorage('local', STORAGE_KEYS.profile, {});
    return {
      name: saved.name ?? '',
      anilist: saved.anilist ?? '',
      statuses: Array.isArray(saved.statuses) ? saved.statuses : [...DEFAULT_LIST_STATUSES],
      avatar: saved.avatar ?? '',
    };
  }

  /**
   * Joins a remote host by room code.
   * @param {string} code
   */
  async join(code) {
    this.#store.set({ roomCode: code });
    this.#setConnection('connecting');
    try {
      this.attach(await connectToRoom(code));
    } catch (error) {
      this.#setConnection('error', error.message);
    }
  }

  /**
   * Uses an already-open connection (the host's loopback, or a joined room).
   * @param {Connection} connection
   */
  attach(connection) {
    this.#connection = connection;
    connection.on('message', (message) => this.#handleMessage(message));
    connection.on('close', () => {
      if (this.#store.state.connection.status !== 'error') {
        this.#setConnection('closed', 'Connection to the host was lost.');
      }
    });
    this.#send({ type: MSG.HELLO, version: PROTOCOL_VERSION, token: getClientToken(), ...this.savedProfile });
  }

  /**
   * Reports a failure that happened before any connection existed (host boot).
   * @param {string} message
   */
  fail(message) {
    this.#setConnection('error', message);
  }

  #setConnection(status, error = '') {
    this.#store.set({ connection: { status, error }, rejoin: null });
  }

  #send(message) {
    this.#connection?.send(message);
  }

  // ------------------------------------------------------------------ actions

  /**
   * Saves and sends profile changes (missing fields keep their saved value).
   * @param {Partial<{name: string, anilist: string, statuses: string[], avatar: string}>} changes
   */
  setProfile(changes) {
    const profile = { ...this.savedProfile, ...changes };
    writeStorage('local', STORAGE_KEYS.profile, profile);
    this.#send({ type: MSG.PROFILE, ...profile });
  }

  /** @param {boolean} ready */
  setReady(ready) {
    this.#send({ type: MSG.READY, ready });
  }

  /** @param {object} settings  Partial settings; the server merges and validates. */
  updateSettings(settings) {
    this.#send({ type: MSG.SETTINGS, settings });
  }

  /**
   * Host: starts the game. After a POOL_SHORTAGE, `shortage` carries the host's choice.
   * @param {string} [shortage]  A SHORTAGE_CHOICES key.
   */
  startGame(shortage) {
    this.#store.set({ poolShortage: null });
    this.#send({ type: MSG.START, shortage });
  }

  /** Host: closes the pool shortage prompt without starting. */
  dismissShortage() {
    this.#store.set({ poolShortage: null });
  }

  /** Moves the player's character onto an adjacent cell. */
  move(x, y) {
    this.#send({ type: MSG.MOVE, x, y });
  }

  /**
   * Sends an answer: `{ text }` in anime mode, `{ song, artist }` in S/A mode.
   * @param {{ text?: string, song?: string, artist?: string }} answer
   */
  guess(answer) {
    this.#send({ type: MSG.GUESS, ...answer });
  }

  reroll() {
    this.#send({ type: MSG.REROLL });
  }

  /**
   * Votes for a door (or withdraws the vote when it is already this door). Alone, opens it.
   * @param {number} areaIndex
   */
  enterDoor(areaIndex) {
    this.#send({ type: MSG.ENTER_DOOR, areaIndex });
  }

  returnToLobby() {
    this.#send({ type: MSG.RETURN_TO_LOBBY });
  }

  /**
   * Mid-game join: claims the slot of the disconnected player with this name.
   * @param {string} name
   */
  rejoin(name) {
    this.#store.set({ rejoin: { error: '', pending: true } });
    this.#send({ type: MSG.REJOIN, name });
  }

  // ------------------------------------------------------------------ server messages

  #handleMessage(message) {
    const handler = this.#messageHandlers[message.type];
    if (handler) handler(message);
  }

  #messageHandlers = {
    [MSG.WELCOME]: ({ playerId, isHost }) => {
      this.#store.set({ playerId, isHost, connection: { status: 'connected', error: '' }, rejoin: null });
    },
    [MSG.REJOIN_PROMPT]: ({ error }) => {
      this.#store.set({ rejoin: { error: typeof error === 'string' ? error : '', pending: false } });
    },
    [MSG.PING]: () => this.#send({ type: MSG.PONG }),
    [MSG.AVATARS]: ({ avatars }) => this.#store.set({ avatars }),
    [MSG.POSITIONS]: ({ players }) => {
      const { run } = this.#store.state;
      if (run) this.#store.set({ run: { ...run, players } });
    },
    [MSG.LOBBY]: ({ lobby }) => {
      const patch = { lobby };
      if (lobby.phase === PHASE.LOBBY) Object.assign(patch, { game: null, run: null, results: null });
      this.#store.set(patch);
    },
    [MSG.LOADING]: ({ message }) => this.#store.set({ loadingMessage: message }),
    [MSG.POOL_SHORTAGE]: ({ songCount, needed, canFill, fromLists }) => {
      this.#store.set({
        poolShortage: {
          songCount: Number(songCount) || 0,
          needed: Number(needed) || 0,
          canFill: Boolean(canFill),
          fromLists: Boolean(fromLists),
        },
      });
    },
    [MSG.GAME_START]: ({ settings, remainingMs, pool, suggestions }) => {
      this.#store.set({
        game: { settings, pool, suggestions, endsAt: Date.now() + remainingMs },
        results: null,
        lastResult: null,
      });
    },
    [MSG.RUN]: ({ run }) => {
      const { game, run: previous } = this.#store.state;
      // Keep the first deadline of a roll so later updates do not restart its animation.
      const sameRoll = run.doorRoll && previous?.doorRoll?.id === run.doorRoll.id;
      const doorRoll = run.doorRoll && {
        ...run.doorRoll,
        endsAt: sameRoll ? previous.doorRoll.endsAt : Date.now() + run.doorRoll.remainingMs,
      };
      this.#store.set({
        run: {
          ...run,
          doorRoll,
          rerollAt: run.rerollInMs === null ? null : Date.now() + run.rerollInMs,
        },
        game: game && { ...game, endsAt: Date.now() + run.remainingMs },
      });
    },
    [MSG.CHALLENGE_RESULT]: ({ result }) => {
      this.#store.set({ lastResult: { ...result, seq: ++this.#resultSeq } });
    },
    [MSG.LEADERBOARD]: ({ entries }) => this.#store.set({ leaderboard: entries }),
    [MSG.GAME_END]: ({ results }) => this.#store.set({ results }),
    [MSG.NOTICE]: ({ message, kind }) => this.emit('notice', message, kind ?? 'error'),
    [MSG.ERROR]: ({ message, fatal }) => {
      if (fatal) this.#setConnection('error', message);
      else this.emit('notice', message, 'error');
    },
  };
}
