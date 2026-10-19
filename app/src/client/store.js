import { Emitter } from '../core/emitter.js';

/**
 * @typedef {object} ClientState
 * @property {'host' | 'join'} mode
 * @property {{status: 'idle'|'connecting'|'connected'|'closed'|'error', error: string}} connection
 * @property {string} roomCode            Last room code joined (prefilled after a disconnect).
 * @property {{error: string, pending: boolean} | null} rejoin  Set while the host asks for the
 *   name of the disconnected player this client was (mid-game join).
 * @property {string | null} playerId
 * @property {boolean} isHost
 * @property {object | null} lobby          Server lobby view.
 * @property {{id: string, name: string, url: string}[]} avatars  Catalog sent by the host.
 * @property {string} loadingMessage
 * @property {{songCount: number, needed: number, canFill: boolean, fromLists: boolean} | null}
 *   poolShortage  Host only: the pool is too small for every floor; the lobby asks what to do.
 * @property {object | null} game           { settings, endsAt, pool, suggestions }
 * @property {object | null} run            Server view (map, own dot, everyone's dots) + `rerollAt`.
 * @property {object[]} leaderboard
 * @property {object | null} lastResult     Latest challenge result (correct/wrong/rerolled) + `seq`.
 * @property {object | null} results        Final results.
 */

/** @returns {ClientState} */
export function createInitialState(mode) {
  return {
    mode,
    connection: { status: 'idle', error: '' },
    roomCode: '',
    rejoin: null,
    playerId: null,
    isHost: false,
    lobby: null,
    avatars: [],
    loadingMessage: '',
    poolShortage: null,
    game: null,
    run: null,
    leaderboard: [],
    lastResult: null,
    results: null,
  };
}

/**
 * Holds client state. Only GameClient writes to it; the UI reads and subscribes.
 */
export class Store extends Emitter {
  /** @type {ClientState} */ #state;

  /** @param {ClientState} initialState */
  constructor(initialState) {
    super();
    this.#state = initialState;
  }

  /** @returns {ClientState} */
  get state() {
    return this.#state;
  }

  /**
   * Shallow-merges a patch and notifies subscribers.
   * @param {Partial<ClientState>} patch
   */
  set(patch) {
    this.#state = { ...this.#state, ...patch };
    this.emit('change', this.#state);
  }

  /**
   * @param {(state: ClientState) => void} listener
   * @returns {() => void}
   */
  subscribe(listener) {
    return this.on('change', listener);
  }
}
