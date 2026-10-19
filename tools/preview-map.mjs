/**
 * Prints generated floors as ASCII, plus generation success rates, to tune the map generator.
 * Usage: node tools/preview-map.mjs [tilesPerArea] [seed]
 *   S start · o neutral · A/B/C sectors · K key · D door · . void
 */
import { createRng } from '../app/src/core/rng.js';
import { countEntrances, generateFloor } from '../app/src/game/dungeon.js';

const TAGS = ['Action', 'Comedy', 'Drama', 'Mecha', 'Romance', 'Sports', 'Music', 'Horror', 'Magic', 'School', 'Space', 'War'];
const tilesPerArea = Number(process.argv[2] ?? 15);
const seed = process.argv[3] ?? 1;
const AREA_SYMBOLS = { '-2': '.', '-1': 'o', 0: 'A', 1: 'B', 2: 'C' };
const CONTENT_SYMBOLS = { start: 'S', key: 'K', door: 'D' };

const generate = (rngSeed, tiles) => generateFloor({
  rng: createRng(rngSeed), floorNumber: 1, areaTags: TAGS.slice(0, 3), tagPool: TAGS, tilesPerArea: tiles,
});

const floor = generate(seed, tilesPerArea);
for (let y = 0; y < floor.size; y++) {
  let row = '';
  for (let x = 0; x < floor.size; x++) {
    const cell = floor.cells[y * floor.size + x];
    row += `${CONTENT_SYMBOLS[cell.content] ?? AREA_SYMBOLS[cell.areaIndex]} `;
  }
  console.log(row);
}

const areaOf = (f) => f.cells.map((cell) => cell.areaIndex);
for (const tiles of [6, 10, 15, 25, 40]) {
  const started = Date.now();
  let perfect = 0;
  let deadEnds = 0;
  for (let s = 0; s < 200; s++) {
    const f = generate(s, tiles);
    const full = [-1, 0, 1, 2].every((a) => f.cells.filter((c) => c.areaIndex === a).length === tiles);
    const ends = f.cells.filter((c, i) => c.areaIndex !== -2 && countEntrances(areaOf(f), i) < 2).length;
    deadEnds += ends;
    if (full && ends === 0) perfect++;
  }
  console.log(`tiles ${tiles}: ${perfect}/200 perfect floors, ${deadEnds} dead ends total (${Date.now() - started} ms)`);
}
