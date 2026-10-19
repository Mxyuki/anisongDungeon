import { h } from '../dom.js';
import { icon } from '../icons.js';
import { playerToken } from './playerToken.js';

const CONTENT_ICONS = { start: 'start', key: 'key', door: 'door' };
const EDGES = [[0, -1, 't'], [1, 0, 'r'], [0, 1, 'b'], [-1, 0, 'l']];
/** Tokens drawn on one cell before collapsing the rest into a "+n" badge. */
const MAX_TOKENS_PER_CELL = 4;

/**
 * The floor map with fog of war and every player's dot.
 * Cells are created once per grid size and patched on update.
 */
export class DungeonGrid {
  root = h('div', { class: 'dungeon', role: 'grid', 'aria-label': 'Dungeon floor' });
  /** @type {HTMLElement[]} */ #cells = [];
  #size = 0;
  /** Last rendered signature per cell, to skip unchanged cells. */
  #signatures = [];
  #onSelect;

  /** @param {{ onSelect: (x: number, y: number) => void }} options */
  constructor({ onSelect }) {
    this.#onSelect = onSelect;
  }

  /**
   * @param {object} grid               Server grid view.
   * @param {object[]} players          Everyone's dot: { id, name, avatar, color, x, y }.
   * @param {string} selfId
   * @param {boolean} onChallenge       True while the local player stands on a song.
   * @param {Map<string, {url: string}>} avatarsById
   */
  update(grid, players, selfId, onChallenge, avatarsById) {
    if (grid.size !== this.#size) this.#build(grid.size);
    const discovered = new Set(grid.areas.filter((area) => area.discovered).map((area) => area.index));
    const playersByCell = new Map();
    // The local player is listed first so their token is always drawn.
    const ordered = [...players.filter((p) => p.id === selfId), ...players.filter((p) => p.id !== selfId)];
    for (const player of ordered) {
      const index = player.y * grid.size + player.x;
      if (!playersByCell.has(index)) playersByCell.set(index, []);
      playersByCell.get(index).push(player);
    }

    grid.cells.forEach((cell, index) => {
      const x = index % grid.size;
      const y = Math.floor(index / grid.size);
      const here = playersByCell.get(index) ?? [];
      const hasSelf = here.some((player) => player.id === selfId);
      const classes = this.#classesFor(grid, cell, x, y, discovered);
      if (here.length > 0) classes.push('cell--occupied');
      if (hasSelf && onChallenge) classes.push('cell--challenge');
      const className = classes.join(' ');
      const badge = progressBadge(cell.progress);
      const signature = `${className}|${cell.content}|${badge}|${here.map((p) => `${p.id}:${p.avatar}`).join(',')}`;
      if (this.#signatures[index] === signature) return;
      this.#signatures[index] = signature;
      this.#renderCell(this.#cells[index], className, cell, here, selfId, avatarsById, badge);
    });
  }

  #classesFor(grid, cell, x, y, discovered) {
    const classes = ['cell', `cell--${cell.state}`];
    if (cell.state === 'void') return classes;
    if (cell.area === -1) classes.push('cell--neutral');
    if (cell.area !== null && cell.area >= 0) classes.push(`cell--area-${cell.area}`);
    if (cell.content && cell.state !== 'cleared') classes.push('cell--marker');

    // Outline of discovered sectors (not the hub): an edge wherever the neighbor is another area.
    if (cell.area !== null && cell.area >= 0 && discovered.has(cell.area)) {
      for (const [dx, dy, side] of EDGES) {
        const nx = x + dx;
        const ny = y + dy;
        const outside = nx < 0 || ny < 0 || nx >= grid.size || ny >= grid.size;
        if (outside || grid.cells[ny * grid.size + nx].area !== cell.area) classes.push(`cell--edge-${side}`);
      }
    }
    return classes;
  }

  #build(size) {
    this.#size = size;
    this.#signatures = [];
    this.root.style.setProperty('--grid-size', String(size));
    this.#cells = Array.from({ length: size * size }, (_, index) => h('div', {
      class: 'cell',
      role: 'gridcell',
      onClick: () => this.#onSelect(index % size, Math.floor(index / size)),
    }));
    this.root.replaceChildren(...this.#cells);
  }

  #renderCell(element, className, cell, here, selfId, avatarsById, badge) {
    element.className = className;
    element.replaceChildren();
    if (cell.content) element.append(icon(CONTENT_ICONS[cell.content], `cell__icon cell__icon--${cell.content}`));
    if (badge) element.append(h('span', { class: 'cell__progress', text: badge, title: describeProgress(cell.progress) }));
    if (here.length > 0) element.append(this.#tokens(here, selfId, avatarsById));
    const names = here.map((player) => (player.id === selfId ? 'you' : player.name));
    element.setAttribute('aria-label', [describeCell(cell), ...names].join(', '));
  }

  /** One big token alone; several players share the cell in a 2×2 layout with a "+n" badge. */
  #tokens(here, selfId, avatarsById) {
    const shown = here.length > MAX_TOKENS_PER_CELL ? here.slice(0, MAX_TOKENS_PER_CELL - 1) : here;
    const group = h('span', { class: `cell__players cell__players--${Math.min(here.length, MAX_TOKENS_PER_CELL)}` },
      shown.map((player) => playerToken(player, avatarsById, { self: player.id === selfId })));
    if (here.length > shown.length) {
      group.append(h('span', { class: 'token token--more', text: `+${here.length - shown.length}` }));
    }
    group.title = here.map((player) => player.name).join(', ');
    return group;
  }
}

/**
 * Compact S/A progress shown on a tile: "S" song found, "A" artist found, "2/5" members found.
 * Empty when nothing was found yet.
 */
function progressBadge(progress) {
  if (!progress) return '';
  const parts = [];
  if (progress.song) parts.push('S');
  if (progress.artist) parts.push('A');
  else if (progress.members > 0) parts.push(`${progress.members}/${progress.memberCount}`);
  return parts.join('·');
}

function describeProgress(progress) {
  const parts = [progress.song ? 'song name found' : 'song name missing'];
  if (progress.artist) parts.push('artist found');
  else if (progress.memberCount > 0) parts.push(`${progress.members}/${progress.memberCount} members found`);
  else parts.push('artist missing');
  return parts.join(', ');
}

function describeCell(cell) {
  if (cell.state === 'hidden') return cell.content ? `${cell.content} (located)` : 'unknown';
  if (cell.content) return cell.state === 'cleared' ? `${cell.content} (explored)` : `${cell.content} (located)`;
  if (cell.state === 'void') return 'nothing';
  return cell.state === 'cleared' ? 'explored' : 'unexplored';
}
