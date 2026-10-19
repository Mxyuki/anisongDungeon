import { DEFAULT_SETTINGS } from '../config.js';
import { cellIndex, getVisibleCells, NEUTRAL_AREA, VOID_AREA } from '../game/dungeon.js';

/** @typedef {import('../game/types.js').Floor} Floor */
/** @typedef {import('../game/types.js').Song} Song */

/**
 * The song waiting on an unexplored tile, shared by every player standing on it. It stays the
 * same until it is guessed or rerolled.
 * @typedef {object} TileSong
 * @property {Song} song              Secret: never sent to clients.
 * @property {string | null} tag
 * @property {number} startFraction
 * @property {number} id              Unique per assignment (lets clients restart audio).
 */

/**
 * S/A mode: what the team already found about a tile's song. Kept until the tile is explored or
 * its song rerolled, so teammates can finish what someone started.
 * @typedef {object} TileProgress
 * @property {boolean} song
 * @property {boolean} artist             The artist/group or an alias, or every member, named.
 * @property {Set<number>} members        Indices of the group members already named.
 * @property {number} memberCount
 * @property {Set<string>} contributors   Players who found a part (all score when solved).
 */

/**
 * The team's shared progress on the current floor: explored tiles, tile songs, keys and doors.
 * Holds state only; rules live in GameSession.
 */
export class Expedition {
  /** @type {Floor | null} */ floor = null;
  /** Songs guessed in an area before its key and door are shown (host setting revealAfter). */
  revealAfter = DEFAULT_SETTINGS.revealAfter;
  floorNumber = 1;
  /** @type {Set<number>} */ cleared = new Set();
  /** @type {Map<number, TileSong>} */ tileSongs = new Map();
  /** @type {Map<number, TileProgress>} */ tileProgress = new Map();
  /** @type {Map<number, object>} Revealed answer of each explored tile (shown when standing on it). */
  solvedAnswers = new Map();
  /** @type {Map<number, string[]>} Names of the players who solved each explored tile. */
  solvers = new Map();
  /** @type {Map<number, { song: Song, by: string }[]>} Songs rerolled away on each tile, in order. */
  rerolledSongs = new Map();
  /** @type {Set<number>} Sectors whose outline the team has uncovered. */
  discoveredAreas = new Set();
  /** @type {Record<number, number>} Correct guesses per area (neutral included) on this floor. */
  areaGuesses = {};
  /** @type {Set<number>} Sectors whose key was picked up. */
  collectedKeys = new Set();
  /** @type {Set<number>} Areas (neutral included) whose door was explored. */
  foundDoors = new Set();
  /** @type {Map<string, number>} Player id → area index of the door they vote for. */
  doorVotes = new Map();
  /**
   * Tie between doors: the winner is drawn now, clients animate the roll until `resolveAt`.
   * @type {{ id: number, candidates: number[], winner: number, resolveAt: number } | null}
   */
  doorRoll = null;
  /** @type {Set<number>} Songs already served this game (avoids repeats). */
  playedSongIds = new Set();
  /** @type {Map<number, number>} Times each song was served this game (repeats go to the least played). */
  #songPlays = new Map();
  /** @type {Map<number, Map<number, number>>} Area → anime id → songs served there this floor. */
  #animePlays = new Map();
  challengeCount = 0;
  /** @type {number | null} */ finishedAt = null;

  get finished() {
    return this.finishedAt !== null;
  }

  get keys() {
    return this.collectedKeys.size;
  }

  /** Cell index of the floor's entrance. */
  get startIndex() {
    return cellIndex(this.floor.start.x, this.floor.start.y, this.floor.size);
  }

  /** @param {Floor} floor */
  enterFloor(floor) {
    this.floor = floor;
    this.floorNumber = floor.number;
    this.cleared = new Set([cellIndex(floor.start.x, floor.start.y, floor.size)]);
    this.tileSongs.clear();
    this.tileProgress.clear();
    this.solvedAnswers.clear();
    this.solvers.clear();
    this.rerolledSongs.clear();
    this.discoveredAreas.clear();
    this.areaGuesses = Object.fromEntries(
      [NEUTRAL_AREA, ...floor.areas.map((area) => area.index)].map((index) => [index, 0]),
    );
    this.collectedKeys.clear();
    this.foundDoors.clear();
    this.doorVotes.clear();
    this.doorRoll = null;
    this.#animePlays.clear();
  }

  /**
   * How many songs of an anime were already served in an area on this floor.
   * @param {number} areaIndex
   * @param {number} animeId
   */
  animePlayCount(areaIndex, animeId) {
    return this.#animePlays.get(areaIndex)?.get(animeId) ?? 0;
  }

  /**
   * How many times a song was served this game, every floor included.
   * @param {number} songId
   */
  songPlayCount(songId) {
    return this.#songPlays.get(songId) ?? 0;
  }

  /**
   * Remembers that a song was served on a tile of an area.
   * @param {number} areaIndex
   * @param {Song} song
   */
  recordPlay(areaIndex, song) {
    this.playedSongIds.add(song.id);
    this.#songPlays.set(song.id, (this.#songPlays.get(song.id) ?? 0) + 1);
    if (!this.#animePlays.has(areaIndex)) this.#animePlays.set(areaIndex, new Map());
    const plays = this.#animePlays.get(areaIndex);
    plays.set(song.animeId, (plays.get(song.animeId) ?? 0) + 1);
  }

  /**
   * Remembers a song that was rerolled away (shown in the post-game map review).
   * @param {number} index
   * @param {Song} song
   * @param {string} by  Name of the player who rerolled.
   */
  recordReroll(index, song, by) {
    if (!this.rerolledSongs.has(index)) this.rerolledSongs.set(index, []);
    this.rerolledSongs.get(index).push({ song, by });
  }

  /**
   * @param {number} floorNumber  The last floor played (its door led to the summit).
   * @param {number} now
   */
  finish(floorNumber, now) {
    this.floorNumber = floorNumber;
    this.finishedAt = now;
    this.tileSongs.clear();
    this.doorVotes.clear();
    this.doorRoll = null;
  }

  /**
   * The team's S/A progress on a tile, created on first use.
   * @param {number} index
   * @param {number} memberCount
   * @returns {TileProgress}
   */
  progressFor(index, memberCount) {
    if (!this.tileProgress.has(index)) {
      this.tileProgress.set(index, {
        song: false, artist: false, members: new Set(), memberCount, contributors: new Set(),
      });
    }
    return this.tileProgress.get(index);
  }

  /** @param {number} index */
  isWalkable(index) {
    return this.floor.cells[index].areaIndex !== VOID_AREA;
  }

  /** @param {number} areaIndex  Sector index or NEUTRAL_AREA. */
  isAreaRevealed(areaIndex) {
    return this.areaGuesses[areaIndex] >= this.revealAfter;
  }

  /**
   * Marks a cell explored for the whole team and collects what it holds.
   * @param {number} index
   * @param {object} [answer]  Revealed song info, shown to players standing on the tile later.
   * @returns {'key' | 'door' | null}
   */
  clearCell(index, answer = null) {
    const cell = this.floor.cells[index];
    this.cleared.add(index);
    this.tileSongs.delete(index);
    this.tileProgress.delete(index);
    if (answer) this.solvedAnswers.set(index, answer);
    this.areaGuesses[cell.areaIndex]++;
    if (cell.areaIndex >= 0) this.discoveredAreas.add(cell.areaIndex);
    if (cell.content === 'key') this.collectedKeys.add(cell.areaIndex);
    if (cell.content === 'door') this.foundDoors.add(cell.areaIndex);
    return cell.content === 'key' || cell.content === 'door' ? cell.content : null;
  }

  /**
   * Client-safe map: fog of war applied (the team sees explored tiles and their surroundings).
   * @param {number[]} occupied  Cells where players stand (always visible).
   * @param {(tag: string | null) => string | null} [tagLabel]  How themes are shown to players.
   */
  gridView(occupied, tagLabel = (tag) => tag) {
    const { floor } = this;
    const visible = getVisibleCells(floor, this.cleared);
    occupied.forEach((index) => visible.add(index));
    return {
      size: floor.size,
      cells: floor.cells.map((cell, index) => this.#cellView(cell, index, visible)),
      areas: floor.areas.map((area) => ({
        ...area,
        tag: tagLabel(area.tag),
        discovered: this.discoveredAreas.has(area.index),
        guesses: this.areaGuesses[area.index],
        revealed: this.isAreaRevealed(area.index),
        keyCollected: this.collectedKeys.has(area.index),
        doorFound: this.foundDoors.has(area.index),
      })),
      center: {
        guesses: this.areaGuesses[NEUTRAL_AREA],
        revealed: this.isAreaRevealed(NEUTRAL_AREA),
        doorFound: this.foundDoors.has(NEUTRAL_AREA),
      },
      doors: floor.doors
        .filter((door) => this.foundDoors.has(door.areaIndex))
        .map((door) => ({
          areaIndex: door.areaIndex,
          x: door.x,
          y: door.y,
          tags: door.tags.map(tagLabel),
          voters: [...this.doorVotes].filter(([, areaIndex]) => areaIndex === door.areaIndex).map(([id]) => id),
        })),
    };
  }

  /**
   * area: sector index, -1 neutral, null unknown (fog or void).
   * state: 'cleared' | 'open' (seen, unexplored) | 'void' | 'hidden'.
   */
  #cellView(cell, index, visible) {
    const isCleared = this.cleared.has(index);
    const isVisible = visible.has(index);
    if (cell.areaIndex === VOID_AREA) return { area: null, state: isVisible ? 'void' : 'hidden', content: null };

    const inSector = cell.areaIndex >= 0;
    // A sector's shape is known once the team explored one of its tiles.
    const areaKnown = isVisible || (inSector && this.discoveredAreas.has(cell.areaIndex));
    // A collected key disappears from the map; doors stay so the team can see where they are.
    const keyTaken = cell.content === 'key' && this.collectedKeys.has(cell.areaIndex);
    const markerShown = this.isAreaRevealed(cell.areaIndex)
      && (cell.content === 'key' || cell.content === 'door');

    let state = 'hidden';
    if (isCleared) state = 'cleared';
    else if (isVisible) state = 'open';

    const progress = !isCleared && this.tileProgress.get(index);
    return {
      area: areaKnown ? cell.areaIndex : null,
      state,
      content: !keyTaken && (isCleared || markerShown) ? cell.content : null,
      // S/A partial answers, shown as small badges on the map.
      progress: progress && isVisible ? {
        song: progress.song,
        artist: progress.artist,
        members: progress.members.size,
        memberCount: progress.memberCount,
      } : null,
    };
  }
}
