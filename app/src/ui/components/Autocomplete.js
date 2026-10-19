import { AUTOCOMPLETE_MAX_RESULTS } from '../../config.js';
import { compactText, normalizeText, normalizeWithMap } from '../../core/text.js';
import { h } from '../dom.js';

/** Match quality, best first. */
const TIER = Object.freeze({ EXACT: 0, PREFIX: 1, WORD: 2, INSIDE: 3, SPACELESS: 4 });
const TIER_COUNT = Object.keys(TIER).length;

/** Shorter names first (closest to what was typed), then alphabetical. */
const byLength = (a, b) => a.key.length - b.key.length || a.key.localeCompare(b.key);

/**
 * Text input with a keyboard-navigable suggestion list.
 *
 * Suggestions: exact match, then names starting with the query, names with a word starting
 * with it, names containing it, and names containing it once spaces are ignored. Each group is
 * sorted shortest first. Symbols count as spaces and accents are ignored (see normalizeText),
 * and the matching part of each name is highlighted.
 * Keyboard and mouse are independent: ↑/↓ move the keyboard selection (the list scrolls to
 * follow it), hovering only highlights under the pointer.
 * Enter submits (the keyboard selection if any). Tab accepts the keyboard selection; with no
 * selection it calls `onTab` when given, else accepts the first suggestion.
 * Esc closes the list then leaves the field.
 */
export class Autocomplete {
  /** @type {{ label: string, key: string, compact: string }[]} */ #entries = [];
  /** @type {{ label: string, key: string, tier: number }[]} */ #visible = [];
  /** @type {HTMLLIElement[]} */ #items = [];
  #highlighted = -1;
  #onSubmit;
  #onTab;
  root;
  input;
  #list;

  /**
   * @param {object} options
   * @param {string} options.placeholder
   * @param {(value: string) => void} options.onSubmit
   * @param {(event: KeyboardEvent) => void} [options.onTab]
   */
  constructor({ placeholder, onSubmit, onTab = null }) {
    this.#onSubmit = onSubmit;
    this.#onTab = onTab;
    this.input = h('input', {
      class: 'field__input autocomplete__input',
      type: 'text',
      placeholder,
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-autocomplete': 'list',
      onInput: () => this.#refresh(),
      onKeydown: (event) => this.#onKeydown(event),
      onBlur: () => setTimeout(() => this.#close(), 120),
    });
    this.#list = h('ul', { class: 'autocomplete__list', role: 'listbox', hidden: true });
    this.root = h('div', { class: 'autocomplete' }, this.input);
    document.body.append(this.#list);
  }

  destroy() {
    this.#list.remove();
  }

  /** @param {string[]} names */
  setSuggestions(names) {
    this.#entries = names.map((label) => {
      const key = normalizeText(label);
      return { label, key, compact: compactText(key) };
    });
  }

  get value() {
    return this.input.value;
  }

  clear() {
    this.input.value = '';
    this.#close();
  }

  focus() {
    this.input.focus();
  }

  blur() {
    this.input.blur();
    this.#close();
  }

  /** Selects the typed text so a new attempt can overwrite it. */
  selectAll() {
    this.input.select();
  }

  set disabled(value) {
    this.input.disabled = value;
    if (value) this.#close();
  }

  #refresh() {
    const query = normalizeText(this.input.value);
    if (query.length < 1) {
      this.#close();
      return;
    }
    const compactQuery = compactText(query);
    const tiers = Array.from({ length: TIER_COUNT }, () => []);
    for (const entry of this.#entries) {
      const tier = matchTier(entry, query, compactQuery);
      if (tier !== null) tiers[tier].push({ ...entry, tier });
    }
    const visible = [];
    for (const group of tiers) {
      if (visible.length >= AUTOCOMPLETE_MAX_RESULTS) break;
      visible.push(...group.sort(byLength).slice(0, AUTOCOMPLETE_MAX_RESULTS - visible.length));
    }
    this.#visible = visible;
    this.#highlighted = -1;
    this.#renderList(query, compactQuery);
  }

  /** Rebuilds the items; only done when the query changes. */
  #renderList(query, compactQuery) {
    this.#items = this.#visible.map((entry, index) => h('li', {
      class: 'autocomplete__item',
      role: 'option',
      onMousedown: (event) => {
        event.preventDefault();
        this.#choose(index, true);
      },
    }, highlightMatch(entry, query, compactQuery)));
    this.#list.replaceChildren(...this.#items);
    this.#list.scrollTop = 0;
    this.#list.hidden = this.#items.length === 0;
    if (!this.#list.hidden) this.#positionList();
  }

  /** Moves the keyboard selection without touching the items or the mouse hover. */
  #setHighlighted(index) {
    this.#items[this.#highlighted]?.classList.remove('autocomplete__item--active');
    this.#highlighted = index;
    const item = this.#items[index];
    if (!item) return;
    item.classList.add('autocomplete__item--active');
    item.scrollIntoView({ block: 'nearest' });
  }

  #positionList() {
    const rect = this.input.getBoundingClientRect();
    Object.assign(this.#list.style, {
      left: `${rect.left}px`,
      top: `${rect.bottom + 2}px`,
      width: `${rect.width}px`,
    });
  }

  #choose(index, submit) {
    const label = this.#visible[index]?.label;
    if (label === undefined) return;
    this.input.value = label;
    this.#close();
    if (submit) this.#submit();
  }

  #submit() {
    const value = this.input.value.trim();
    if (value) this.#onSubmit(value);
  }

  #close() {
    this.#visible = [];
    this.#items = [];
    this.#highlighted = -1;
    this.#list.hidden = true;
  }

  #onKeydown(event) {
    const count = this.#items.length;
    const open = count > 0;
    if (event.key === 'ArrowDown' && open) {
      this.#setHighlighted(this.#highlighted + 1 >= count ? 0 : this.#highlighted + 1);
    } else if (event.key === 'ArrowUp' && open) {
      this.#setHighlighted(this.#highlighted <= 0 ? count - 1 : this.#highlighted - 1);
    } else if (event.key === 'Tab' && open && (this.#highlighted >= 0 || !this.#onTab)) {
      this.#choose(Math.max(0, this.#highlighted), false);
    } else if (event.key === 'Tab' && this.#onTab) {
      this.#close();
      this.#onTab(event);
    } else if (event.key === 'Enter') {
      if (open && this.#highlighted >= 0) this.#choose(this.#highlighted, true);
      else this.#submit();
    } else if (event.key === 'Escape') {
      // First Esc closes the list, the next one leaves the field (so movement keys work).
      if (open) this.#close();
      else this.input.blur();
    } else {
      return;
    }
    event.preventDefault();
  }
}

/**
 * How well an entry matches the query (a TIER value), or null when it does not.
 * @returns {number | null}
 */
function matchTier(entry, query, compactQuery) {
  const position = entry.key.indexOf(query);
  if (position === 0) return entry.key.length === query.length ? TIER.EXACT : TIER.PREFIX;
  if (position > 0) return entry.key.includes(` ${query}`) ? TIER.WORD : TIER.INSIDE;
  return entry.compact.includes(compactQuery) ? TIER.SPACELESS : null;
}

/**
 * The entry's label with the part matching the query wrapped in <mark>.
 * @returns {(string | HTMLElement)[]}
 */
function highlightMatch(entry, query, compactQuery) {
  const { text, map } = normalizeWithMap(entry.label);
  let start;
  let end;
  if (entry.tier === TIER.SPACELESS) {
    // Positions in the spaceless text, mapped back through the spaced one.
    const spaced = [...text].flatMap((char, index) => (char === ' ' ? [] : [index]));
    const at = compactText(text).indexOf(compactQuery);
    if (at < 0) return [entry.label];
    start = spaced[at];
    end = spaced[at + compactQuery.length - 1];
  } else {
    const at = entry.tier === TIER.WORD ? text.indexOf(` ${query}`) + 1 : text.indexOf(query);
    if (at < 0) return [entry.label];
    start = at;
    end = at + query.length - 1;
  }
  const from = map[start];
  // The last matched character may be several code units long (emoji, surrogate pairs).
  const to = map[end] + String.fromCodePoint(entry.label.codePointAt(map[end])).length;
  return [
    entry.label.slice(0, from),
    h('mark', { class: 'autocomplete__match', text: entry.label.slice(from, to) }),
    entry.label.slice(to),
  ].filter((part) => part !== '');
}
