import { h, panel, replaceChildren, setText } from '../dom.js';
import { formatTag, NEUTRAL_AREA, SECTOR_LETTERS } from '../format.js';
import { icon } from '../icons.js';
import { answerDetails } from './answerDetails.js';

const CONTENT_ICONS = { start: 'start', key: 'key', door: 'door' };
const CONTENT_NAMES = { start: 'Entrance', key: 'Key', door: 'Door' };
const STATE_TEXT = {
  answered: 'Answered',
  unanswered: 'Not found: the song was left unanswered',
  unvisited: 'Never visited (no song was drawn)',
};

/**
 * Post-game map review: every floor played, without fog. Clicking a tile shows its song, who
 * found it, and the songs rerolled away on it.
 *
 * Floor shape (from the server's results): { number, size, areas: [{ index, tag }], cells: [{
 * state: 'void'|'answered'|'unanswered'|'unvisited', area, content, answer, solvers, rerolls }] }
 */
export class FloorReview {
  root;
  #floors = [];
  #floorIndex = 0;
  #selected = null;
  #els = {};

  /** @param {{ onBack: () => void }} options */
  constructor({ onBack }) {
    const els = this.#els;
    els.tabs = h('div', { class: 'review__tabs', role: 'tablist', 'aria-label': 'Floors' });
    els.grid = h('div', { class: 'review__grid', role: 'grid', 'aria-label': 'Floor map' });
    els.detail = h('div', { class: 'review__detail' });
    els.title = h('span', { class: 'review__floor' });
    const legend = h('div', { class: 'legend' },
      h('span', { class: 'legend__item' }, h('span', { class: 'legend__swatch review-swatch--answered' }), 'Answered'),
      h('span', { class: 'legend__item' }, h('span', { class: 'legend__swatch review-swatch--unanswered' }), 'Not found'),
      h('span', { class: 'legend__item' }, h('span', { class: 'legend__swatch review-swatch--unvisited' }), 'Not visited'),
      h('span', { class: 'legend__item' }, h('span', { class: 'review-cell__rerolls', text: '↻' }), 'Rerolled'));
    const back = h('button', { class: 'btn btn--ghost', type: 'button', onClick: onBack },
      icon('replay'), 'Back to ranking');

    this.root = panel({ title: 'Floor Maps', code: 'ARCHIVE // MAP', className: 'review' },
      h('div', { class: 'review__top' }, els.tabs, back),
      h('div', { class: 'review__body' },
        h('div', { class: 'review__map' }, els.title, els.grid, legend),
        els.detail)).root;
  }

  /**
   * @param {object[]} floors  Results' floor reviews (oldest first).
   */
  setFloors(floors) {
    if (floors === this.#floors) return;
    this.#floors = floors ?? [];
    this.#floorIndex = 0;
    this.#selected = null;
    replaceChildren(this.#els.tabs, this.#floors.map((floor, index) => h('button', {
      class: 'review__tab',
      type: 'button',
      role: 'tab',
      dataset: { index },
      onClick: () => this.#showFloor(index),
    }, `F${floor.number}`)));
    this.#render();
  }

  #showFloor(index) {
    this.#floorIndex = index;
    this.#selected = null;
    this.#render();
  }

  #select(index) {
    this.#selected = index;
    this.#render();
  }

  #render() {
    const floor = this.#floors[this.#floorIndex];
    for (const tab of this.#els.tabs.children) {
      const active = Number(tab.dataset.index) === this.#floorIndex;
      tab.classList.toggle('review__tab--active', active);
      tab.setAttribute('aria-selected', String(active));
    }
    if (!floor) {
      replaceChildren(this.#els.grid);
      replaceChildren(this.#els.detail, h('p', { class: 'hint', text: 'No floor was played.' }));
      return;
    }
    const answered = floor.cells.filter((cell) => cell.state === 'answered').length;
    setText(this.#els.title, `Floor ${floor.number} · ${answered} tiles answered`);
    this.#els.grid.style.setProperty('--grid-size', String(floor.size));
    replaceChildren(this.#els.grid, floor.cells.map((cell, index) => this.#cell(cell, index)));
    this.#renderDetail(floor);
  }

  #cell(cell, index) {
    if (cell.state === 'void') return h('div', { class: 'review-cell review-cell--void' });
    const area = cell.area === NEUTRAL_AREA ? 'review-cell--neutral' : `review-cell--area-${cell.area}`;
    const selected = index === this.#selected ? ' review-cell--selected' : '';
    return h('button', {
      class: `review-cell review-cell--${cell.state} ${area}${selected}`,
      type: 'button',
      'aria-label': describe(cell),
      onClick: () => this.#select(index),
    },
    cell.content && icon(CONTENT_ICONS[cell.content], 'review-cell__icon'),
    cell.rerolls.length > 0 && h('span', { class: 'review-cell__rerolls', text: `↻${cell.rerolls.length}` }));
  }

  #renderDetail(floor) {
    const cell = floor.cells[this.#selected];
    if (!cell || cell.state === 'void') {
      replaceChildren(this.#els.detail,
        h('p', { class: 'review__placeholder', text: 'Click a tile to see its song, who found it, and the songs rerolled away.' }));
      return;
    }
    replaceChildren(this.#els.detail,
      h('p', { class: 'eyebrow', text: areaName(floor, cell.area) }),
      cell.content && h('p', { class: 'review__content' }, icon(CONTENT_ICONS[cell.content]), CONTENT_NAMES[cell.content]),
      h('p', { class: `review__state review__state--${cell.state}`, text: stateText(cell) }),
      cell.answer && h('div', { class: 'result' }, answerDetails(cell.answer)),
      cell.rerolls.length > 0 && h('div', { class: 'review__rerolls' },
        h('p', { class: 'field__label', text: `Rerolled away (${cell.rerolls.length})` }),
        cell.rerolls.map((reroll) => h('div', { class: 'review__reroll' },
          h('p', { class: 'review__by', text: `Rerolled by ${reroll.by}` }),
          answerDetails(reroll.answer, { compact: true })))));
  }
}

function stateText(cell) {
  if (cell.state === 'answered' && cell.solvers.length > 0) return `Answered by ${cell.solvers.join(', ')}`;
  if (cell.state === 'answered' && !cell.answer) return 'Explored (no song: the entrance)';
  return STATE_TEXT[cell.state];
}

function areaName(floor, areaIndex) {
  if (areaIndex === NEUTRAL_AREA) return '// Center';
  const tag = floor.areas.find((area) => area.index === areaIndex)?.tag ?? null;
  return `// Sector ${SECTOR_LETTERS[areaIndex]} · ${formatTag(tag)}`;
}

function describe(cell) {
  const parts = [STATE_TEXT[cell.state].split(':')[0]];
  if (cell.content) parts.push(CONTENT_NAMES[cell.content]);
  if (cell.rerolls.length > 0) parts.push(`${cell.rerolls.length} rerolled`);
  return parts.join(', ');
}
