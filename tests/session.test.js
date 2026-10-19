import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AREA_REVEAL_GUESSES,
  ARTIST_TAG_HIDDEN,
  ARTIST_TAG_PREFIX,
  DEFAULT_SETTINGS,
  DOOR_ROLL_MS,
  MIN_SONGS_PER_TAG,
} from '../app/src/config.js';
import { Emitter } from '../app/src/core/emitter.js';
import { filterByStatus } from '../app/src/data/anilist.js';
import { decodeLibrary } from '../app/src/data/library.js';
import { SongPool } from '../app/src/data/SongPool.js';
import { GameClient } from '../app/src/client/GameClient.js';
import { createInitialState, Store } from '../app/src/client/store.js';
import { isCorrectAnswer } from '../app/src/game/answers.js';
import { cellCoords, neighborIndices, NEUTRAL_AREA, VOID_AREA } from '../app/src/game/dungeon.js';
import { createLoopbackPair } from '../app/src/net/transport.js';
import { GameSession } from '../app/src/server/GameSession.js';
import { createRng } from '../app/src/core/rng.js';
import { HostServer } from '../app/src/server/HostServer.js';

const GENRES = ['Action', 'Comedy', 'Mecha', 'Romance'];

/** 80 anime × 3 songs (OP/ED/IN), genres cycling so every genre is eligible. */
function makeLibrary() {
  const anime = [];
  const songs = [];
  for (let id = 1; id <= 80; id++) {
    anime.push([id, 1000 + id, `Anime ${id}`, `Show ${id} English`, [], [GENRES[id % 4]], ['School']]);
    for (let type = 1; type <= 3; type++) {
      songs.push([id * 10 + type, id, `Song ${id}-${type}`, 'Artist', type, 1, (id * 7) % 100, `${id}-${type}.mp3`, []]);
    }
  }
  return decodeLibrary({ anime, songs });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function createSession({ settings = DEFAULT_SETTINGS, songTypes = ['OP', 'ED', 'IN'], players = ['p1'], now = Date.now() } = {}) {
  const pool = new SongPool(makeLibrary(), { songTypes, aniListIds: null });
  const session = new GameSession({
    pool, settings, now, players: players.map((id) => ({ id, name: id.toUpperCase() })),
  });
  return { pool, session, expedition: session.expedition, me: session.players.get(players[0]) };
}

/** The test cheats by reading the secret song of a player's tile. */
function answerFor(pool, expedition, player) {
  return pool.getAnime(expedition.tileSongs.get(player.position).song).names[0];
}

const onSong = (expedition, player) => !expedition.cleared.has(player.position);

/** Shortest walkable path (BFS) from the player to a cell. */
function pathTo(expedition, player, target) {
  const previous = new Map([[player.position, null]]);
  const queue = [player.position];
  while (queue.length) {
    const current = queue.shift();
    if (current === target) break;
    for (const next of neighborIndices(current, expedition.floor.size)) {
      if (!previous.has(next) && expedition.isWalkable(next)) {
        previous.set(next, current);
        queue.push(next);
      }
    }
  }
  const path = [];
  for (let at = target; at !== player.position; at = previous.get(at)) path.unshift(at);
  return path;
}

/** Walks a player to a cell, guessing every song on the way. */
function walkTo(context, player, target) {
  const { session, pool, expedition } = context;
  for (let guard = 0; guard < 500 && !(player.position === target && expedition.cleared.has(target)); guard++) {
    const [next] = pathTo(expedition, player, target);
    const { x, y } = cellCoords(next, expedition.floor.size);
    assert.ok(session.move(player.playerId, x, y).ok);
    if (onSong(expedition, player)) {
      assert.ok(session.guess(player.playerId, answerFor(pool, expedition, player)).result.correct);
    }
  }
}

const cellsWith = (expedition, predicate) =>
  expedition.floor.cells.flatMap((cell, index) => (predicate(cell) ? [index] : []));

test('song pool filters by types and lists, and exposes eligible tags', () => {
  const library = makeLibrary();
  const all = new SongPool(library, { songTypes: ['OP', 'ED'], aniListIds: null });
  assert.equal(all.songs.length, 160);
  assert.deepEqual([...all.eligibleTags()].sort(), [...GENRES, 'School'].sort());

  const listed = new SongPool(library, { songTypes: ['OP'], aniListIds: [1001, 1002, 9999] });
  assert.equal(listed.songs.length, 2);
  assert.ok(listed.fromLists);
  assert.ok(listed.eligibleTags().length === 0, `needs ${MIN_SONGS_PER_TAG} songs per tag`);
});

test('AniList entries are filtered by the statuses a player picked', () => {
  const entries = [
    { mediaId: 1, status: 'CURRENT' }, { mediaId: 2, status: 'COMPLETED' },
    { mediaId: 3, status: 'PLANNING' }, { mediaId: 4, status: 'DROPPED' },
  ];
  assert.deepEqual(filterByStatus(entries, ['COMPLETED', 'PLANNING']), [2, 3]);
  assert.deepEqual(filterByStatus(entries, []), []);
});

test('the team climbs every floor, then the session ends', () => {
  const context = createSession({ settings: { ...DEFAULT_SETTINGS, floors: 4 } });
  const { session, expedition, me } = context;
  let results = null;
  session.on('end', (value) => { results = value; });

  for (let guard = 0; guard < 10 && !expedition.finished; guard++) {
    for (const keyCell of cellsWith(expedition, (cell) => cell.content === 'key')) walkTo(context, me, keyCell);
    assert.equal(expedition.keys, 3);
    const door = expedition.floor.doors[0];
    walkTo(context, me, door.y * expedition.floor.size + door.x);
    assert.ok(session.enterDoor('p1', door.areaIndex).ok);
  }
  assert.ok(expedition.finished);
  assert.ok(results, 'reaching the last floor ends the game');
  assert.equal(results.floorReached, 4);
  assert.ok(results.finished);
  assert.ok(results.players[0].guessed > 0);
});

test('movement: one step at a time, must guess before going further, walls block', () => {
  const context = createSession();
  const { pool, session, expedition, me } = context;
  const start = cellCoords(me.position);
  assert.equal(session.move('p1', start.x + 2, start.y).ok, false, 'no jumping');
  assert.equal(session.move('p1', -1, 0).ok, false, 'no leaving the map');

  const firstStep = neighborIndices(me.position).find((index) => expedition.isWalkable(index));
  const step = cellCoords(firstStep);
  assert.ok(session.move('p1', step.x, step.y).ok);
  assert.ok(onSong(expedition, me), 'stepping on an unexplored tile starts its song');
  const further = neighborIndices(me.position).find((index) => !expedition.cleared.has(index) && expedition.isWalkable(index));
  if (further !== undefined) {
    const { x, y } = cellCoords(further);
    assert.equal(session.move('p1', x, y).ok, false, 'blocked until guessed');
  }

  const song = expedition.tileSongs.get(me.position).song.id;
  assert.ok(session.move('p1', start.x, start.y).ok, 'can step back');
  assert.ok(session.move('p1', step.x, step.y).ok);
  assert.equal(expedition.tileSongs.get(me.position).song.id, song, 'the tile keeps its song');
  assert.ok(session.guess('p1', answerFor(pool, expedition, me)).result.correct);
  assert.ok(!onSong(expedition, me), 'guessed tile is explored');

  const wall = cellsWith(expedition, (cell) => cell.areaIndex === VOID_AREA)[0];
  assert.equal(expedition.isWalkable(wall), false);
});

test('wrong guesses keep the song and are not counted; rerolls swap it', () => {
  const now = Date.now();
  const settings = { ...DEFAULT_SETTINGS, rerollIntervalSec: 10, maxRerolls: 2 };
  const { session, expedition, me } = createSession({ settings, songTypes: ['OP'], now });

  assert.equal(session.reroll('p1').ok, false, 'no reroll without a song');
  const { x, y } = cellCoords(neighborIndices(me.position).find((i) => expedition.isWalkable(i)));
  assert.ok(session.move('p1', x, y).ok);
  const first = expedition.tileSongs.get(me.position).song.id;

  const wrong = session.guess('p1', 'definitely wrong');
  assert.equal(wrong.result.kind, 'wrong');
  assert.equal(wrong.result.answer, undefined, 'a wrong guess reveals nothing');
  assert.equal(expedition.tileSongs.get(me.position).song.id, first);
  assert.deepEqual(me.stats, { guessed: 0, rerollsUsed: 0, songsFound: 0, artistsFound: 0 });

  const rerolled = session.reroll('p1');
  assert.equal(rerolled.result.kind, 'rerolled');
  assert.ok(rerolled.result.answer.anime.startsWith('Anime '), 'reroll reveals the old song');
  assert.notEqual(expedition.tileSongs.get(me.position).song.id, first);
  assert.equal(me.rerolls, 0);
  assert.equal(session.reroll('p1').ok, false);

  session.tick(now + 10_001);
  assert.equal(me.rerolls, 1);
  session.tick(now + 20_002);
  assert.equal(me.rerolls, 2);
  assert.equal(me.nextRerollAt, null, 'cooldown pauses at the cap');
});

test('fog of war, sector outlines, marker reveal; the center stays open', () => {
  const context = createSession();
  const { session, expedition, me } = context;
  const view = () => session.viewFor('p1');
  const hidden = view().grid.cells.filter((cell) => cell.state === 'hidden');
  assert.ok(hidden.length >= 225 - 9, 'only the surroundings of the start are visible');
  assert.ok(hidden.every((cell) => cell.area === null && cell.content === null), 'nothing is known in the fog');
  assert.ok(!JSON.stringify(view()).includes('Anime '), 'views never leak anime names');

  const sector = cellsWith(expedition, (cell) => cell.areaIndex === 0);
  const entry = [...sector].sort((a, b) => pathTo(expedition, me, a).length - pathTo(expedition, me, b).length)[0];
  walkTo(context, me, entry);
  assert.ok(sector.every((index) => view().grid.cells[index].area === 0), 'the whole sector outline is known');

  walkTo(context, me, expedition.startIndex);
  assert.equal(me.position, expedition.startIndex, 'players can always walk back through the center');

  const doorCell = sector.find((index) => expedition.floor.cells[index].content === 'door');
  const nextToExplore = () => sector.find((index) => index !== doorCell && !expedition.cleared.has(index)
    && neighborIndices(index).some((n) => expedition.cleared.has(n)));
  while (expedition.areaGuesses[0] < AREA_REVEAL_GUESSES && nextToExplore() !== undefined) {
    assert.equal(view().grid.cells[doorCell].content, null, 'not located yet');
    walkTo(context, me, nextToExplore());
  }
  assert.equal(view().grid.cells[doorCell].content, 'door', `door located after ${AREA_REVEAL_GUESSES} songs`);
});

test('two players share the map: same tile, same song; one guess closes it for both', () => {
  const context = createSession({ players: ['p1', 'p2'] });
  const { pool, session, expedition } = context;
  const p1 = session.players.get('p1');
  const p2 = session.players.get('p2');
  const results = [];
  session.on('result', (playerId, result) => results.push({ playerId, ...result }));

  const { x, y } = cellCoords(neighborIndices(p1.position).find((i) => expedition.isWalkable(i)));
  assert.ok(session.move('p1', x, y).ok);
  assert.ok(session.move('p2', x, y).ok);
  assert.equal(session.viewFor('p1').challenge.id, session.viewFor('p2').challenge.id, 'same song');
  const p2View = session.viewFor('p2');
  assert.equal(p2View.players.length, 2);
  assert.ok(p2View.players.every((p) => p.x === x && p.y === y), 'both dots are on the tile');

  assert.ok(session.reroll('p1').ok);
  assert.equal(results.at(-1).playerId, 'p2');
  assert.equal(results.at(-1).kind, 'rerolled');
  assert.equal(results.at(-1).by, 'P1');

  assert.ok(session.guess('p1', answerFor(pool, expedition, p1)).result.correct);
  assert.equal(session.viewFor('p2').challenge, null, "the teammate's song is closed");
  assert.equal(results.at(-1).kind, 'teammate');
  assert.ok(results.at(-1).answer.anime.startsWith('Anime '));
  assert.equal(p1.stats.guessed, 1);
  assert.equal(p2.stats.guessed, 0, 'only the guesser scores');
  assert.equal(session.leaderboard()[0].id, 'p1');
});

test('the center door works, and a door takes the whole team up', () => {
  const context = createSession({ settings: { ...DEFAULT_SETTINGS, floors: 3 }, players: ['p1', 'p2'] });
  const { session, expedition, me } = context;
  const centerDoor = expedition.floor.doors.find((door) => door.areaIndex === NEUTRAL_AREA);
  walkTo(context, me, centerDoor.y * expedition.floor.size + centerDoor.x);
  assert.ok(expedition.foundDoors.has(NEUTRAL_AREA));
  assert.equal(session.enterDoor('p1', NEUTRAL_AREA).ok, false, 'keys are still needed');
  for (const keyCell of cellsWith(expedition, (cell) => cell.content === 'key')) walkTo(context, me, keyCell);
  assert.ok(session.enterDoor('p2', NEUTRAL_AREA).ok, 'any teammate can vote for it');
  assert.equal(expedition.floorNumber, 1, 'the door waits for the whole team');
  const centerView = session.viewFor('p1').grid.doors.find((door) => door.areaIndex === NEUTRAL_AREA);
  assert.deepEqual(centerView.voters, ['p2']);
  assert.ok(session.enterDoor('p1', NEUTRAL_AREA).ok);
  assert.equal(expedition.floorNumber, 2);
  assert.equal(expedition.keys, 0);
  for (const player of session.players.values()) assert.equal(player.position, expedition.startIndex);
});

/** Collects every key and explores the given doors with the first player. */
function prepareDoors(context, areaIndices) {
  const { expedition, me } = context;
  for (const keyCell of cellsWith(expedition, (cell) => cell.content === 'key')) walkTo(context, me, keyCell);
  for (const areaIndex of areaIndices) {
    const door = expedition.floor.doors.find((candidate) => candidate.areaIndex === areaIndex);
    walkTo(context, me, door.y * expedition.floor.size + door.x);
  }
}

test('door vote: a strict majority opens the door, voting again withdraws', () => {
  const context = createSession({ players: ['p1', 'p2', 'p3'] });
  const { session, expedition } = context;
  prepareDoors(context, [0, NEUTRAL_AREA]);
  assert.ok(session.enterDoor('p1', 0).ok);
  assert.ok(session.enterDoor('p1', 0).ok);
  assert.equal(expedition.doorVotes.size, 0, 'the second click withdraws the vote');
  assert.ok(session.enterDoor('p1', 0).ok);
  assert.ok(session.enterDoor('p2', NEUTRAL_AREA).ok);
  assert.equal(expedition.floorNumber, 1);
  const behindDoor = expedition.floor.doors.find((door) => door.areaIndex === 0).tags;
  assert.ok(session.enterDoor('p3', 0).ok);
  assert.equal(expedition.floorNumber, 2, '2 of 3 votes win');
  assert.deepEqual(expedition.floor.areas.map((area) => area.tag), behindDoor);
  assert.equal(expedition.doorVotes.size, 0, 'votes reset on a new floor');
});

test('door vote: a tie is rolled, then the drawn door opens', () => {
  const context = createSession({ players: ['p1', 'p2'] });
  const { session, expedition } = context;
  prepareDoors(context, [0, NEUTRAL_AREA]);
  const now = Date.now();
  assert.ok(session.enterDoor('p1', 0, now).ok);
  assert.ok(session.enterDoor('p2', NEUTRAL_AREA, now).ok);
  const roll = session.viewFor('p1', now).doorRoll;
  assert.deepEqual([...roll.candidates].sort(), [NEUTRAL_AREA, 0]);
  assert.ok(roll.candidates.includes(roll.winner));
  assert.equal(roll.remainingMs, DOOR_ROLL_MS);
  assert.equal(session.enterDoor('p1', NEUTRAL_AREA, now).ok, false, 'votes are locked while rolling');
  const behindDoor = expedition.floor.doors.find((door) => door.areaIndex === roll.winner).tags;

  session.tick(now + DOOR_ROLL_MS);
  assert.equal(expedition.floorNumber, 2);
  assert.equal(expedition.doorRoll, null);
  assert.deepEqual(expedition.floor.areas.map((area) => area.tag), behindDoor);
  session.stop();
});

test('door vote: a disconnected player no longer holds the team back', () => {
  const context = createSession({ players: ['p1', 'p2'] });
  const { session, expedition } = context;
  prepareDoors(context, [NEUTRAL_AREA]);
  assert.ok(session.enterDoor('p2', NEUTRAL_AREA).ok);
  session.setOnline('p1', false);
  assert.equal(expedition.floorNumber, 2, 'the only online player decided');
  assert.equal(session.positions().find((player) => player.id === 'p1').online, false);
});

test('hidden artist areas never send the artists to players', () => {
  const context = createSession({ settings: { ...DEFAULT_SETTINGS, artistAreas: 'hidden' } });
  const { session, expedition } = context;
  const artistTag = `${ARTIST_TAG_PREFIX}A & B`;
  expedition.floor.areas[0].tag = artistTag;
  const view = session.viewFor('p1');
  assert.equal(view.grid.areas[0].tag, ARTIST_TAG_HIDDEN);
  assert.ok(!JSON.stringify(view).includes(artistTag));
});

test('a collected key disappears from the map', () => {
  const context = createSession();
  const { session, expedition, me } = context;
  const keyCell = cellsWith(expedition, (cell) => cell.content === 'key')[0];
  walkTo(context, me, keyCell);
  assert.equal(expedition.keys, 1);
  assert.equal(session.viewFor('p1').grid.cells[keyCell].content, null);
  assert.deepEqual(session.viewFor('p1').keyAreas, [expedition.floor.cells[keyCell].areaIndex],
    'the HUD knows which sector the key came from');
  const doorCell = cellsWith(expedition, (cell) => cell.content === 'door')[0];
  walkTo(context, me, doorCell);
  assert.equal(session.viewFor('p1').grid.cells[doorCell].content, 'door', 'doors stay visible');
});

test('at most 2 songs of the same anime play in one area per floor', () => {
  const context = createSession();
  const { session, expedition, me } = context;
  const served = new Map();
  const seenTileSongs = new Set();
  const recordTile = () => {
    const tileSong = expedition.tileSongs.get(me.position);
    if (seenTileSongs.has(tileSong.id)) return; // stepping back onto a tile replays the same song
    seenTileSongs.add(tileSong.id);
    const area = expedition.floor.cells[me.position].areaIndex;
    const key = `${area}:${tileSong.song.animeId}`;
    served.set(key, (served.get(key) ?? 0) + 1);
  };
  session.on('player', (playerId) => {
    if (playerId === 'p1' && expedition.tileSongs.has(me.position) && !expedition.cleared.has(me.position)) recordTile();
  });
  // Explore a whole sector, rerolling on the way to serve even more songs.
  me.rerolls = 99;
  for (const cell of cellsWith(expedition, (c) => c.areaIndex === 0)) {
    const [next] = pathTo(expedition, me, cell);
    if (next === undefined) continue;
    walkTo(context, me, cell);
    const step = neighborIndices(me.position).find((i) => !expedition.cleared.has(i) && expedition.isWalkable(i)
      && expedition.floor.cells[i].areaIndex === 0);
    if (step === undefined) continue;
    const { x, y } = cellCoords(step);
    session.move('p1', x, y);
    // One reroll per tile keeps the total under the quota's capacity (20 anime × 2 per area),
    // beyond which the game deliberately allows repeats rather than running out of songs.
    session.reroll('p1');
    session.move('p1', cellCoords(cell).x, cellCoords(cell).y);
  }
  assert.ok(served.size > 0);
  for (const [key, count] of served) assert.ok(count <= 2, `${key} served ${count} times`);
});

test('any-season answers: franchise names are accepted (Symphogear for Senki Zesshou Symphogear G)', () => {
  const library = decodeLibrary({
    anime: [
      [1, 0, 'Senki Zesshou Symphogear', 'Symphogear', [], ['Action'], []],
      [2, 0, 'Senki Zesshou Symphogear G', '', [], ['Action'], []],
      [3, 0, 'Senki', '', [], ['Action'], []],
      [4, 0, 'Senki Tenshou', '', [], ['Action'], []],
    ],
    songs: [[10, 2, 'Zettou Ame-no-Habakiri', 'Nana Mizuki', 1, 1, 50, 'x.mp3', [], '']],
  });
  const pool = new SongPool(library, { songTypes: ['OP'], aniListIds: null });
  const [song] = pool.songs;
  const keys = pool.answerKeysFor(song, { anySeason: true });
  for (const answer of ['Senki Zesshou Symphogear G', 'Symphogear', 'Symphogear G', 'Senki Zesshou Symphogear']) {
    assert.ok(isCorrectAnswer(answer, keys), answer);
    assert.ok(pool.isAnimeAnswer(song, answer, { anySeason: true }), answer);
  }
  assert.ok(!isCorrectAnswer('Senki Tenshou', keys), 'a different show sharing a first word is refused');

  assert.ok(pool.isAnimeAnswer(song, 'Senki Zesshou Symphogear G'), 'the exact anime is always right');
  for (const answer of ['Symphogear', 'Senki Zesshou Symphogear']) {
    assert.ok(!pool.isAnimeAnswer(song, answer), `by default, another season is wrong: ${answer}`);
  }
});

test('by default only the exact anime and its alternative answers are accepted', () => {
  const library = decodeLibrary({
    anime: [
      [1, 0, 'Shingeki no Kyojin', 'Attack on Titan', [], ['Action'], []],
      [2, 0, 'Shingeki no Kyojin Season 2', 'Attack on Titan Season 2', [], ['Action'], []],
      [3, 0, 'Shingeki no Kyojin Season 3', 'Attack on Titan Season 3', [], ['Action'], []],
    ],
    songs: [[10, 2, 'Shinzou wo Sasageyo!', 'Linked Horizon', 1, 1, 50, 'x.mp3', ['Shingeki no Kyojin Season 3']]],
  });
  const pool = new SongPool(library, { songTypes: ['OP'], aniListIds: null });
  const [song] = pool.songs;
  for (const answer of ['Attack on Titan Season 2', 'shingeki no kyojn season 2', 'Shingeki no Kyojin Season 3']) {
    assert.ok(pool.isAnimeAnswer(song, answer), `${answer} is accepted`);
  }
  assert.ok(!pool.isAnimeAnswer(song, 'Attack on Titan'), 'the first season is another anime');
  assert.ok(!pool.isAnimeAnswer(song, 'Attack on Titan Season 4'), 'a typo cannot change the season number');
  assert.ok(pool.isAnimeAnswer(song, 'Attack on Titan', { anySeason: true }), 'unless any season is allowed');
});

test('the season range keeps only anime aired within it', () => {
  const library = decodeLibrary({
    anime: [
      [1, 0, 'Old', '', [], ['Action'], [], 1999, 3],
      [2, 0, 'Start', '', [], ['Action'], [], 2000, 0],
      [3, 0, 'End', '', [], ['Action'], [], 2009, 3],
      [4, 0, 'New', '', [], ['Action'], [], 2010, 0],
      [5, 0, 'Unknown', '', [], ['Action'], []],
    ],
    songs: [1, 2, 3, 4, 5].map((id) => [id * 10, id, `Song ${id}`, 'Artist', 1, 1, 50, `${id}.mp3`, []]),
  });
  const range = { from: 2000 * 4, to: 2009 * 4 + 3 };
  const pool = new SongPool(library, { songTypes: ['OP'], aniListIds: null, seasons: range });
  assert.deepEqual(pool.songs.map((song) => pool.getAnime(song).displayName), ['Start', 'End']);
  assert.equal(new SongPool(library, { songTypes: ['OP'], aniListIds: null }).songs.length, 5);
});

test('a fill pool takes over once the lists have no unplayed song left', () => {
  const library = makeLibrary();
  const pool = new SongPool(library, { songTypes: ['OP', 'ED', 'IN'], aniListIds: [1001, 1002] });
  const fillPool = new SongPool(library, { songTypes: ['OP', 'ED', 'IN'], aniListIds: null });
  const session = new GameSession({ pool, fillPool, settings: DEFAULT_SETTINGS, players: [{ id: 'p1', name: 'P1' }] });
  const context = { session, pool, expedition: session.expedition, me: session.players.get('p1') };
  const listed = new Set(pool.songs.map((song) => song.id));
  for (const cell of cellsWith(context.expedition, (c) => c.content === 'door' || c.content === 'key')) {
    walkTo(context, context.me, cell);
  }
  const played = [...context.expedition.playedSongIds];
  assert.ok(played.length > listed.size, 'more songs were played than the lists hold');
  assert.ok(played.some((id) => !listed.has(id)), 'filler songs come from the library');
});

function createSongArtistSession() {
  const library = decodeLibrary({
    anime: [[1, 0, 'Show', '', [], ['Action'], []]],
    songs: [[10, 1, 'Niji-iro no Flugel', 'Aoi Yuki x Nana Mizuki', 1, 1, 50, 'x.mp3', [], 'g1']],
    artists: { g1: [['Aoi Yuki x Nana Mizuki', 'Flugel Duo'], [['Nana Mizuki'], ['Aoi Yuki', 'Aoi Yabusaki']]] },
  });
  const pool = new SongPool(library, { songTypes: ['OP'], aniListIds: null });
  const settings = { ...DEFAULT_SETTINGS, answerMode: 'songArtist' };
  const session = new GameSession({
    pool, settings, players: [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }],
  });
  const { expedition } = session;
  const p1 = session.players.get('p1');
  const p2 = session.players.get('p2');
  const tile = neighborIndices(p1.position).find((i) => expedition.isWalkable(i));
  return { pool, session, expedition, p1, p2, tile, start: p1.position };
}

test('S/A mode: parts are checked one by one and kept on the tile for the team', () => {
  const { session, expedition, p1, p2, tile, start } = createSongArtistSession();
  const results = [];
  session.on('result', (playerId, result) => results.push({ playerId, ...result }));
  const { x, y } = cellCoords(tile);
  assert.ok(session.move('p1', x, y).ok);
  assert.ok(session.move('p2', x, y).ok);

  assert.equal(session.guess('p1', {}).ok, false, 'something must be typed');
  assert.deepEqual(session.guess('p1', { song: 'Synchrogazer' }).result.missed, ['song']);
  assert.equal(session.guess('p1', 'Show').ok, false, 'anime names are not answers in S/A mode');

  const songFound = session.guess('p1', { song: 'niji iro no flugel' }).result;
  assert.equal(songFound.kind, 'progress');
  assert.deepEqual(songFound.found, ['song']);
  assert.ok(!expedition.cleared.has(tile), 'the song name alone does not open the tile');
  assert.equal(results.at(-1).playerId, 'p2', 'the teammate on the tile is told right away');
  assert.equal(session.viewFor('p2').challenge.progress.song, 'Niji-iro no Flugel');

  // P1 leaves; the progress stays on the tile for P2.
  assert.ok(session.move('p1', cellCoords(start).x, cellCoords(start).y).ok);
  const member = session.guess('p2', { artist: 'Nana Mizuki' }).result;
  assert.deepEqual(member.found, ['member']);
  assert.deepEqual(member.summary.members, ['Nana Mizuki']);
  assert.deepEqual(session.viewFor('p2').grid.cells[tile].progress,
    { song: true, artist: false, members: 1, memberCount: 2 }, 'the map shows S and 1/2');
  assert.equal(session.guess('p2', { artist: 'Nana Mizuki' }).result.kind, 'known');

  const solved = session.guess('p2', { artist: 'Aoi Yabusaki' }).result;
  assert.equal(solved.kind, 'correct', 'naming every member completes the artist');
  assert.ok(expedition.cleared.has(tile));
  assert.equal(p1.stats.guessed, 1, 'everyone who found a part scores');
  assert.equal(p2.stats.guessed, 1);
  assert.deepEqual([p1.stats.songsFound, p1.stats.artistsFound], [1, 0], 'P1 found the song name');
  assert.deepEqual([p2.stats.songsFound, p2.stats.artistsFound], [0, 1], 'P2 completed the artist');
  const p2Entry = session.leaderboard().find((entry) => entry.id === 'p2');
  assert.deepEqual([p2Entry.songsFound, p2Entry.artistsFound], [0, 1]);
  assert.equal(session.results().answerMode, 'songArtist');
  assert.equal(session.viewFor('p2').tileAnswer.title, 'Niji-iro no Flugel', 'the explored tile shows its answer');
  assert.equal(session.viewFor('p1').tileAnswer, null, 'the start tile had no song');
});

test('S/A mode: the group name or an alias completes the artist at once; rerolls reset progress', () => {
  const { session, expedition, p1, tile } = createSongArtistSession();
  const { x, y } = cellCoords(tile);
  assert.ok(session.move('p1', x, y).ok);
  assert.equal(session.guess('p1', { song: 'Niji-iro no Flugel' }).result.kind, 'progress');
  p1.rerolls = 1;
  assert.ok(session.reroll('p1').ok);
  assert.equal(session.viewFor('p1').challenge.progress.song, null, 'a new song starts from scratch');

  const both = session.guess('p1', { song: 'Niji-iro no Flugel', artist: 'Flugel Duo' }).result;
  assert.equal(both.kind, 'correct');
  assert.ok(expedition.cleared.has(tile));
});

function createArtistLibrary() {
  const anime = [];
  const songs = [];
  for (let id = 1; id <= 40; id++) {
    anime.push([id, 0, `Anime ${id}`, '', [], ['Action'], []]);
    // Artists A and B have 12 songs each, every other artist only one.
    const artist = id <= 12 ? 'A' : id <= 24 ? 'B' : `Solo ${id}`;
    songs.push([id * 10, id, `Song ${id}`, artist, 1, 1, 50, `${id}.mp3`, [], `a-${artist}`]);
  }
  return decodeLibrary({ anime, songs, artists: {} });
}

test('artist areas pair 2 artists with enough songs and only play their songs', () => {
  const pool = new SongPool(createArtistLibrary(), { songTypes: ['OP'], aniListIds: null });
  const rng = createRng('artists');
  const tag = pool.createArtistTag(rng, 15);
  assert.equal(tag, `${ARTIST_TAG_PREFIX}A & B`, 'one-off artists are never picked');
  assert.ok(pool.candidatesFor(tag).every((song) => song.artist === 'A' || song.artist === 'B'));
  assert.equal(pool.candidatesFor(tag).length, 24);
  assert.equal(pool.createArtistTag(rng, 25), null, 'the 2 artists must fill the whole area');
  assert.ok(!pool.eligibleTags().includes(tag), 'artist areas are not regular themes');
});

test('timer ends the game', () => {
  const now = Date.now();
  const { session } = createSession({ songTypes: ['OP'], now });
  let ended = null;
  session.on('end', (results) => { ended = results; });
  session.tick(now + DEFAULT_SETTINGS.timeLimitMin * 60_000);
  assert.ok(ended);
  assert.equal(ended.finished, false);
  assert.equal(ended.floorReached, 1);
});

class FakeTransport extends Emitter {
  code = 'TEST23';
  destroy() {}
}

function createClient(mode) {
  const store = new Store(createInitialState(mode));
  return { store, client: new GameClient(store) };
}

test('host and guest go from lobby to a shared game and back through the server', async () => {
  const transport = new FakeTransport();
  const avatars = [{ id: 'cat.png', name: 'cat', url: 'data:image/webp;base64,AAAA' }];
  const server = new HostServer(transport, makeLibrary(), avatars);

  const host = createClient('host');
  host.client.attach(server.connectLocal());
  const guest = createClient('join');
  const [serverSide, clientSide] = createLoopbackPair('guest');
  transport.emit('connection', serverSide);
  guest.client.attach(clientSide);
  await tick();

  assert.equal(host.store.state.isHost, true);
  assert.equal(guest.store.state.lobby.players.length, 2);
  assert.deepEqual(guest.store.state.avatars, avatars, 'the host sends its avatar catalog');

  host.client.updateSettings({ floors: 3, songTypes: ['OP', 'ED'] });
  guest.client.updateSettings({ floors: 9 });
  guest.client.setProfile({ name: 'Guesty', anilist: '', avatar: 'cat.png', statuses: ['COMPLETED'] });
  host.client.setProfile({ avatar: 'not-a-file.png' });
  await tick();
  const lobbyPlayers = guest.store.state.lobby.players;
  const guesty = lobbyPlayers.find((p) => p.name === 'Guesty');
  assert.equal(guest.store.state.lobby.settings.floors, 3, 'only the host changes settings');
  assert.equal(guesty.avatar, 'cat.png');
  assert.deepEqual(guesty.statuses, ['COMPLETED']);
  assert.equal(lobbyPlayers.find((p) => p.isHost).avatar, '', 'unknown avatars are refused');

  guest.client.setReady(true);
  await tick();
  host.client.startGame();
  await tick();
  await tick();

  for (const { store } of [host, guest]) {
    assert.equal(store.state.lobby.phase, 'playing');
    assert.ok(store.state.run.grid);
    assert.equal(store.state.run.players.length, 2, 'everyone sees both dots');
  }

  const { position } = guest.store.state.run;
  const target = [[0, -1], [0, 1], [-1, 0], [1, 0]]
    .map(([dx, dy]) => ({ x: position.x + dx, y: position.y + dy }))
    .find(({ x, y }) => guest.store.state.run.grid.cells[y * 15 + x].state !== 'void');
  guest.client.move(target.x, target.y);
  await tick();
  assert.ok(guest.store.state.run.challenge.media[0].startsWith('https://'));
  const guestDot = host.store.state.run.players.find((p) => p.name === 'Guesty');
  assert.deepEqual({ x: guestDot.x, y: guestDot.y }, target, "the host sees the guest's dot move");

  guest.client.guess({ text: 'nope' });
  await tick();
  assert.equal(guest.store.state.lastResult.kind, 'wrong');

  guest.client.returnToLobby();
  await tick();
  assert.equal(guest.store.state.lobby.phase, 'playing', 'only the host can end the expedition');

  host.client.returnToLobby();
  await tick();
  for (const { store } of [host, guest]) {
    assert.equal(store.state.lobby.phase, 'lobby', 'everyone is back in the lobby');
    assert.equal(store.state.lobby.code, 'TEST23', 'same room code');
    assert.equal(store.state.run, null);
  }
  assert.equal(guest.store.state.lobby.players.find((p) => p.name === 'Guesty').ready, false);

  clientSide.close();
  await tick();
  assert.equal(host.store.state.lobby.players.length, 1, 'leaving the lobby removes the player');
  server.shutdown();
});

test('a disconnected player rejoins mid-game from a new tab by typing their name', async () => {
  const transport = new FakeTransport();
  const server = new HostServer(transport, makeLibrary());
  const host = createClient('host');
  host.client.attach(server.connectLocal());

  const connectGuest = () => {
    const guest = createClient('join');
    const [serverSide, clientSide] = createLoopbackPair('guest');
    transport.emit('connection', serverSide);
    guest.client.attach(clientSide);
    return { ...guest, clientSide };
  };
  const first = connectGuest();
  await tick();
  first.client.setProfile({ name: 'Guesty' });
  first.client.setReady(true);
  await tick();
  host.client.startGame('duplicates');
  await tick();
  await tick();
  assert.equal(first.store.state.lobby.phase, 'playing');
  const guestId = first.store.state.playerId;

  first.clientSide.close();
  await tick();
  assert.equal(host.store.state.leaderboard.find((e) => e.id === guestId).online, false);

  // A new tab has a new token (no sessionStorage in Node: every connection gets a fresh one),
  // so the server asks for a name instead of refusing.
  const second = connectGuest();
  await tick();
  assert.notEqual(second.store.state.connection.status, 'connected');
  assert.deepEqual(second.store.state.rejoin, { error: '', pending: false });

  second.client.rejoin('Someone Else');
  await tick();
  assert.ok(second.store.state.rejoin.error, 'unknown names are refused');

  second.client.rejoin('guesty');
  await tick();
  await tick();
  assert.equal(second.store.state.connection.status, 'connected');
  assert.equal(second.store.state.playerId, guestId, 'same player slot');
  assert.ok(second.store.state.run.grid, 'the game state is sent again');
  assert.equal(host.store.state.leaderboard.find((e) => e.id === guestId).online, true);
  server.shutdown();
});

test('the host is asked what to do when the pool is too small for every floor', async () => {
  const transport = new FakeTransport();
  const server = new HostServer(transport, makeLibrary());
  const host = createClient('host');
  host.client.attach(server.connectLocal());
  await tick();

  host.client.startGame();
  await tick();
  await tick();
  assert.equal(host.store.state.lobby.phase, 'lobby', 'the game waits for the host');
  assert.deepEqual(host.store.state.poolShortage, { songCount: 80, needed: 240, canFill: false, fromLists: false });

  host.client.dismissShortage();
  assert.equal(host.store.state.poolShortage, null, 'cancel closes the prompt');

  host.client.startGame('duplicates');
  await tick();
  await tick();
  assert.equal(host.store.state.lobby.phase, 'playing');
  assert.equal(host.store.state.poolShortage, null);
  server.shutdown();
});
