import { AREA_COUNT, DOOR_TAG_COUNT, GRID_SIZE, MAP_GENERATION_ATTEMPTS } from '../config.js';

/** @typedef {import('./types.js').Floor} Floor */
/** @typedef {import('./types.js').Cell} Cell */
/** @typedef {import('../core/rng.js').Rng} Rng */

/** Area index of the neutral start area. */
export const NEUTRAL_AREA = -1;
/** Area index of cells outside the generated map (not walkable). */
export const VOID_AREA = -2;

const DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const TURN = Math.PI * 2;
/** Fraction of an area's cells (farthest from the start) where its door may appear. */
const DOOR_FAR_FRACTION = 0.4;
/** Chance that a growing area picks one of its best-scored frontier cells instead of any. */
const PREFER_CHANCE = 0.75;
/** A walkable cell should be reachable from at least this many walkable neighbors. */
const MIN_ENTRANCES = 2;
/** Upper bound of cell swaps when removing dead ends from a layout. */
const MAX_REPAIRS = 200;

/**
 * @param {number} x
 * @param {number} y
 * @param {number} size
 * @returns {number}
 */
export function cellIndex(x, y, size = GRID_SIZE) {
  return y * size + x;
}

/**
 * @param {number} index
 * @param {number} size
 * @returns {{x: number, y: number}}
 */
export function cellCoords(index, size = GRID_SIZE) {
  return { x: index % size, y: Math.floor(index / size) };
}

/**
 * Orthogonal neighbor indices inside the grid.
 * @param {number} index
 * @param {number} size
 * @returns {number[]}
 */
export function neighborIndices(index, size = GRID_SIZE) {
  const { x, y } = cellCoords(index, size);
  const result = [];
  for (const [dx, dy] of DIRECTIONS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < size && ny < size) result.push(cellIndex(nx, ny, size));
  }
  return result;
}

/**
 * True when two cells share an edge.
 * @param {number} a
 * @param {number} b
 * @param {number} size
 * @returns {boolean}
 */
export function areAdjacent(a, b, size = GRID_SIZE) {
  return neighborIndices(a, size).includes(b);
}

/**
 * Cells a player can see: every explored cell and the 8 cells around each of them.
 * @param {Floor} floor
 * @param {Set<number>} cleared
 * @returns {Set<number>}
 */
export function getVisibleCells(floor, cleared) {
  const visible = new Set();
  for (const index of cleared) {
    const { x, y } = cellCoords(index, floor.size);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < floor.size && ny < floor.size) {
          visible.add(cellIndex(nx, ny, floor.size));
        }
      }
    }
  }
  return visible;
}

/**
 * Number of walkable orthogonal neighbors of a cell ("entrances").
 * @param {number[]} areaOf  Area index per cell (VOID_AREA = not walkable).
 * @param {number} index
 * @param {number} size
 * @returns {number}
 */
export function countEntrances(areaOf, index, size = GRID_SIZE) {
  return neighborIndices(index, size).filter((neighbor) => areaOf[neighbor] !== VOID_AREA).length;
}

/**
 * Picks `count` distinct tags, padding with null (mixed) when the pool is too small.
 * Tags in `avoid` are used only as a last resort.
 * @param {Rng} rng
 * @param {string[]} tagPool
 * @param {number} count
 * @param {Set<string>} [avoid]
 * @returns {(string | null)[]}
 */
export function pickTags(rng, tagPool, count, avoid = new Set()) {
  const shuffled = rng.shuffle(tagPool);
  const ordered = [
    ...shuffled.filter((tag) => !avoid.has(tag)),
    ...shuffled.filter((tag) => avoid.has(tag)),
  ];
  const tags = ordered.slice(0, count);
  while (tags.length < count) tags.push(null);
  return tags;
}

/**
 * Generates one dungeon floor inside the GRID_SIZE boundary: a random-shaped neutral hub around
 * the start, then AREA_COUNT themed sectors around it. Every area (hub included) has exactly
 * `tilesPerArea` cells, and walkable cells avoid dead ends (at least MIN_ENTRANCES neighbors).
 * Cells left over are void. Every area hides a door; each sector also hides a key.
 * @param {object} options
 * @param {Rng} options.rng
 * @param {number} options.floorNumber
 * @param {(string | null)[]} options.areaTags  One theme per sector.
 * @param {string[]} options.tagPool           Tags available for the doors' next floors.
 * @param {number} options.tilesPerArea
 * @returns {Floor}
 */
export function generateFloor({ rng, floorNumber, areaTags, tagPool, tilesPerArea }) {
  const size = GRID_SIZE;
  const start = cellIndex(Math.floor(size / 2), Math.floor(size / 2), size);

  // Retry until every area has its size and no dead end remains; otherwise keep the best try.
  let layout = null;
  for (let attempt = 0; attempt < MAP_GENERATION_ATTEMPTS; attempt++) {
    const candidate = createLayout(rng, size, start, tilesPerArea);
    if (!layout || layoutScore(candidate) > layoutScore(layout)) layout = candidate;
    if (candidate.complete && candidate.deadEnds === 0) break;
  }

  /** @type {Cell[]} */
  const cells = layout.areaOf.map((areaIndex) => ({ areaIndex, content: null }));
  cells[start].content = 'start';

  const usedDoorTags = new Set();
  const placeDoor = (areaIndex, doorIndex) => {
    cells[doorIndex].content = 'door';
    const tags = pickTags(rng, tagPool, DOOR_TAG_COUNT, usedDoorTags);
    tags.forEach((tag) => tag && usedDoorTags.add(tag));
    return { areaIndex, ...cellCoords(doorIndex, size), tags };
  };

  const doors = layout.sectors.map((indices, areaIndex) => {
    const doorIndex = pickFarCell(rng, indices, start, size);
    // A boxed-in one-cell sector keeps its key in the neutral area as a last resort.
    const keyCandidates = indices.filter((index) => index !== doorIndex);
    const inner = keyCandidates.filter((index) => !touches(index, layout.neutral, size));
    const fallback = layout.neutral.filter((index) => index !== start && !cells[index].content);
    const pool = inner.length > 0 ? inner : keyCandidates.length > 0 ? keyCandidates : fallback;
    cells[rng.pick(pool)].content = 'key';
    return placeDoor(areaIndex, doorIndex);
  });
  const neutralCandidates = layout.neutral.filter((index) => index !== start);
  doors.push(placeDoor(NEUTRAL_AREA, pickFarCell(rng, neutralCandidates, start, size)));

  return {
    number: floorNumber,
    size,
    cells,
    start: cellCoords(start, size),
    areas: areaTags.slice(0, AREA_COUNT).map((tag, index) => ({ index, tag })),
    doors,
  };
}

/** One attempt at shaping the floor. */
function createLayout(rng, size, start, tilesPerArea) {
  const areaOf = Array(size * size).fill(VOID_AREA);
  areaOf[start] = NEUTRAL_AREA;
  const ownNeighbors = (index, areaIndex) =>
    neighborIndices(index, size).filter((n) => areaOf[n] === areaIndex).length;

  // The hub grows compact-ish: cells touching 2+ hub cells are favored.
  const hub = { areaIndex: NEUTRAL_AREA, cells: [start], frontier: neighborIndices(start, size) };
  const hubScore = (index) => (ownNeighbors(index, NEUTRAL_AREA) >= 2 ? 1 : 0);
  while (hub.cells.length < tilesPerArea && claimFrontierCell(rng, areaOf, size, hub, hubScore)) {
    // Each iteration claims one cell.
  }

  // Each sector starts on a cell touching the hub, so every sector is reachable from it.
  // Sectors grow round-robin, favoring cells that hug the hub (wraps them around it) and cells
  // touching 2+ of their own cells (avoids thin corridors and dead ends).
  const regions = pickSectorSeeds(rng, areaOf, size, start, hub.cells).map((seed, areaIndex) => {
    areaOf[seed] = areaIndex;
    return { areaIndex, cells: [seed], frontier: neighborIndices(seed, size) };
  });
  const sectorScore = (region) => (index) =>
    (ownNeighbors(index, NEUTRAL_AREA) > 0 ? 1 : 0) + (ownNeighbors(index, region.areaIndex) >= 2 ? 1 : 0);
  let growing = true;
  while (growing) {
    growing = false;
    for (const region of regions) {
      if (region.cells.length < tilesPerArea
        && claimFrontierCell(rng, areaOf, size, region, sectorScore(region))) {
        growing = true;
      }
    }
  }

  repairDeadEnds(rng, areaOf, size, start);

  const cellsOf = (areaIndex) => areaOf.flatMap((value, index) => (value === areaIndex ? [index] : []));
  const neutral = cellsOf(NEUTRAL_AREA);
  const sectors = regions.map((region) => cellsOf(region.areaIndex));
  return {
    areaOf,
    neutral,
    sectors,
    complete: sectors.length === AREA_COUNT
      && [neutral, ...sectors].every((cells) => cells.length === tilesPerArea),
    deadEnds: findDeadEnds(areaOf, size).length,
  };
}

/** Higher is better: full-size areas first, then fewer dead ends. */
function layoutScore(layout) {
  if (layout.sectors.length < AREA_COUNT) return -Infinity;
  const smallest = Math.min(layout.neutral.length, ...layout.sectors.map((cells) => cells.length));
  return smallest * 1000 - layout.deadEnds;
}

/**
 * Claims one void frontier cell for the region. Most of the time it picks among the cells with
 * the best `score`, otherwise any frontier cell (keeps shapes organic). Returns false when stuck.
 */
function claimFrontierCell(rng, areaOf, size, region, score) {
  region.frontier = [...new Set(region.frontier)].filter((index) => areaOf[index] === VOID_AREA);
  if (region.frontier.length === 0) return false;
  let options = region.frontier;
  if (rng.next() < PREFER_CHANCE) {
    const scores = options.map(score);
    const best = Math.max(...scores);
    options = options.filter((_, i) => scores[i] === best);
  }
  const candidate = rng.pick(options);
  areaOf[candidate] = region.areaIndex;
  region.cells.push(candidate);
  region.frontier.push(...neighborIndices(candidate, size));
  return true;
}

/** Walkable cells with fewer than MIN_ENTRANCES walkable neighbors. */
function findDeadEnds(areaOf, size) {
  return areaOf.flatMap((areaIndex, index) =>
    (areaIndex !== VOID_AREA && countEntrances(areaOf, index, size) < MIN_ENTRANCES ? [index] : []));
}

/**
 * Removes dead ends without changing area sizes: a dead-end cell is moved to a void cell that
 * touches at least two cells of the same area. Swaps that would split an area or cut a sector
 * from the hub are undone, and the start cell never moves.
 */
function repairDeadEnds(rng, areaOf, size, start) {
  const stuck = new Set();
  for (let repair = 0; repair < MAX_REPAIRS; repair++) {
    const deadEnd = findDeadEnds(areaOf, size).find((index) => !stuck.has(index) && index !== start);
    if (deadEnd === undefined) return;
    if (!relocateCell(rng, areaOf, size, deadEnd)) stuck.add(deadEnd);
  }
}

function relocateCell(rng, areaOf, size, cell) {
  const areaIndex = areaOf[cell];
  areaOf[cell] = VOID_AREA;
  const targets = areaOf.flatMap((value, index) => {
    if (value !== VOID_AREA || index === cell) return [];
    const sameArea = neighborIndices(index, size).filter((n) => areaOf[n] === areaIndex).length;
    return sameArea >= MIN_ENTRANCES ? [index] : [];
  });
  if (targets.length > 0) {
    const target = rng.pick(targets);
    areaOf[target] = areaIndex;
    if (isAreaConnected(areaOf, size, areaIndex) && everySectorTouchesHub(areaOf, size)) return true;
    areaOf[target] = VOID_AREA;
  }
  areaOf[cell] = areaIndex;
  return false;
}

function isAreaConnected(areaOf, size, areaIndex) {
  const members = areaOf.flatMap((value, index) => (value === areaIndex ? [index] : []));
  const seen = new Set([members[0]]);
  const queue = [members[0]];
  while (queue.length > 0) {
    for (const next of neighborIndices(queue.shift(), size)) {
      if (areaOf[next] === areaIndex && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen.size === members.length;
}

function everySectorTouchesHub(areaOf, size) {
  const touching = new Set();
  areaOf.forEach((areaIndex, index) => {
    if (areaIndex < 0) return;
    if (neighborIndices(index, size).some((n) => areaOf[n] === NEUTRAL_AREA)) touching.add(areaIndex);
  });
  return touching.size === AREA_COUNT;
}

/** One void cell touching the neutral area per sector, spread evenly around it. */
function pickSectorSeeds(rng, areaOf, size, start, neutral) {
  const origin = cellCoords(start, size);
  const ring = [...new Set(neutral.flatMap((index) => neighborIndices(index, size)))]
    .filter((index) => areaOf[index] === VOID_AREA);
  const angleOf = (index) => {
    const { x, y } = cellCoords(index, size);
    return Math.atan2(y - origin.y, x - origin.x);
  };
  const baseAngle = rng.next() * TURN;
  const seeds = [];
  for (let k = 0; k < AREA_COUNT; k++) {
    const target = baseAngle + (k * TURN) / AREA_COUNT;
    const gap = (index) => {
      const delta = angleOf(index) - target;
      return Math.abs(Math.atan2(Math.sin(delta), Math.cos(delta)));
    };
    const best = ring.filter((index) => !seeds.includes(index)).sort((a, b) => gap(a) - gap(b))[0];
    if (best !== undefined) seeds.push(best);
  }
  return seeds;
}

function touches(index, others, size) {
  return neighborIndices(index, size).some((neighbor) => others.includes(neighbor));
}

/** A random cell among the farthest DOOR_FAR_FRACTION of `indices` from the start. */
function pickFarCell(rng, indices, start, size) {
  const origin = cellCoords(start, size);
  const distance = (index) => {
    const { x, y } = cellCoords(index, size);
    return Math.abs(x - origin.x) + Math.abs(y - origin.y);
  };
  const sorted = [...indices].sort((a, b) => distance(b) - distance(a));
  return rng.pick(sorted.slice(0, Math.max(1, Math.floor(sorted.length * DOOR_FAR_FRACTION))));
}
