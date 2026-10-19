/**
 * One player's personal state during a game: where their dot is, their rerolls and their score.
 * The map and progress are shared (see Expedition).
 */
export class PlayerState {
  /** Cell index of the player's dot. */
  position = 0;
  rerolls;
  /** @type {number | null} */ nextRerollAt;
  /** songsFound / artistsFound: S/A parts this player found (the artist counts for whoever
   * completes it: its name, an alias, or the last missing group member). */
  stats = { guessed: 0, rerollsUsed: 0, songsFound: 0, artistsFound: 0 };
  /** Connected right now (only online players vote for doors). */
  online = true;

  /**
   * @param {object} options
   * @param {string} options.playerId
   * @param {string} options.name
   * @param {string} options.avatar   Avatar id ('' = colored dot).
   * @param {number} options.color    Fallback dot color index.
   * @param {number} options.position
   * @param {number} options.rerolls
   * @param {number | null} options.nextRerollAt
   */
  constructor({ playerId, name, avatar, color, position, rerolls, nextRerollAt }) {
    this.playerId = playerId;
    this.name = name;
    this.avatar = avatar;
    this.color = color;
    this.position = position;
    this.rerolls = rerolls;
    this.nextRerollAt = nextRerollAt;
  }

  /** Public identity shown to other players. */
  get identity() {
    return {
      id: this.playerId, name: this.name, avatar: this.avatar, color: this.color, online: this.online,
    };
  }
}
