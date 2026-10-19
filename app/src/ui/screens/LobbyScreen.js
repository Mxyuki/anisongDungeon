import {
  ANILIST_NAME_MAX_LENGTH,
  ANSWER_MODES,
  ARTIST_AREA_MODES,
  ARTIST_TAG_HIDDEN,
  LIST_STATUSES,
  MIN_SONGS_PER_TAG,
  NAME_MAX_LENGTH,
  SEASONS,
  SETTINGS_LIMITS,
  SHORTAGE_CHOICES,
  SONG_TYPES,
} from '../../config.js';
import { h, panel, replaceChildren, setText } from '../dom.js';
import { icon } from '../icons.js';
import { pad2 } from '../format.js';
import { showToast } from '../components/toast.js';
import { avatarLookup, playerToken } from '../components/playerToken.js';

const PROFILE_SAVE_DELAY_MS = 600;

/** Song pool toggle: whole lists, or only anime aired within a season range. */
const POOL_SOURCES = [
  { seasonRange: false, key: 'ALL', label: 'Full lists' },
  { seasonRange: true, key: 'SEASONS', label: 'Season range' },
];
/** Anime mode: which anime names count as a right answer. */
const ANSWER_SCOPES = [
  { anySeason: false, key: 'EXACT', label: 'This anime only' },
  { anySeason: true, key: 'ANY', label: 'Any season' },
];
/** Ends of the season range: settings keys of each end's year and season. */
const RANGE_ENDS = [
  { label: 'From', year: 'fromYear', season: 'fromSeason' },
  { label: 'To', year: 'toYear', season: 'toSeason' },
];

/** Numeric host settings rendered as steppers. Add new numeric settings here. */
const SETTING_FIELDS = [
  { key: 'tilesPerArea', label: 'Tiles per genre area', unit: '', step: 1, hint: 'Size of each themed area on a floor.' },
  { key: 'floors', label: 'Floors to climb', unit: 'F', step: 1, hint: 'Reaching this floor ends the expedition.' },
  { key: 'timeLimitMin', label: 'Time limit', unit: 'min', step: 5, hint: 'Results are shown when time runs out.' },
  { key: 'rerollIntervalSec', label: 'Reroll every', unit: 'sec', step: 5, hint: 'Each player regains a reroll on this cooldown.' },
  { key: 'maxRerolls', label: 'Max stored rerolls', unit: '', step: 1, hint: 'Cooldown pauses when a player holds this many.' },
];

/**
 * Lobby: room code, own profile, roster, host settings and ready/start.
 */
export class LobbyScreen {
  #client;
  #root;
  #els = {};
  #saveTimer = null;
  #lastSettings = null;
  #context = { me: null, isHost: false };
  /** Catalog the avatar picker was built from (rebuilt when the host's catalog changes). */
  #renderedAvatars = null;

  /** @param {{ client: import('../../client/GameClient.js').GameClient }} options */
  constructor({ client }) {
    this.#client = client;
  }

  mount(root, state) {
    this.#root = h('div', { class: 'screen lobby' },
      this.#buildRoomPanel(),
      h('div', { class: 'lobby__center' }, this.#buildRosterPanel(), this.#buildAvatarPanel()),
      this.#buildSettingsPanel(),
      this.#buildShortageDialog());
    root.append(this.#root);
    window.addEventListener('keydown', this.#keyListener);
    this.update(state);
  }

  unmount() {
    clearTimeout(this.#saveTimer);
    window.removeEventListener('keydown', this.#keyListener);
    this.#root.remove();
  }

  #keyListener = (event) => {
    if (event.key === 'Escape' && !this.#els.shortage.hidden) this.#client.dismissShortage();
  };

  // ------------------------------------------------------------------ build

  #buildRoomPanel() {
    const els = this.#els;
    els.code = h('span', { class: 'room-code__value' });
    els.copyButton = h('button', {
      class: 'btn btn--ghost btn--icon',
      type: 'button',
      title: 'Copy code',
      onClick: () => this.#copyCode(),
    }, icon('copy'));

    const profile = this.#client.savedProfile;
    els.nameInput = h('input', {
      class: 'field__input', type: 'text', maxlength: NAME_MAX_LENGTH,
      placeholder: 'Operator name', value: profile.name,
      onInput: () => this.#scheduleProfileSave(),
      onKeydown: (event) => event.key === 'Enter' && this.#saveProfile(),
    });
    els.anilistInput = h('input', {
      class: 'field__input', type: 'text', maxlength: ANILIST_NAME_MAX_LENGTH,
      placeholder: 'AniList username (optional)', value: profile.anilist,
      onInput: () => this.#scheduleProfileSave(),
      onKeydown: (event) => event.key === 'Enter' && this.#saveProfile(),
    });
    els.anilistStatus = h('p', { class: 'hint' });
    els.statusButtons = LIST_STATUSES.map((status) => h('button', {
      class: 'chip-toggle',
      type: 'button',
      dataset: { status: status.key },
      onClick: () => this.#toggleListStatus(status.key),
    }, status.label));

    els.actionButton = h('button', {
      class: 'btn btn--primary btn--block btn--large',
      type: 'button',
      onClick: () => this.#onAction(),
    });
    els.actionHint = h('p', { class: 'hint lobby__action-hint' });

    return panel({ title: 'Room', code: 'NODE // 01', className: 'lobby__room' },
      h('div', { class: 'room-code' },
        h('span', { class: 'field__label', text: 'Access code' }),
        h('div', { class: 'room-code__row' }, els.code, els.copyButton),
        h('p', { class: 'hint', text: 'Friends open the launcher, choose Join, and enter this code.' })),
      h('div', { class: 'divider' }),
      h('label', { class: 'field' }, h('span', { class: 'field__label', text: 'Your name' }), els.nameInput),
      h('label', { class: 'field' }, h('span', { class: 'field__label', text: 'AniList' }), els.anilistInput),
      h('div', { class: 'field' },
        h('span', { class: 'field__label', text: 'Play songs from my' }),
        h('div', { class: 'chip-toggles' }, els.statusButtons)),
      els.anilistStatus,
      h('div', { class: 'lobby__action' }, els.actionButton, els.actionHint)).root;
  }

  #buildRosterPanel() {
    this.#els.roster = h('ul', { class: 'roster' });
    this.#els.rosterCount = h('span', { class: 'panel__code' });
    this.#els.source = h('p', { class: 'lobby__source' });
    const { root } = panel({ title: 'Operators', code: '', className: 'lobby__roster' },
      this.#els.roster, this.#els.source);
    root.querySelector('.panel__header').append(this.#els.rosterCount);
    return root;
  }

  #buildAvatarPanel() {
    this.#els.avatarGrid = h('div', { class: 'avatar-grid' });
    return panel({ title: 'Avatar', code: 'ID // 04', className: 'lobby__avatars' },
      this.#els.avatarGrid).root;
  }

  #buildSettingsPanel() {
    const els = this.#els;
    els.typeButtons = Object.entries(SONG_TYPES).map(([type, label]) => h('button', {
      class: 'toggle',
      type: 'button',
      dataset: { type },
      onClick: () => this.#toggleSongType(type),
    }, h('span', { class: 'toggle__key', text: type }), h('span', { text: label })));

    els.modeButtons = Object.entries(ANSWER_MODES).map(([mode, label]) => h('button', {
      class: 'toggle',
      type: 'button',
      dataset: { mode },
      onClick: () => this.#client.updateSettings({ answerMode: mode }),
    }, h('span', { class: 'toggle__key', text: mode === 'anime' ? 'ANIME' : 'S/A' }), h('span', { text: label })));

    els.artistButtons = Object.entries(ARTIST_AREA_MODES).map(([mode, label]) => h('button', {
      class: 'toggle',
      type: 'button',
      dataset: { mode },
      onClick: () => this.#client.updateSettings({ artistAreas: mode }),
    }, h('span', { text: label })));
    els.artistHint = h('p', { class: 'hint' });

    els.sourceButtons = POOL_SOURCES.map((source) => h('button', {
      class: 'toggle',
      type: 'button',
      dataset: { range: String(source.seasonRange) },
      onClick: () => this.#client.updateSettings({ seasonRange: source.seasonRange }),
    }, h('span', { class: 'toggle__key', text: source.key }), h('span', { text: source.label })));
    els.rangeSelects = [];
    const rangeRows = RANGE_ENDS.map((end) => this.#buildRangeEnd(end));

    els.scopeButtons = ANSWER_SCOPES.map((scope) => h('button', {
      class: 'toggle',
      type: 'button',
      dataset: { any: String(scope.anySeason) },
      onClick: () => this.#client.updateSettings({ anySeason: scope.anySeason }),
    }, h('span', { class: 'toggle__key', text: scope.key }), h('span', { text: scope.label })));
    els.scopeHint = h('p', { class: 'hint' });

    els.steppers = {};
    const fields = SETTING_FIELDS.map((field) => this.#buildStepper(field));
    els.settingsNote = h('p', { class: 'hint' });

    return panel({ title: 'Mission Parameters', code: 'CFG // 03', className: 'lobby__settings' },
      h('div', { class: 'setting' },
        h('span', { class: 'field__label', text: 'Song types' }),
        h('div', { class: 'toggle-group' }, els.typeButtons),
        h('p', { class: 'hint', text: `A theme needs ${MIN_SONGS_PER_TAG}+ songs in the combined lists to appear.` })),
      h('div', { class: 'setting' },
        h('span', { class: 'field__label', text: 'Answer mode' }),
        h('div', { class: 'toggle-group toggle-group--2' }, els.modeButtons),
        h('p', { class: 'hint', text: 'Anime: name the anime. S/A: name the song AND its artist (a group member or alias counts).' })),
      h('div', { class: 'setting' },
        h('span', { class: 'field__label', text: 'Accepted anime names' }),
        h('div', { class: 'toggle-group toggle-group--2' }, els.scopeButtons),
        els.scopeHint),
      h('div', { class: 'setting' },
        h('span', { class: 'field__label', text: 'Song pool' }),
        h('div', { class: 'toggle-group toggle-group--2' }, els.sourceButtons),
        h('div', { class: 'season-range' }, rangeRows),
        h('p', { class: 'hint', text: 'Season range: only anime first aired between these seasons play (lists and library alike).' })),
      h('div', { class: 'setting' },
        h('span', { class: 'field__label', text: 'Artist areas' }),
        h('div', { class: 'toggle-group' }, els.artistButtons),
        els.artistHint),
      fields,
      els.settingsNote).root;
  }

  /** One end of the season range: a season and a year dropdown. */
  #buildRangeEnd({ label, year, season }) {
    const { min, max } = SETTINGS_LIMITS[year];
    const years = Array.from({ length: max - min + 1 }, (_, index) => min + index);
    const select = (key, options) => {
      const element = h('select', {
        class: 'field__input season-range__select',
        'aria-label': `${label} ${key === year ? 'year' : 'season'}`,
        onChange: () => this.#client.updateSettings({ [key]: Number(element.value) }),
      }, options.map(([value, text]) => h('option', { value, text })));
      this.#els.rangeSelects.push({ element, key });
      return element;
    };
    return h('div', { class: 'season-range__end' },
      h('span', { class: 'season-range__label', text: label }),
      select(season, SEASONS.map((name, index) => [index, name])),
      select(year, years.map((value) => [value, value])));
  }

  /** Host prompt shown when the pool has fewer songs than the floors need. */
  #buildShortageDialog() {
    const els = this.#els;
    els.shortageText = h('p', { class: 'dialog__text' });
    els.shortageButtons = {
      fill: h('button', {
        class: 'btn btn--primary btn--block', type: 'button', onClick: () => this.#client.startGame('fill'),
      }, SHORTAGE_CHOICES.fill),
      duplicates: h('button', {
        class: 'btn btn--block', type: 'button', onClick: () => this.#client.startGame('duplicates'),
      }, SHORTAGE_CHOICES.duplicates),
    };
    els.fillHint = h('p', { class: 'hint' });
    const cancel = h('button', {
      class: 'btn btn--ghost btn--block', type: 'button', onClick: () => this.#client.dismissShortage(),
    }, 'Cancel');
    const box = panel({ title: 'Not enough songs', code: 'POOL // !!', className: 'dialog__box' },
      els.shortageText,
      h('div', { class: 'dialog__choice' }, els.shortageButtons.fill, els.fillHint),
      h('div', { class: 'dialog__choice' }, els.shortageButtons.duplicates,
        h('p', { class: 'hint', text: 'Songs of the pool play again once every one of them was heard.' })),
      h('div', { class: 'dialog__choice' }, cancel,
        h('p', { class: 'hint', text: 'Back to the lobby to change the settings (Esc).' }))).root;
    els.shortage = h('div', { class: 'dialog', hidden: true, role: 'dialog', 'aria-modal': 'true' }, box);
    return els.shortage;
  }

  #buildStepper({ key, label, unit, step, hint }) {
    const limits = SETTINGS_LIMITS[key];
    const value = h('span', { class: 'stepper__value' });
    const change = (delta) => {
      const current = this.#lastSettings?.[key] ?? limits.min;
      const next = Math.min(limits.max, Math.max(limits.min, current + delta));
      if (next !== current) this.#client.updateSettings({ [key]: next });
    };
    const minus = h('button', { class: 'stepper__btn', type: 'button', onClick: () => change(-step), 'aria-label': `Decrease ${label}` }, '−');
    const plus = h('button', { class: 'stepper__btn', type: 'button', onClick: () => change(step), 'aria-label': `Increase ${label}` }, '+');
    this.#els.steppers[key] = { value, minus, plus, unit, limits };
    return h('div', { class: 'setting setting--row' },
      h('div', { class: 'setting__text' },
        h('span', { class: 'setting__label', text: label }),
        h('span', { class: 'hint', text: hint })),
      h('div', { class: 'stepper' }, minus, value, plus));
  }

  // ------------------------------------------------------------------ actions

  #copyCode() {
    const code = this.#els.code.textContent;
    navigator.clipboard?.writeText(code)
      .then(() => showToast('Code copied', 'success'))
      .catch(() => showToast('Copy failed — select the code manually', 'error'));
  }

  #scheduleProfileSave() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => this.#saveProfile(), PROFILE_SAVE_DELAY_MS);
  }

  #saveProfile() {
    clearTimeout(this.#saveTimer);
    this.#client.setProfile({
      name: this.#els.nameInput.value.trim(),
      anilist: this.#els.anilistInput.value.trim(),
    });
  }

  #toggleListStatus(key) {
    const current = this.#context.me?.statuses ?? this.#client.savedProfile.statuses;
    const next = current.includes(key) ? current.filter((s) => s !== key) : [...current, key];
    if (next.length === 0) {
      showToast('Keep at least one list', 'error');
      return;
    }
    this.#client.setProfile({ statuses: next });
  }

  #toggleSongType(type) {
    const current = this.#lastSettings?.songTypes ?? [];
    const next = current.includes(type) ? current.filter((t) => t !== type) : [...current, type];
    if (next.length === 0) {
      showToast('Keep at least one song type', 'error');
      return;
    }
    this.#client.updateSettings({ songTypes: next });
  }

  #onAction() {
    const { me, isHost } = this.#context;
    if (isHost) this.#client.startGame();
    else if (me) this.#client.setReady(!me.ready);
  }

  // ------------------------------------------------------------------ update

  update(state) {
    const { lobby, playerId, isHost } = state;
    if (!lobby) return;
    const me = lobby.players.find((player) => player.id === playerId) ?? null;
    this.#context = { me, isHost };
    this.#lastSettings = lobby.settings;

    const avatarsById = avatarLookup(state.avatars);
    setText(this.#els.code, lobby.code);
    this.#renderAniListStatus(me);
    this.#renderListStatuses(me);
    this.#renderAvatars(state.avatars, me);
    this.#renderAction(lobby, me, isHost);
    this.#renderRoster(lobby, playerId, avatarsById);
    this.#renderSettings(lobby.settings, isHost);
    this.#renderShortage(isHost ? state.poolShortage : null, lobby.settings);
  }

  #renderShortage(shortage, settings) {
    const els = this.#els;
    const wasHidden = els.shortage.hidden;
    els.shortage.hidden = !shortage;
    if (!shortage) return;
    const source = shortage.fromLists ? 'Your AniList lists have' : 'The library has';
    setText(els.shortageText, `${source} ${shortage.songCount} songs matching the settings, but `
      + `${settings.floors - 1} floors of ${settings.tilesPerArea}-tile areas need about ${shortage.needed}.`);
    const { fill, duplicates } = els.shortageButtons;
    fill.disabled = !shortage.canFill;
    fill.title = shortage.canFill ? '' : 'No other library song matches these settings.';
    setText(els.fillHint, shortage.canFill
      ? 'Once the lists run out, random library songs matching the song types, seasons, area theme and floor difficulty fill the gap.'
      : 'Unavailable: no other library song matches the song types and seasons.');
    if (wasHidden) (shortage.canFill ? fill : duplicates).focus();
  }

  #renderAniListStatus(me) {
    const status = me?.anilistStatus ?? { state: 'none' };
    const messages = {
      none: 'No list linked: songs come from your friends\' lists, or the full library.',
      checking: 'Checking AniList…',
      ok: `Linked — ${status.count} anime in the selected lists.`,
      error: status.error,
    };
    setText(this.#els.anilistStatus, messages[status.state] ?? '');
    this.#els.anilistStatus.className = `hint hint--${status.state}`;
  }

  #renderListStatuses(me) {
    const selected = me?.statuses ?? [];
    for (const button of this.#els.statusButtons) {
      const active = selected.includes(button.dataset.status);
      button.classList.toggle('chip-toggle--active', active);
      button.setAttribute('aria-pressed', String(active));
    }
  }

  #renderAvatars(avatars, me) {
    if (avatars !== this.#renderedAvatars) {
      this.#renderedAvatars = avatars;
      const choose = (id) => this.#client.setProfile({ avatar: id });
      replaceChildren(this.#els.avatarGrid,
        h('button', { class: 'avatar-option avatar-option--none', type: 'button', dataset: { id: '' }, title: 'No avatar', onClick: () => choose('') },
          h('span', { class: 'avatar-option__image', text: '—' }), h('span', { class: 'avatar-option__name', text: 'None' })),
        avatars.map((avatar) => h('button', {
          class: 'avatar-option', type: 'button', dataset: { id: avatar.id }, title: avatar.name, onClick: () => choose(avatar.id),
        },
        h('img', { class: 'avatar-option__image', src: avatar.url, alt: '' }),
        h('span', { class: 'avatar-option__name', text: avatar.name }))),
        avatars.length === 0 && h('p', { class: 'hint avatar-grid__empty',
          text: 'No avatars yet: the host can drop .png or .webp images into the app/avatars folder.' }));
    }
    for (const option of this.#els.avatarGrid.querySelectorAll('.avatar-option')) {
      option.classList.toggle('avatar-option--active', option.dataset.id === (me?.avatar ?? ''));
    }
  }

  #renderAction(lobby, me, isHost) {
    const { actionButton, actionHint } = this.#els;
    const waiting = lobby.players.filter((player) => player.online && !player.ready);
    if (isHost) {
      replaceChildren(actionButton, icon('flag'), 'Start operation');
      actionButton.disabled = waiting.length > 0 || lobby.phase !== 'lobby';
      setText(actionHint, lobby.phase === 'loading' ? 'Preparing…'
        : waiting.length > 0 ? `Waiting for ${waiting.map((p) => p.name).join(', ')}` : 'Everyone is ready.');
      return;
    }
    const ready = Boolean(me?.ready);
    actionButton.classList.toggle('btn--confirmed', ready);
    replaceChildren(actionButton, icon(ready ? 'check' : 'flag'), ready ? 'Ready — click to cancel' : 'Ready up');
    actionButton.disabled = lobby.phase !== 'lobby';
    setText(actionHint, ready ? 'Waiting for the host to start.' : 'Set your name and AniList, then ready up.');
  }

  #renderRoster(lobby, playerId, avatarsById) {
    setText(this.#els.rosterCount, `${pad2(lobby.players.length)} // LINKED`);
    replaceChildren(this.#els.roster, lobby.players.map((player, index) => {
      const anilist = player.anilistStatus;
      const anilistText = !player.anilist ? 'No AniList'
        : anilist.state === 'ok' ? `${player.anilist} · ${anilist.count} anime`
          : anilist.state === 'checking' ? `${player.anilist} · checking…`
            : `${player.anilist} · not found`;
      return h('li', { class: `operator${player.id === playerId ? ' operator--me' : ''}` },
        h('span', { class: 'operator__index', text: pad2(index + 1) }),
        playerToken(player, avatarsById, { className: 'operator__token' }),
        h('div', { class: 'operator__info' },
          h('span', { class: 'operator__name' },
            player.isHost && icon('crown', 'operator__crown'),
            player.name,
            player.id === playerId && h('span', { class: 'operator__you', text: 'YOU' })),
          h('span', { class: `operator__anilist operator__anilist--${anilist.state}`, text: anilistText })),
        h('span', {
          class: `badge ${player.ready ? 'badge--ready' : 'badge--idle'}`,
          text: player.isHost ? 'HOST' : player.ready ? 'READY' : 'STANDBY',
        }));
    }));

    const linked = lobby.players.filter((p) => p.anilistStatus.state === 'ok').length;
    const { settings } = lobby;
    const seasons = settings.seasonRange
      ? ` Only anime aired from ${SEASONS[settings.fromSeason]} ${settings.fromYear} to ${SEASONS[settings.toSeason]} ${settings.toYear}.`
      : '';
    setText(this.#els.source, (linked > 0
      ? `Song pool: anime from ${linked} linked AniList list${linked > 1 ? 's' : ''}.`
      : 'Song pool: no AniList linked — random songs from the full library.') + seasons);
  }

  #renderSettings(settings, isHost) {
    for (const button of this.#els.modeButtons) {
      const active = settings.answerMode === button.dataset.mode;
      button.classList.toggle('toggle--active', active);
      button.disabled = !isHost;
      button.setAttribute('aria-pressed', String(active));
    }
    // Artist areas only exist in anime mode (in S/A they would give the artist away).
    const artistAreasApply = settings.answerMode === 'anime';
    for (const button of this.#els.artistButtons) {
      const active = settings.artistAreas === button.dataset.mode;
      button.classList.toggle('toggle--active', active);
      button.disabled = !isHost || !artistAreasApply;
      button.setAttribute('aria-pressed', String(active));
    }
    setText(this.#els.artistHint, artistAreasApply
      ? `Some sectors only play songs of 2 artists. Show their names, hide them ("${ARTIST_TAG_HIDDEN}"), or turn these areas off.`
      : 'Anime mode only: in S/A mode the area name would give the artist away.');
    for (const button of this.#els.scopeButtons) {
      const active = String(settings.anySeason) === button.dataset.any;
      button.classList.toggle('toggle--active', active);
      button.disabled = !isHost || !artistAreasApply;
      button.setAttribute('aria-pressed', String(active));
    }
    setText(this.#els.scopeHint, !artistAreasApply ? 'Anime mode only.'
      : settings.anySeason
        ? 'Any entry of the franchise counts: "Attack on Titan" is right for a Season 3 song.'
        : 'Only the anime\'s Japanese/English names and its alternative answers count, not other seasons.');
    for (const button of this.#els.sourceButtons) {
      const active = String(settings.seasonRange) === button.dataset.range;
      button.classList.toggle('toggle--active', active);
      button.disabled = !isHost;
      button.setAttribute('aria-pressed', String(active));
    }
    for (const { element, key } of this.#els.rangeSelects) {
      if (document.activeElement !== element) element.value = String(settings[key]);
      element.disabled = !isHost || !settings.seasonRange;
    }
    for (const button of this.#els.typeButtons) {
      const active = settings.songTypes.includes(button.dataset.type);
      button.classList.toggle('toggle--active', active);
      button.disabled = !isHost;
      button.setAttribute('aria-pressed', String(active));
    }
    for (const [key, stepper] of Object.entries(this.#els.steppers)) {
      const value = settings[key];
      setText(stepper.value, stepper.unit ? `${value} ${stepper.unit}` : value);
      stepper.minus.disabled = !isHost || value <= stepper.limits.min;
      stepper.plus.disabled = !isHost || value >= stepper.limits.max;
    }
    setText(this.#els.settingsNote, isHost ? 'You are the host: these settings apply to everyone.'
      : 'Only the host can change mission parameters.');
  }
}
