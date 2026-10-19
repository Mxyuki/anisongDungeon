import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AREA_COUNT,
  DEFAULT_SETTINGS,
  GRID_SIZE,
  SETTINGS_LIMITS,
} from '../app/src/config.js';
import { createRng } from '../app/src/core/rng.js';
import { normalizeText, normalizeWithMap, similarity } from '../app/src/core/text.js';
import { buildAnswerKeys, findMatchingAnswer, isCorrectAnswer } from '../app/src/game/answers.js';
import { floorDifficulty, pickSong, targetGuessRate } from '../app/src/game/difficulty.js';
import {
  cellIndex,
  countEntrances,
  generateFloor,
  getVisibleCells,
  neighborIndices,
  NEUTRAL_AREA,
  pickTags,
  VOID_AREA,
} from '../app/src/game/dungeon.js';
import { sanitizeSettings, seasonBounds, songsNeeded } from '../app/src/game/settings.js';

const TAGS = ['Action', 'Comedy', 'Mecha', 'Romance', 'Drama', 'Sports', 'Music', 'Horror', 'Isekai'];

test('rng is deterministic per seed', () => {
  const a = createRng('seed');
  const b = createRng('seed');
  const values = Array.from({ length: 5 }, () => a.next());
  assert.deepEqual(values, Array.from({ length: 5 }, () => b.next()));
  assert.ok(values.every((v) => v >= 0 && v < 1));
});

test('normalizeText ignores case, accents and punctuation', () => {
  assert.equal(normalizeText('Shingeki no Kyojin: Season 2!'), 'shingeki no kyojin season 2');
  assert.equal(normalizeText('Pokémon'), 'pokemon');
  assert.equal(similarity('abc', 'abc'), 1);
});

test('normalizeText folds look-alike letters and turns other symbols into spaces', () => {
  assert.equal(normalizeText('Macross Δ'), 'macross a');
  assert.equal(normalizeText("Love Live! μ's"), 'love live u s');
  assert.equal(normalizeText('Weiß Kreuz'), 'weiss kreuz');
  assert.equal(normalizeText('Ørphan ★ Đêm'), 'orphan dem');
  assert.equal(normalizeText('Kaguya-sama: Love is War'), 'kaguya sama love is war');
  assert.equal(normalizeText('Tom & Jerry'), 'tom jerry');
  const { text, map } = normalizeWithMap('  Re:Zéro ');
  assert.equal(text, 're zero');
  assert.deepEqual(map, [2, 3, 4, 5, 6, 7, 8]);
});

test('answers accept symbols typed as spaces, missing spaces and "&" as "and"', () => {
  const keys = buildAnswerKeys(['Re:Zero kara Hajimeru Isekai Seikatsu', 'Tom & Jerry']);
  assert.ok(isCorrectAnswer('re zero kara hajimeru isekai seikatsu', keys));
  assert.ok(isCorrectAnswer('rezero kara hajimeru isekai seikatsu', keys));
  assert.ok(isCorrectAnswer('Tom and Jerry', keys));
  assert.ok(isCorrectAnswer('tom jerry', keys));
  assert.ok(isCorrectAnswer('Macross Δ', buildAnswerKeys(['Macross Δ'])));
  assert.ok(isCorrectAnswer('macross a', buildAnswerKeys(['Macross Δ'])));
});

test('answers accept exact, normalized and small typos only', () => {
  const keys = buildAnswerKeys(['Shingeki no Kyojin', 'Attack on Titan']);
  assert.ok(isCorrectAnswer('attack on titan', keys));
  assert.ok(isCorrectAnswer('Shingeki no Kyojn', keys));
  assert.ok(!isCorrectAnswer('Attack', keys));
  assert.ok(!isCorrectAnswer('', keys));
  assert.ok(!isCorrectAnswer('One Piece', keys));
});

test('an exact member name wins over a near-identical one', () => {
  const members = [buildAnswerKeys(['Singer 54A']), buildAnswerKeys(['Singer 54B'])];
  assert.equal(findMatchingAnswer('singer 54b', members), 1);
  assert.equal(findMatchingAnswer('Singr 54B', members), 1, 'a typo credits the closest member');
  assert.equal(findMatchingAnswer('Someone Else', members), -1);
});

test('settings are clamped and keep at least one song type', () => {
  const settings = sanitizeSettings({ floors: 999, timeLimitMin: 'x', songTypes: [], maxRerolls: 0 });
  assert.equal(settings.floors, SETTINGS_LIMITS.floors.max);
  assert.equal(settings.timeLimitMin, DEFAULT_SETTINGS.timeLimitMin);
  assert.deepEqual(settings.songTypes, DEFAULT_SETTINGS.songTypes);
  assert.equal(settings.maxRerolls, SETTINGS_LIMITS.maxRerolls.min);
  assert.deepEqual(sanitizeSettings({ songTypes: ['ED', 'BAD', 'OP'] }).songTypes, ['OP', 'ED']);
  assert.equal(settings.answerMode, 'anime', 'anime mode by default');
  assert.equal(sanitizeSettings({ answerMode: 'songArtist' }).answerMode, 'songArtist');
  assert.equal(sanitizeSettings({ answerMode: 'nope' }).answerMode, 'anime');
  assert.equal(sanitizeSettings({ artistAreas: 'hidden' }).artistAreas, 'hidden');
  assert.equal(sanitizeSettings({ artistAreas: 'nope' }).artistAreas, 'shown');
});

test('difficulty rises with floors and picks songs near the target', () => {
  assert.equal(floorDifficulty(1, 5), 0);
  assert.equal(floorDifficulty(4, 5), 1);
  assert.ok(targetGuessRate(0) > targetGuessRate(1));

  const songs = Array.from({ length: 100 }, (_, id) => ({ id, guessRate: id }));
  const rng = createRng(1);
  const easy = Array.from({ length: 50 }, () => pickSong({ rng, candidates: songs, difficulty: 0 }));
  const hard = Array.from({ length: 50 }, () => pickSong({ rng, candidates: songs, difficulty: 1 }));
  const mean = (list) => list.reduce((sum, song) => sum + song.guessRate, 0) / list.length;
  assert.ok(mean(easy) > mean(hard) + 25);

  const played = new Set(songs.slice(1).map((s) => s.id));
  assert.equal(pickSong({ rng, candidates: songs, difficulty: 0, excludeIds: played }).id, 0);
});

test('pickTags pads with null when the pool is small and avoids used tags', () => {
  const rng = createRng(3);
  assert.deepEqual(pickTags(rng, [], 3), [null, null, null]);
  const tags = pickTags(rng, ['A', 'B', 'C', 'D'], 2, new Set(['A', 'B']));
  assert.deepEqual([...tags].sort(), ['C', 'D']);
});

/** Cells of an area connected from its first cell (BFS restricted to the given predicate). */
function connectedCount(floor, isMember) {
  const members = floor.cells.flatMap((cell, index) => (isMember(cell) ? [index] : []));
  const seen = new Set([members[0]]);
  const queue = [members[0]];
  while (queue.length) {
    for (const next of neighborIndices(queue.shift())) {
      if (!seen.has(next) && isMember(floor.cells[next])) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return { size: members.length, reached: seen.size };
}

const makeFloor = (seed, tilesPerArea = 15) => generateFloor({
  rng: createRng(seed), floorNumber: 1, areaTags: TAGS.slice(0, 3), tagPool: TAGS, tilesPerArea,
});

for (const seed of [1, 2, 3, 42, 'floor-x', 999]) {
  for (const tilesPerArea of [8, 15, 30]) {
    test(`generateFloor builds a valid floor (seed ${seed}, ${tilesPerArea} tiles)`, () => {
      const floor = makeFloor(seed, tilesPerArea);
      const center = Math.floor(GRID_SIZE / 2);
      assert.equal(floor.cells.length, GRID_SIZE * GRID_SIZE);
      assert.equal(floor.cells[cellIndex(center, center)].content, 'start');
      assert.equal(floor.cells[cellIndex(center, center)].areaIndex, NEUTRAL_AREA);

      const neutral = floor.cells.filter((cell) => cell.areaIndex === NEUTRAL_AREA);
      assert.equal(neutral.length, tilesPerArea, 'the hub has the chosen size too');
      assert.equal(neutral.filter((cell) => cell.content === 'door').length, 1, 'the center has a door');
      assert.equal(neutral.filter((cell) => cell.content === 'key').length, 0);

      for (let area = 0; area < AREA_COUNT; area++) {
        const cells = floor.cells.filter((cell) => cell.areaIndex === area);
        assert.equal(cells.length, tilesPerArea);
        assert.equal(cells.filter((cell) => cell.content === 'key').length, 1);
        assert.equal(cells.filter((cell) => cell.content === 'door').length, 1);
        const { size, reached } = connectedCount(floor, (cell) => cell.areaIndex === area);
        assert.equal(reached, size, `sector ${area} is in one piece`);
      }
      assert.ok(floor.cells.some((cell) => cell.areaIndex === VOID_AREA), 'the grid is only a boundary');

      assert.equal(floor.doors.length, AREA_COUNT + 1);
      for (const door of floor.doors) {
        assert.equal(door.tags.length, 3);
        assert.equal(new Set(door.tags).size, 3);
        assert.equal(floor.cells[cellIndex(door.x, door.y)].content, 'door');
      }
    });
  }
}

test('the whole map is reachable and every sector touches the neutral hub', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    for (const tilesPerArea of [6, 15, 40]) {
      const floor = makeFloor(seed, tilesPerArea);
      const walkable = connectedCount(floor, (cell) => cell.areaIndex !== VOID_AREA);
      assert.equal(walkable.reached, walkable.size, `seed ${seed}`);
      for (let area = 0; area < AREA_COUNT; area++) {
        const touchesHub = floor.cells.some((cell, index) => cell.areaIndex === area
          && neighborIndices(index).some((n) => floor.cells[n].areaIndex === NEUTRAL_AREA));
        assert.ok(touchesHub, `sector ${area} touches the center (seed ${seed}, ${tilesPerArea} tiles)`);
      }
    }
  }
});

test('no walkable tile is a dead end (at least 2 ways in)', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    for (const tilesPerArea of [6, 15, 40]) {
      const floor = makeFloor(seed, tilesPerArea);
      const areaOf = floor.cells.map((cell) => cell.areaIndex);
      floor.cells.forEach((cell, index) => {
        if (cell.areaIndex === VOID_AREA) return;
        assert.ok(countEntrances(areaOf, index) >= 2, `dead end at ${index} (seed ${seed}, ${tilesPerArea} tiles)`);
      });
    }
  }
});

test('visibility covers the 8 cells around explored ones', () => {
  const floor = makeFloor(5);
  const start = cellIndex(floor.start.x, floor.start.y);
  assert.equal(getVisibleCells(floor, new Set([start])).size, 9);
  assert.equal(getVisibleCells(floor, new Set([0])).size, 4, 'corner');
});

test('season range settings are clamped and kept in order', () => {
  const base = sanitizeSettings({});
  assert.equal(base.seasonRange, false);
  assert.equal(seasonBounds(base), null);
  const on = sanitizeSettings({ seasonRange: true, fromYear: 2000, fromSeason: 1, toYear: 2009, toSeason: 9 });
  assert.deepEqual(seasonBounds(on), { from: 2000 * 4 + 1, to: 2009 * 4 + 3 });
  const movedTo = sanitizeSettings({ toYear: 1995 }, on);
  assert.deepEqual([movedTo.fromYear, movedTo.fromSeason], [1995, 3], 'moving the end drags the start');
  const movedFrom = sanitizeSettings({ fromYear: 2015 }, on);
  assert.deepEqual([movedFrom.toYear, movedFrom.toSeason], [2015, 1], 'moving the start drags the end');
  assert.equal(sanitizeSettings({ anySeason: 'yes' }).anySeason, false, 'booleans only');
  assert.equal(songsNeeded({ ...base, floors: 5, tilesPerArea: 15 }), 4 * 4 * 15);
});
