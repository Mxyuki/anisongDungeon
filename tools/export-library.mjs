/**
 * Exports data/library.db (AMQ-format SQLite) into app/data/library.json, the compact format
 * the host's browser loads. Run with: npm run export-library   (Node >= 22.5)
 *
 * Output format (arrays keep the file small):
 *   anime:   [annId, aniListId|0, nameJa, nameEn, otherNames[], genres[], tags[], year|0,
 *             season(0 Winter, 1 Spring, 2 Summer, 3 Fall)|-1]
 *   songs:   [annSongId, annId, title, artist, type(1 OP|2 ED|3 IN), number, guessRate|-1, mp3,
 *             altAnswers[], artistRef]
 *   artists: { [artistRef]: [names[], members[][]] }  artistRef = "a<id>" (artist) / "g<id>" (group)
 *            names: the credited name + the artist/group's alternative names.
 *            members: for groups, each member's names (member name + its alternative names).
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FORMAT_VERSION = 4;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = process.argv[2] ?? join(ROOT, 'data', 'library.db');
const TARGET = process.argv[3] ?? join(ROOT, 'app', 'data', 'library.json');

const parseJson = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};

function exportAnime(db) {
  const rows = db.prepare(
    'SELECT annId, aniListId, nameEn, nameJa, names, genres, tags, year, seasonId FROM anime ORDER BY annId',
  ).all();
  return rows.map((row) => {
    const main = new Set([row.nameJa, row.nameEn].filter(Boolean));
    const others = parseJson(row.names, [])
      .map((entry) => entry.name)
      .filter((name) => name && !main.has(name));
    return [
      row.annId,
      row.aniListId ?? 0,
      row.nameJa ?? row.nameEn ?? '',
      row.nameEn ?? '',
      [...new Set(others)],
      parseJson(row.genres, []),
      parseJson(row.tags, []),
      row.year ?? 0,
      row.seasonId ?? -1,
    ];
  });
}

/** Resolves accepted artist names for artists and groups (alt names, group members). */
function createArtistResolver(db) {
  const artists = new Map(db.prepare('SELECT songArtistId, name, altNameLinks FROM artists').all()
    .map((row) => [row.songArtistId, { name: row.name, links: parseJson(row.altNameLinks, []) }]));
  const groups = new Map(db.prepare('SELECT groupId, name, altNameLinks FROM artistGroups').all()
    .map((row) => [row.groupId, { name: row.name, links: parseJson(row.altNameLinks, []), members: [] }]));
  for (const row of db.prepare('SELECT groupId, memberType, memberId FROM groupMembers').all()) {
    groups.get(row.groupId)?.members.push({ type: row.memberType, id: row.memberId });
  }

  const namesOf = (table, id) => {
    const entry = table.get(id);
    if (!entry) return [];
    return [entry.name, ...entry.links.map((link) => table.get(link)?.name)].filter(Boolean);
  };
  const artistNames = (id) => namesOf(artists, id);
  const groupMembers = (id) => (groups.get(id)?.members ?? [])
    .map((member) => (member.type === 'artist' ? artistNames(member.id) : namesOf(groups, member.id)))
    .map((names) => [...new Set(names)])
    .filter((names) => names.length > 0);
  return {
    artist: (id) => ({ names: artistNames(id), members: [] }),
    group: (id) => ({ names: namesOf(groups, id), members: groupMembers(id) }),
  };
}

function exportSongs(db, artistTable) {
  const resolver = createArtistResolver(db);
  const rows = db.prepare(`
    SELECT s.annSongId, s.annId, s.name, s.artist, s.type, s.number, s.difficulty,
           s.altAnimeNamesAnswers, s.songArtistId, s.songGroupId, l.fileName
    FROM songs s
    JOIN links l ON l.annSongId = s.annSongId AND l.quality = 'mp3'
    WHERE s.uploaded = 1 AND s.dub = 0 AND s.rebroadcast = 0 AND s.type IN (1, 2, 3)
    ORDER BY s.annSongId
  `).all();
  return rows.map((row) => {
    const artistRef = row.songGroupId ? `g${row.songGroupId}` : row.songArtistId ? `a${row.songArtistId}` : '';
    if (artistRef && !(artistRef in artistTable)) {
      const entity = row.songGroupId ? resolver.group(row.songGroupId) : resolver.artist(row.songArtistId);
      artistTable[artistRef] = [[...new Set([row.artist, ...entity.names].filter(Boolean))], entity.members];
    }
    return [
      row.annSongId,
      row.annId,
      row.name ?? '',
      row.artist ?? '',
      row.type,
      row.number ?? 0,
      row.difficulty == null ? -1 : Math.round(row.difficulty),
      row.fileName,
      parseJson(row.altAnimeNamesAnswers, []),
      artistRef,
    ];
  });
}

const db = new DatabaseSync(SOURCE, { readOnly: true });
const artists = {};
const library = {
  version: FORMAT_VERSION,
  generatedAt: new Date().toISOString(),
  anime: exportAnime(db),
  songs: exportSongs(db, artists),
  artists,
};
db.close();

mkdirSync(dirname(TARGET), { recursive: true });
writeFileSync(TARGET, JSON.stringify(library));
console.log(`Exported ${library.anime.length} anime, ${library.songs.length} songs and `
  + `${Object.keys(artists).length} artists → ${TARGET}`);
