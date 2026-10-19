/**
 * Wire protocol: message names and phases. Every message is `{ type: MSG.X, ...payload }`.
 * Bump PROTOCOL_VERSION whenever a message shape changes.
 */

export const PROTOCOL_VERSION = 8;

export const MSG = Object.freeze({
  // client → server
  HELLO: 'hello',
  PROFILE: 'profile',
  READY: 'ready',
  SETTINGS: 'settings',
  /** Optional `shortage` (SHORTAGE_CHOICES key): the host's answer to POOL_SHORTAGE. */
  START: 'start',
  MOVE: 'move',
  GUESS: 'guess',
  REROLL: 'reroll',
  /** Votes for a door (clicking the voted door again withdraws the vote). */
  ENTER_DOOR: 'door:enter',
  RETURN_TO_LOBBY: 'lobby:return',
  /** Host only, lobby: removes a player from the room. */
  KICK: 'player:kick',
  /** Host only, lobby: includes or leaves out one player's AniList in the song pool. */
  SET_ANILIST: 'player:anilist',
  /**
   * Mid-game join from a new tab/device: `{ name, avatar }`. Claims the disconnected player with
   * that name, or joins as a new player when the host allows late joins.
   */
  REJOIN: 'rejoin',
  PONG: 'pong',

  // server → client
  WELCOME: 'welcome',
  AVATARS: 'avatars',
  LOBBY: 'lobby',
  LOADING: 'loading',
  GAME_START: 'game:start',
  /** To the host: the pool has fewer songs than the floors need; start again with a choice. */
  POOL_SHORTAGE: 'pool:shortage',
  RUN: 'run',
  POSITIONS: 'positions',
  CHALLENGE_RESULT: 'challenge:result',
  LEADERBOARD: 'leaderboard',
  GAME_END: 'game:end',
  NOTICE: 'notice',
  /**
   * A game is running and this client is unknown: `{ error, canJoin }`. Ask for the name of a
   * disconnected player, or (canJoin) a name and avatar to join as a new player.
   */
  REJOIN_PROMPT: 'rejoin:prompt',
  /** Liveness check of a connection someone tries to take over. */
  PING: 'ping',
  ERROR: 'error',
});

export const PHASE = Object.freeze({
  LOBBY: 'lobby',
  LOADING: 'loading',
  PLAYING: 'playing',
  RESULTS: 'results',
});
