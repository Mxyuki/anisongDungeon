import { h, replaceChildren } from '../dom.js';
import { icon } from '../icons.js';
import { Autocomplete } from './Autocomplete.js';

/**
 * The answer fields of a challenge, for the current answer mode:
 * - anime: one "anime name" field → `{ text }`
 * - songArtist (S/A): "song" and "artist" fields. Enter in a field sends only that part, so it
 *   is checked right away; parts found by anyone in the team lock with a ✓, and the group
 *   members found so far are listed under the artist field. Tab jumps between the two fields;
 *   when the part being typed gets found, the cursor moves to the other one.
 */
export class AnswerForm {
  root;
  #mode;
  #onSubmit;
  #submitButton;
  /** @type {Autocomplete} */ #anime;
  /** @type {Autocomplete} */ #song;
  /** @type {Autocomplete} */ #artist;
  #els = {};
  #progress = null;

  /**
   * @param {object} options
   * @param {'anime' | 'songArtist'} options.mode
   * @param {{ anime?: string[], songs?: string[], artists?: string[] }} options.suggestions
   * @param {(answer: object) => void} options.onSubmit
   */
  constructor({ mode, suggestions, onSubmit }) {
    this.#mode = mode;
    this.#onSubmit = onSubmit;
    this.#submitButton = h('button', { class: 'btn btn--primary', type: 'button', onClick: () => this.submit() }, 'Submit');

    if (mode !== 'songArtist') {
      this.#anime = this.#field('Name the anime…', suggestions.anime, () => this.submit());
      this.root = h('div', { class: 'answer guess' }, this.#anime.root, this.#submitButton);
      return;
    }

    this.#song = this.#field('Song name…', suggestions.songs, (value) => this.#onSubmit({ song: value }),
      (event) => this.#switchField(event, this.#artist));
    this.#artist = this.#field('Artist, group or member…', suggestions.artists, (value) => this.#onSubmit({ artist: value }),
      (event) => this.#switchField(event, this.#song));
    const els = this.#els;
    els.songFound = h('div', { class: 'answer__found', hidden: true });
    els.artistFound = h('div', { class: 'answer__found', hidden: true });
    els.members = h('div', { class: 'answer__members', hidden: true });
    els.artistLabel = h('span', { class: 'field__label', text: 'Artist' });
    this.root = h('div', { class: 'answer answer--split' },
      h('div', { class: 'answer__row' }, h('span', { class: 'field__label', text: 'Song' }), this.#song.root, els.songFound),
      h('div', { class: 'answer__row' }, els.artistLabel, this.#artist.root, els.artistFound, els.members),
      this.#submitButton);
  }

  #field(placeholder, names = [], onEnter, onTab = null) {
    const field = new Autocomplete({ placeholder, onSubmit: onEnter, onTab });
    field.setSuggestions(names);
    return field;
  }

  /** Tab / Shift+Tab: go to the other field, unless that part is already found. */
  #switchField(event, target) {
    event.preventDefault();
    if (!target.root.hidden) target.focus();
  }

  #isTyping(field) {
    return document.activeElement === field.input;
  }

  get #fields() {
    return [this.#anime, this.#song, this.#artist].filter(Boolean);
  }

  /** Sends every filled part (Submit button). */
  submit() {
    if (this.#mode !== 'songArtist') {
      const text = this.#anime.value.trim();
      if (text) this.#onSubmit({ text });
      return;
    }
    const answer = {};
    if (!this.#progress?.song && this.#song.value.trim()) answer.song = this.#song.value.trim();
    if (!this.#progress?.artist && this.#artist.value.trim()) answer.artist = this.#artist.value.trim();
    if (Object.keys(answer).length > 0) this.#onSubmit(answer);
    else this.focus();
  }

  /**
   * Shows what the team already found on this tile (S/A mode).
   * @param {{ song: string|null, artist: string|null, members: string[], memberCount: number } | null} progress
   */
  update(progress) {
    if (this.#mode !== 'songArtist' || !progress) return;
    const previous = this.#progress;
    this.#progress = progress;
    const els = this.#els;
    // Checked before locking: a hidden field loses the focus.
    const jumpToArtist = progress.song && !previous?.song && !progress.artist && this.#isTyping(this.#song);
    const jumpToSong = progress.artist && !previous?.artist && !progress.song && this.#isTyping(this.#artist);

    this.#lockField(this.#song, els.songFound, progress.song);
    this.#lockField(this.#artist, els.artistFound, progress.artist);
    if (progress.song && !previous?.song) this.#song.clear();
    if (progress.members.length > (previous?.members.length ?? 0)) this.#artist.clear();
    if (jumpToArtist) this.#artist.focus();
    if (jumpToSong) this.#song.focus();

    const showMembers = !progress.artist && progress.memberCount > 0 && progress.members.length > 0;
    els.members.hidden = !showMembers;
    els.artistLabel.textContent = progress.memberCount > 0 && !progress.artist
      ? `Artist · members ${progress.members.length}/${progress.memberCount}`
      : 'Artist';
    if (showMembers) {
      const missing = progress.memberCount - progress.members.length;
      replaceChildren(els.members,
        progress.members.map((name) => h('span', { class: 'chip chip--found' }, icon('check'), name)),
        h('span', { class: 'chip chip--missing', text: `${missing} missing` }));
    }
  }

  #lockField(field, foundEl, value) {
    field.root.hidden = Boolean(value);
    foundEl.hidden = !value;
    if (value) replaceChildren(foundEl, icon('check'), h('span', { text: value }));
  }

  /**
   * Puts the cursor on what to fix after a wrong answer.
   * @param {string[]} [missed]  Parts that were wrong ('song' | 'artist').
   */
  showWrong(missed = []) {
    const field = this.#mode !== 'songArtist' ? this.#anime
      : missed.includes('song') ? this.#song : this.#artist;
    field.focus();
    field.selectAll();
  }

  focus() {
    const first = this.#mode !== 'songArtist' ? this.#anime
      : !this.#progress?.song ? this.#song : this.#artist;
    first.focus();
  }

  clear() {
    this.#progress = null;
    this.#fields.forEach((field) => field.clear());
    if (this.#mode === 'songArtist') {
      this.update({ song: null, artist: null, members: [], memberCount: 0 });
    }
  }

  blur() {
    this.#fields.forEach((field) => field.blur());
  }

  set disabled(value) {
    this.#fields.forEach((field) => { field.disabled = value; });
    this.#submitButton.disabled = value;
  }

  destroy() {
    this.#fields.forEach((field) => field.destroy());
  }
}
