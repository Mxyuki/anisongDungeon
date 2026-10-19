import { KEYS_REQUIRED, MOVE_REPEAT_MS } from '../../config.js';
import { formatDuration } from '../../core/time.js';
import { AudioPlayer } from '../components/AudioPlayer.js';
import { AnswerForm } from '../components/AnswerForm.js';
import { DungeonGrid } from '../components/DungeonGrid.js';
import { playKeyChime } from '../components/sfx.js';
import { showToast } from '../components/toast.js';
import { h, panel, replaceChildren, setText } from '../dom.js';
import { answerDetails } from '../components/answerDetails.js';
import { formatSongType, formatTag, NEUTRAL_AREA, pad2, SECTOR_LETTERS } from '../format.js';
import { icon } from '../icons.js';
import { avatarLookup, playerToken } from '../components/playerToken.js';

const CLOCK_INTERVAL_MS = 250;
const TIMER_WARNING_MS = 60_000;
const EQ_BARS = 16;
/** How long the "Return to lobby" button waits for its confirmation click. */
const LOBBY_CONFIRM_MS = 3000;
/** Door roll animation: first highlight step, slowdown per step, pause on the winner. */
const ROLL_FIRST_STEP_MS = 60;
const ROLL_SLOWDOWN = 1.18;
const ROLL_SETTLE_MS = 700;

/**
 * Movement keys by physical position (KeyboardEvent.code), so WASD on QWERTY and ZQSD on AZERTY
 * are the same keys. Arrows work everywhere.
 */
const MOVE_KEYS = {
  KeyW: [0, -1], ArrowUp: [0, -1],
  KeyS: [0, 1], ArrowDown: [0, 1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0],
  KeyD: [1, 0], ArrowRight: [1, 0],
};

/**
 * In-game screen: HUD, sectors and doors, the floor map, the song challenge and the ranking.
 */
export class GameScreen {
  #client;
  #root;
  #els = {};
  /** @type {DungeonGrid} */ #grid;
  /** @type {AudioPlayer} */ #audio;
  /** @type {AnswerForm} */ #answer;
  #clock = null;
  #state = null;
  #challengeId = null;
  #resultSeq = 0;
  /** Songs guessed in an area before its key and door show (host setting). */
  #revealAfter = 0;
  #doorsSignature = '';
  #lastMoveAt = 0;
  /** Keys and floor seen in the previous update, to notice a new key. */
  #seenKeys = { floor: 0, keys: 0 };
  #keyListener = (event) => this.#onKeydown(event);
  /** Pending confirmation timer of the host's "Return to lobby" button. */
  #lobbyConfirmTimer = null;
  /** @type {Map<number, HTMLElement>} Door cards by area index (highlighted by the roll). */
  #doorEls = new Map();
  /** Door roll being animated: which door is lit, and whether it landed. */
  #roll = { id: null, candidates: [], highlighted: null, settled: false, timer: null };

  /** @param {{ client: import('../../client/GameClient.js').GameClient }} options */
  constructor({ client }) {
    this.#client = client;
  }

  mount(root, state) {
    this.#audio = new AudioPlayer();
    this.#audio.on('state', (audioState) => this.#renderAudioState(audioState));
    this.#grid = new DungeonGrid({ onSelect: (x, y) => this.#tryMove(x, y) });
    this.#answer = new AnswerForm({
      mode: state.game.settings.answerMode,
      suggestions: state.game.suggestions ?? {},
      onSubmit: (answer) => this.#client.guess(answer),
    });
    this.#resultSeq = state.lastResult?.seq ?? 0;

    this.#root = h('div', { class: 'screen game' },
      this.#buildHud(state.game.settings, state.isHost),
      h('div', { class: 'game__body' },
        h('aside', { class: 'game__side game__side--left' },
          this.#buildSectorsPanel(state.game.settings.revealAfter), this.#buildDoorsPanel()),
        h('main', { class: 'game__center' }, this.#buildMapPanel()),
        h('aside', { class: 'game__side game__side--right' },
          this.#buildSignalPanel(), this.#buildResultPanel(), this.#buildRankingPanel())));
    root.append(this.#root);

    window.addEventListener('keydown', this.#keyListener);
    this.#clock = setInterval(() => this.#tick(), CLOCK_INTERVAL_MS);
    this.update(state);
  }

  unmount() {
    window.removeEventListener('keydown', this.#keyListener);
    clearInterval(this.#clock);
    clearTimeout(this.#lobbyConfirmTimer);
    clearTimeout(this.#roll.timer);
    this.#audio.destroy();
    this.#answer.destroy();
    this.#root.remove();
  }

  // ------------------------------------------------------------------ build

  #buildHud(settings, isHost) {
    const els = this.#els;
    els.floorValue = h('span', { class: 'hud__big' });
    els.floorPips = h('div', { class: 'pips' },
      Array.from({ length: settings.floors }, (_, i) => h('span', { class: 'pips__pip', title: `Floor ${i + 1}` })));
    els.timer = h('span', { class: 'hud__big hud__timer' });
    els.keySlots = Array.from({ length: KEYS_REQUIRED }, () => h('span', { class: 'key-slot' }, icon('key')));
    els.rerollCount = h('span', { class: 'hud__big' });
    els.rerollBar = h('span', { class: 'meter__fill' });
    els.rerollLabel = h('span', { class: 'hud__sub' });
    els.guessed = h('span', { class: 'hud__big hud__good' });
    // S/A mode: song names and artists this player found.
    els.partsFound = h('span', { class: 'hud__sub', hidden: settings.answerMode !== 'songArtist' });

    const block = (label, ...children) => h('div', { class: 'hud__block' },
      h('span', { class: 'hud__label', text: label }), ...children);

    return h('header', { class: 'hud' },
      h('div', { class: 'hud__brand' }, h('span', { class: 'hud__logo', text: 'AD' }),
        h('span', { class: 'hud__brand-text' }, 'Anisong', h('br'), 'Dungeon')),
      block('Floor', h('div', { class: 'hud__row' }, els.floorValue,
        h('span', { class: 'hud__sub', text: `/ ${pad2(settings.floors)}` })), els.floorPips),
      block('Time left', h('div', { class: 'hud__row' }, icon('clock', 'hud__icon'), els.timer)),
      block('Team keys', h('div', { class: 'hud__row key-slots' }, els.keySlots)),
      block('Rerolls', h('div', { class: 'hud__row' }, els.rerollCount, els.rerollLabel),
        h('div', { class: 'meter' }, els.rerollBar)),
      block('Songs guessed', h('div', { class: 'hud__row' }, icon('check', 'hud__icon hud__good'), els.guessed,
        els.partsFound)),
      isHost && this.#buildLobbyButton());
  }

  /** Host only: ends the expedition for everyone; needs a second click to confirm. */
  #buildLobbyButton() {
    const label = h('span', { text: 'Lobby' });
    const button = h('button', {
      class: 'btn btn--ghost btn--danger hud__lobby',
      type: 'button',
      title: 'End the expedition and bring everyone back to the lobby (same room code)',
      onClick: () => {
        if (this.#lobbyConfirmTimer) {
          this.#client.returnToLobby();
          return;
        }
        button.classList.add('hud__lobby--armed');
        label.textContent = 'Confirm?';
        this.#lobbyConfirmTimer = setTimeout(() => {
          this.#lobbyConfirmTimer = null;
          button.classList.remove('hud__lobby--armed');
          label.textContent = 'Lobby';
        }, LOBBY_CONFIRM_MS);
      },
    }, icon('replay'), label);
    return h('div', { class: 'hud__block hud__block--action' }, button);
  }

  /** @param {number} revealAfter  Songs guessed in an area before its key and door show. */
  #buildSectorsPanel(revealAfter) {
    this.#revealAfter = revealAfter;
    this.#els.sectors = h('ul', { class: 'sectors' });
    const reveal = revealAfter === 0 ? 'Keys and doors are marked on the map from the start.'
      : `After ${revealAfter} song${revealAfter > 1 ? 's' : ''} guessed in an area, its key and door are marked on the map.`;
    return panel({ title: 'Sectors', code: 'MAP // A-C' }, this.#els.sectors,
      h('p', { class: 'hint', text: `Explore an area to reveal its outline. ${reveal} The center has a door but no key.` })).root;
  }

  #buildDoorsPanel() {
    this.#els.doors = h('div', { class: 'doors' });
    return panel({ title: 'Doors', code: 'EXIT // 03' }, this.#els.doors).root;
  }

  #buildMapPanel() {
    const els = this.#els;
    els.mapTitle = h('span', { class: 'panel__title' });
    els.mapHint = h('p', { class: 'map__hint' });
    const legend = h('div', { class: 'legend' },
      h('span', { class: 'legend__item' }, h('span', { class: 'legend__swatch legend__swatch--cleared' }), 'Answered'),
      h('span', { class: 'legend__item' }, h('span', { class: 'legend__swatch legend__swatch--reachable' }), 'Can answer'),
      h('span', { class: 'legend__item' }, h('span', { class: 'legend__swatch legend__swatch--locked' }), 'Locked'),
      h('span', { class: 'legend__item' }, h('span', { class: 'legend__dot' }), 'You'),
      h('span', { class: 'legend__item' }, icon('start'), 'Entrance'),
      h('span', { class: 'legend__item' }, icon('key'), 'Key'),
      h('span', { class: 'legend__item' }, icon('door'), 'Door'),
      h('span', { class: 'legend__item' }, h('span', { class: 'legend__dot legend__dot--team' }), 'Teammate'));
    const { root } = panel({ title: '', code: 'GRID // 15×15', className: 'map' },
      els.mapHint,
      h('div', { class: 'map__frame' }, this.#grid.root), legend);
    root.querySelector('.panel__title').replaceWith(els.mapTitle);
    return root;
  }

  #buildSignalPanel() {
    const els = this.#els;
    els.signalTitle = h('h3', { class: 'signal__title' });
    els.signalMeta = h('div', { class: 'signal__meta' });
    els.eq = h('div', { class: 'eq' },
      Array.from({ length: EQ_BARS }, (_, i) => h('span', { style: { animationDelay: `${(i * 97) % 600}ms` } })));
    els.audioStatus = h('span', { class: 'signal__audio-status' });
    els.pauseButton = h('button', { class: 'btn btn--ghost btn--icon', type: 'button', title: 'Play / pause', onClick: () => this.#audio.togglePause() }, icon('play'));
    const replay = h('button', { class: 'btn btn--ghost btn--icon', type: 'button', title: 'Replay from start point', onClick: () => this.#audio.replay() }, icon('replay'));
    const volume = h('input', {
      class: 'volume', type: 'range', min: '0', max: '1', step: '0.05', 'aria-label': 'Volume',
      onInput: (event) => { this.#audio.volume = Number(event.target.value); },
    });
    volume.value = String(this.#audio.volume);

    els.rerollButton = h('button', { class: 'btn btn--ghost btn--block', type: 'button', onClick: () => this.#client.reroll() }, icon('reroll'), h('span'));
    els.signalIdle = h('div', { class: 'signal__idle' });
    els.signalActive = h('div', { class: 'signal__active' },
      h('div', { class: 'signal__player' }, els.eq,
        h('div', { class: 'signal__controls' }, els.pauseButton, replay, icon('volume', 'signal__volume-icon'), volume)),
      els.audioStatus,
      this.#answer.root,
      els.rerollButton,
      h('p', { class: 'hint signal__keys' },
        h('kbd', { text: 'Enter' }), ' submit · ', h('kbd', { text: 'Esc' }), ' leave the field · step back to leave the tile'));

    return panel({ title: 'Signal', code: 'AUDIO // RX', className: 'signal' },
      els.signalTitle, els.signalMeta, els.signalIdle, els.signalActive).root;
  }

  #buildResultPanel() {
    this.#els.result = h('div', { class: 'result result--empty' },
      h('p', { class: 'hint', text: 'Guessed songs are revealed here.' }));
    return panel({ title: 'Last Track', code: 'LOG // 01' }, this.#els.result).root;
  }

  #buildRankingPanel() {
    this.#els.ranking = h('ol', { class: 'ranking' });
    return panel({ title: 'Ranking', code: 'LIVE' }, this.#els.ranking).root;
  }

  // ------------------------------------------------------------------ input

  #onKeydown(event) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    const run = this.#state?.run;
    if (!run?.position || run.finished) return;

    const delta = MOVE_KEYS[event.code];
    if (!delta) {
      // Enter jumps back into the answer field while standing on a song.
      if (event.key === 'Enter' && run.challenge) {
        event.preventDefault();
        this.#answer.focus();
      }
      return;
    }
    event.preventDefault();
    if (Date.now() - this.#lastMoveAt < MOVE_REPEAT_MS) return;
    this.#tryMove(run.position.x + delta[0], run.position.y + delta[1]);
  }

  /** Checks the obvious cases locally to avoid a round trip and a toast on every wall bump. */
  #tryMove(x, y) {
    const run = this.#state?.run;
    const grid = run?.grid;
    if (!grid || run.finished) return;
    if (x < 0 || y < 0 || x >= grid.size || y >= grid.size) return;
    if (Math.abs(x - run.position.x) + Math.abs(y - run.position.y) !== 1) return;
    const cell = grid.cells[y * grid.size + x];
    if (cell.state === 'void') return;
    if (run.challenge && cell.state !== 'cleared') {
      this.#els.mapHint.classList.remove('map__hint--flash');
      void this.#els.mapHint.offsetWidth; // restart the CSS animation
      this.#els.mapHint.classList.add('map__hint--flash');
      return;
    }
    this.#lastMoveAt = Date.now();
    this.#client.move(x, y);
  }

  // ------------------------------------------------------------------ update

  update(state) {
    this.#state = state;
    const { run, game } = state;
    if (!run || !game) return;

    setText(this.#els.floorValue, pad2(run.floor));
    this.#els.floorPips.querySelectorAll('.pips__pip').forEach((pip, index) => {
      pip.classList.toggle('pips__pip--done', index + 1 < run.floor);
      pip.classList.toggle('pips__pip--current', index + 1 === run.floor);
    });
    this.#els.keySlots.forEach((slot, index) => {
      // Each collected key takes the color of the sector it came from.
      const area = run.keyAreas?.[index];
      slot.className = `key-slot${area === undefined ? '' : ` key-slot--filled key-slot--area-${area}`}`;
    });
    this.#chimeOnNewKey(run);
    setText(this.#els.guessed, run.stats.guessed);
    setText(this.#els.partsFound, formatPartsFound(run.stats));
    setText(this.#els.rerollCount, run.rerolls);
    setText(this.#els.rerollLabel, `/ ${game.settings.maxRerolls}`);

    const avatarsById = avatarLookup(state.avatars);
    this.#renderMap(run, state.playerId, avatarsById);
    this.#renderSectors(run);
    this.#renderDoors(run, game, state.playerId, avatarsById);
    this.#renderChallenge(run);
    this.#renderResult(state.lastResult);
    this.#renderRanking(state.leaderboard, state.playerId, avatarsById, game.settings.answerMode);
    this.#tick();
  }

  /** Any teammate picking up a key plays the chime for everyone. */
  #chimeOnNewKey(run) {
    const seen = this.#seenKeys;
    if (seen.floor === run.floor && run.keys > seen.keys) playKeyChime(this.#audio.volume);
    this.#seenKeys = { floor: run.floor, keys: run.keys };
  }

  #renderMap(run, playerId, avatarsById) {
    setText(this.#els.mapTitle, `Floor ${pad2(run.floor)} — Map`);
    setText(this.#els.mapHint, run.challenge
      ? 'Guess this song to explore the tile, or step back onto explored ground.'
      : 'Move with WASD / ZQSD or the arrows. Walking onto an unexplored tile plays its song.');
    this.#grid.update(run.grid, run.players, playerId, Boolean(run.challenge), avatarsById);
  }

  #renderSectors(run) {
    if (!run.grid) return;
    const { center } = run.grid;
    const centerRow = h('li', { class: 'sector sector--neutral' },
      h('span', { class: 'sector__swatch' }),
      h('div', { class: 'sector__info' },
        h('span', { class: 'sector__tag', text: 'Center' }),
        h('span', { class: 'sector__status', text: center.revealed ? 'Door located · any song'
          : `${center.guesses}/${this.#revealAfter} songs to locate the door · any song` })),
      h('span', { class: 'sector__items' },
        icon('door', `sector__item${center.doorFound ? ' sector__item--done' : ''}`)));
    replaceChildren(this.#els.sectors, centerRow, run.grid.areas.map((area) => {
      const status = !area.discovered ? 'Not found yet'
        : area.revealed ? 'Key & door located'
          : `${area.guesses}/${this.#revealAfter} songs to locate key & door`;
      return h('li', { class: `sector sector--area-${area.index}${area.discovered ? '' : ' sector--unknown'}` },
        h('span', { class: 'sector__swatch' }),
        h('div', { class: 'sector__info' },
          h('span', { class: 'sector__tag', text: formatTag(area.tag), title: formatTag(area.tag) }),
          h('span', { class: 'sector__status', text: status })),
        h('span', { class: 'sector__items' },
          icon('key', `sector__item${area.keyCollected ? ' sector__item--done' : ''}`),
          icon('door', `sector__item${area.doorFound ? ' sector__item--done' : ''}`)));
    }));
  }

  /**
   * Found doors. With 2+ players online, clicking a door votes for it (the voters' tokens sit
   * next to it); the server opens the winner or rolls between tied doors.
   */
  #renderDoors(run, game, playerId, avatarsById) {
    const doors = run.grid?.doors ?? [];
    const players = run.players ?? [];
    const online = players.filter((player) => player.online !== false);
    const signature = JSON.stringify([doors, run.keys, run.floor, run.doorRoll?.id ?? null,
      online.map((player) => player.id), players.map((player) => player.avatar)]);
    if (signature === this.#doorsSignature) return;
    this.#doorsSignature = signature;
    this.#doorEls.clear();

    if (doors.length === 0) {
      replaceChildren(this.#els.doors, h('p', { class: 'hint',
        text: 'No door found yet. Every area (the center too) hides one door, usually far from the entrance.' }));
      this.#animateRoll(null);
      return;
    }
    const context = {
      run,
      playerId,
      avatarsById,
      isFinal: run.floor >= game.settings.floors,
      voting: online.length >= 2,
      playersById: new Map(players.map((player) => [player.id, player])),
    };
    const votes = doors.reduce((count, door) => count + door.voters.length, 0);
    const voteHint = context.voting && run.keys >= KEYS_REQUIRED && h('p', {
      class: 'hint doors__vote-hint',
      text: run.doorRoll ? 'Tie! Rolling for the door…'
        : `Vote for a door: ${votes}/${online.length} voted. Most votes wins, a tie is rolled.`,
    });
    replaceChildren(this.#els.doors, voteHint, doors.map((door) => {
      const card = this.#buildDoor(door, context);
      this.#doorEls.set(door.areaIndex, card);
      return card;
    }));
    this.#animateRoll(run.doorRoll);
  }

  #buildDoor(door, { run, playerId, avatarsById, isFinal, voting, playersById }) {
    const canOpen = run.keys >= KEYS_REQUIRED;
    const missing = KEYS_REQUIRED - run.keys;
    const myVote = door.voters.includes(playerId);
    const voters = door.voters.map((id) => playersById.get(id)).filter(Boolean);

    let label = isFinal ? 'Ascend to the summit' : 'Open for the team';
    if (!canOpen) label = `Team needs ${missing} more key${missing > 1 ? 's' : ''}`;
    else if (run.doorRoll) label = 'Rolling…';
    else if (voting) label = myVote ? 'Your vote — click to withdraw' : 'Vote for this door';
    let title = 'Takes the whole team to the next floor';
    if (!canOpen) title = `The team needs ${KEYS_REQUIRED} keys`;
    else if (voting) title = 'Every player votes; the most voted door opens for the team';

    return h('div', {
      class: `door ${door.areaIndex === NEUTRAL_AREA ? 'door--neutral' : `door--area-${door.areaIndex}`}`,
    },
    h('div', { class: 'door__head' }, icon('door'),
      h('span', { class: 'door__name', text: door.areaIndex === NEUTRAL_AREA ? 'Center door' : `Door ${SECTOR_LETTERS[door.areaIndex]}` }),
      voters.length > 0 && h('span', { class: 'door__votes', title: voters.map((p) => p.name).join(', ') },
        voters.map((voter) => playerToken(voter, avatarsById, { self: voter.id === playerId, className: 'door__voter' }))),
      h('span', { class: 'door__next', text: isFinal ? 'to summit' : `to floor ${pad2(run.floor + 1)}` })),
    !isFinal && h('div', { class: 'chips' },
      door.tags.map((tag) => h('span', { class: 'chip chip--tag', text: formatTag(tag), title: formatTag(tag) }))),
    h('button', {
      class: `btn btn--primary btn--block${myVote ? ' btn--confirmed' : ''}`,
      type: 'button',
      disabled: !canOpen || Boolean(run.doorRoll),
      title,
      onClick: () => this.#client.enterDoor(door.areaIndex),
    }, label));
  }

  /**
   * Tie between doors: the highlight jumps between the tied doors, slowing down until it lands
   * on the winner the server already drew, shortly before the team goes through.
   */
  #animateRoll(roll) {
    if (!roll) {
      clearTimeout(this.#roll.timer);
      this.#roll = { id: null, candidates: [], highlighted: null, settled: false, timer: null };
      return;
    }
    if (roll.id !== this.#roll.id) this.#startRoll(roll);
    this.#paintRoll();
  }

  #startRoll(roll) {
    clearTimeout(this.#roll.timer);
    const delays = [];
    const available = roll.endsAt - Date.now() - ROLL_SETTLE_MS;
    for (let delay = ROLL_FIRST_STEP_MS, total = delay; total < available; delay *= ROLL_SLOWDOWN, total += delay) {
      delays.push(delay);
    }
    const { candidates } = roll;
    // Start far enough back that the last step lands on the winner.
    let position = candidates.indexOf(roll.winner) - delays.length;
    position = ((position % candidates.length) + candidates.length) % candidates.length;
    const state = {
      id: roll.id, candidates, highlighted: candidates[position], settled: delays.length === 0, timer: null,
    };
    this.#roll = state;

    const step = (index) => {
      if (index >= delays.length) return;
      state.timer = setTimeout(() => {
        position = (position + 1) % candidates.length;
        state.highlighted = candidates[position];
        state.settled = index === delays.length - 1;
        this.#paintRoll();
        step(index + 1);
      }, delays[index]);
    };
    step(0);
  }

  #paintRoll() {
    const { candidates, highlighted, settled } = this.#roll;
    for (const [areaIndex, card] of this.#doorEls) {
      card.classList.toggle('door--roll-candidate', candidates.includes(areaIndex));
      card.classList.toggle('door--roll-active', highlighted === areaIndex && !settled);
      card.classList.toggle('door--roll-winner', highlighted === areaIndex && settled);
    }
  }

  #renderChallenge(run) {
    const { challenge } = run;
    const els = this.#els;
    els.signalIdle.hidden = Boolean(challenge);
    els.signalActive.hidden = !challenge;
    this.#answer.disabled = !challenge;
    els.rerollButton.disabled = !challenge || run.rerolls <= 0;
    setText(els.rerollButton.lastChild, `Reroll this song (${run.rerolls})`);

    if (!challenge) {
      // Guessed, or walked away: the song stops and movement keys work again.
      if (this.#challengeId !== null) {
        this.#audio.stop();
        this.#answer.clear();
        this.#answer.blur();
      }
      this.#challengeId = null;
      replaceChildren(els.signalMeta);
      if (run.tileAnswer) {
        // Standing on an explored tile: show what its song was.
        setText(els.signalTitle, 'Explored tile');
        replaceChildren(els.signalIdle, h('div', { class: 'result tile-answer' }, answerDetails(run.tileAnswer)));
        return;
      }
      setText(els.signalTitle, 'Exploring');
      replaceChildren(els.signalIdle, h('div', { class: 'keys-help' },
        h('div', { class: 'keys-help__pad' },
          h('kbd', { class: 'keys-help__up', text: 'W' }), h('kbd', { text: 'A' }), h('kbd', { text: 'S' }), h('kbd', { text: 'D' })),
        h('p', { text: 'Move with WASD (ZQSD on AZERTY) or the arrow keys. Clicking a tile next to you works too.' })));
      return;
    }

    setText(els.signalTitle, 'Signal acquired');
    replaceChildren(els.signalMeta,
      h('span', { class: 'chip chip--accent chip--tag', text: formatTag(challenge.tag), title: formatTag(challenge.tag) }),
      h('span', { class: 'chip', text: formatSongType(challenge.type) }),
      h('span', { class: 'chip chip--mono', text: `X${pad2(challenge.x)} · Y${pad2(challenge.y)}` }));

    if (challenge.id !== this.#challengeId) {
      this.#challengeId = challenge.id;
      this.#audio.play(challenge);
      this.#answer.clear();
      this.#answer.focus();
    }
    // S/A: parts found by the team (by you or a teammate on this tile) lock in place.
    this.#answer.update(challenge.progress);
  }

  #renderAudioState(audioState) {
    const labels = { loading: 'Buffering…', playing: '', paused: 'Paused — press play', error: 'Audio unavailable — reroll this one.', idle: '' };
    setText(this.#els.audioStatus, labels[audioState] ?? '');
    this.#els.eq.classList.toggle('eq--active', audioState === 'playing');
    this.#els.pauseButton.replaceChildren(icon(audioState === 'playing' ? 'pause' : 'play'));
  }

  #renderResult(result) {
    if (!result || result.seq === this.#resultSeq) return;
    this.#resultSeq = result.seq;

    if (result.kind === 'wrong') {
      // Nothing is revealed: the same song stays on the tile until guessed or rerolled.
      this.#answer.showWrong(result.missed);
      const what = result.missed?.length === 1
        ? (result.missed[0] === 'song' ? 'Wrong song name' : 'Wrong artist')
        : `"${result.guess}" is not it`;
      showToast(`${what} — try again or reroll`, 'error');
      return;
    }
    if (result.kind === 'known') {
      showToast('Already found — complete the rest', 'info');
      return;
    }
    if (result.kind === 'progress') {
      const message = describeProgress(result.found, result.summary);
      showToast(result.by ? `${result.by}: ${message}` : message, result.by ? 'info' : 'success');
      return;
    }

    const { answer } = result;
    const banners = {
      correct: () => h('div', { class: 'result__banner result__banner--good' }, icon('check'), 'Correct'),
      teammate: () => h('div', { class: 'result__banner result__banner--good' }, icon('check'), `${result.by} guessed it`),
      rerolled: () => h('div', { class: 'result__banner result__banner--neutral' }, icon('reroll'),
        result.by ? `${result.by} rerolled — it was` : 'Rerolled — it was'),
    };
    const banner = (banners[result.kind] ?? banners.correct)();
    replaceChildren(this.#els.result, banner, answerDetails(answer));
    this.#els.result.className = 'result';
  }

  #renderRanking(entries, playerId, avatarsById, answerMode) {
    replaceChildren(this.#els.ranking, entries.map((entry) => h('li', {
      class: `rank${entry.id === playerId ? ' rank--me' : ''}${entry.online ? '' : ' rank--offline'}`,
    },
    h('span', { class: 'rank__pos', text: pad2(entry.rank) }),
    playerToken(entry, avatarsById, { className: 'rank__token' }),
    h('span', { class: 'rank__name', text: entry.name }),
    h('span', { class: 'rank__score', text: `${entry.guessed} ♪` }),
    answerMode === 'songArtist' && h('span', {
      class: 'rank__parts',
      title: 'Song names / artists found',
      text: formatPartsFound(entry),
    }))));
  }

  /** Local clock: timer and reroll cooldown between server updates. */
  #tick() {
    const { game, run } = this.#state ?? {};
    if (!game || !run) return;
    const remaining = game.endsAt - Date.now();
    setText(this.#els.timer, formatDuration(remaining));
    this.#els.timer.classList.toggle('hud__timer--warning', remaining < TIMER_WARNING_MS);

    const intervalMs = game.settings.rerollIntervalSec * 1000;
    const progress = run.rerollAt === null ? 1 : 1 - Math.max(0, run.rerollAt - Date.now()) / intervalMs;
    this.#els.rerollBar.style.width = `${Math.round(Math.min(1, progress) * 100)}%`;
  }
}

/** S/A counters: "S 3 · A 2" (song names / artists found). */
function formatPartsFound({ songsFound = 0, artistsFound = 0 }) {
  return `S ${songsFound} · A ${artistsFound}`;
}

/** Toast text for newly found S/A parts. */
function describeProgress(found, summary) {
  const parts = found.map((part) => {
    if (part === 'song') return 'song name found';
    if (part === 'artist') return 'artist found';
    return `member found (${summary.members.length}/${summary.memberCount})`;
  });
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
