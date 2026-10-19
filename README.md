# Anisong Dungeon

A co-op anime song guessing game. Explore a dungeon with your friends, guess songs to open tiles,
collect keys and climb as high as you can before time runs out.

## Getting started (Windows)

1. Download the project (**Code → Download ZIP**) and unzip it.
2. Double-click **`AnisongDungeon.cmd`**.
3. Choose **Host** to create a room, or **Join** to enter a friend's room code.

No port forwarding needed, just an internet connection. The launcher checks for updates each
time you open it.

## Song library

The game comes with a password-protected song library.

- **Have the password?** The launcher asks for it on first start and can remember it.
  Library updates come with the normal game updates.
- **No password?** Build your own library: put a `library.db` in `data/`
  (needs [Node.js](https://nodejs.org) 22.5+), or a `library.json` in `app/data/`.
  Without either, the launcher closes.

## How to play

- Move with **WASD** / **ZQSD** / **arrow keys**.
- Step on a tile to hear its song, then type the anime name.
- A right answer opens the tile for the whole team.
- Each area hides a **key** and a **door**. Get 3 keys, then vote for a door to reach the next floor.
- Stuck on a song? Use a **reroll** to swap it.

## Options

The host can pick the song types, number of floors, time limit, answer mode (anime, or song +
artist), and a season range (e.g. 2000 → 2009). Link your **AniList** to play songs from the
anime you've watched.

Drop `.png` / `.webp` images into `app/avatars/` to add avatars.

## Development

```bash
npm test                # tests (Node 22.5+)
npm run check           # syntax check
npm run export-library  # build app/data/library.json from data/library.db
npm run encrypt-library # encrypt it into library/library.enc (asks for the password)
```

`tools/export-library.mjs` describes the database format it expects.
