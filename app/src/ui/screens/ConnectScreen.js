import { NAME_MAX_LENGTH, ROOM_CODE_LENGTH } from '../../config.js';
import { normalizeRoomCode, isValidRoomCode } from '../../net/roomCode.js';
import { h, panel, setText } from '../dom.js';
import { icon } from '../icons.js';

/**
 * First screen. Join mode: room code entry, then (when a game is already running) the name of
 * the disconnected player to rejoin as. Host mode: server boot status.
 */
export class ConnectScreen {
  #client;
  #onRetryHost;
  #root;
  #codeInput;
  #connectButton;
  #codeForm;
  #rejoinForm;
  #nameInput;
  #rejoinButton;
  #status;
  #retryButton;

  /**
   * @param {object} options
   * @param {import('../../client/GameClient.js').GameClient} options.client
   * @param {() => void} options.onRetryHost
   */
  constructor({ client, onRetryHost }) {
    this.#client = client;
    this.#onRetryHost = onRetryHost;
  }

  mount(root, state) {
    const isHost = state.mode === 'host';
    this.#status = h('p', { class: 'connect__status', role: 'status' });
    this.#retryButton = h('button', {
      class: 'btn btn--ghost',
      type: 'button',
      hidden: true,
      onClick: () => this.#onRetryHost(),
    }, icon('replay'), 'Retry');

    const { root: terminal } = panel(
      { title: isHost ? 'Host Server' : 'Access Terminal', code: isHost ? 'SRV // 01' : 'AUTH // 01', className: 'connect__panel' },
      isHost ? this.#hostBody() : this.#joinBody(),
      this.#status,
      this.#retryButton,
    );

    this.#root = h('div', { class: 'screen connect' },
      h('div', { class: 'connect__hero' },
        h('p', { class: 'eyebrow', text: '// Operation : Anisong — Tower Ascent' }),
        h('h1', { class: 'connect__title' }, 'Anisong', h('br'), h('span', { text: 'Dungeon' })),
        h('p', { class: 'connect__subtitle', text: 'Guess anime songs, collect keys, choose your doors and climb the tower before time runs out.' }),
        h('ol', { class: 'connect__steps' },
          h('li', {}, h('b', { text: 'Explore' }), ' — click a tile next to explored ground and name the anime of the song.'),
          h('li', {}, h('b', { text: 'Collect' }), ' — every themed sector hides a key and a door.'),
          h('li', {}, h('b', { text: 'Ascend' }), ' — 3 keys open a door. Pick the themes of your next floor.'))),
      terminal);
    root.append(this.#root);
    this.update(state);
    this.#codeInput?.focus();
  }

  #joinBody() {
    this.#codeInput = h('input', {
      class: 'field__input code-input',
      type: 'text',
      maxlength: ROOM_CODE_LENGTH,
      placeholder: '······',
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': 'Room code',
      onInput: () => {
        this.#codeInput.value = normalizeRoomCode(this.#codeInput.value);
        this.#syncButton();
      },
      onKeydown: (event) => event.key === 'Enter' && this.#join(),
    });
    const initialCode = normalizeRoomCode(new URLSearchParams(location.search).get('code'));
    this.#codeInput.value = initialCode;
    this.#connectButton = h('button', {
      class: 'btn btn--primary btn--block',
      type: 'button',
      onClick: () => this.#join(),
    }, 'Connect', icon('play'));
    this.#codeForm = h('div', { class: 'connect__form' },
      h('label', { class: 'field' },
        h('span', { class: 'field__label', text: 'Room code' }),
        this.#codeInput),
      h('p', { class: 'hint', text: 'Ask the host for the 6-character code shown in their lobby. Lost your connection? Enter the same code to rejoin.' }),
      this.#connectButton);
    return h('div', {}, this.#codeForm, this.#rejoinBody());
  }

  /** Shown when the room is mid-game: the player names who they were before disconnecting. */
  #rejoinBody() {
    this.#nameInput = h('input', {
      class: 'field__input',
      type: 'text',
      maxlength: NAME_MAX_LENGTH,
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': 'Your name in this game',
      onInput: () => this.#syncRejoinButton(),
      onKeydown: (event) => event.key === 'Enter' && this.#rejoin(),
    });
    this.#rejoinButton = h('button', {
      class: 'btn btn--primary btn--block',
      type: 'button',
      onClick: () => this.#rejoin(),
    }, 'Rejoin', icon('play'));
    this.#rejoinForm = h('div', { class: 'connect__form', hidden: true },
      h('label', { class: 'field' },
        h('span', { class: 'field__label', text: 'Your name in this game' }),
        this.#nameInput),
      h('p', { class: 'hint', text: 'A game is in progress. Type the name you had before you got disconnected to take your place back.' }),
      this.#rejoinButton);
    return this.#rejoinForm;
  }

  #rejoin() {
    const name = this.#nameInput.value.trim();
    if (name) this.#client.rejoin(name);
  }

  #syncRejoinButton(pending = false) {
    this.#rejoinButton.disabled = pending || !this.#nameInput.value.trim();
  }

  /** Swaps between the code form and the rejoin (name) form. */
  #updateRejoin(rejoin) {
    const asking = rejoin !== null;
    const wasAsking = !this.#rejoinForm.hidden;
    this.#codeForm.hidden = asking;
    this.#rejoinForm.hidden = !asking;
    if (!asking) return;
    if (!wasAsking) {
      this.#nameInput.value = this.#client.savedProfile.name;
      this.#nameInput.focus();
      this.#nameInput.select();
    }
    this.#syncRejoinButton(rejoin.pending);
  }

  #hostBody() {
    return h('div', { class: 'connect__boot' },
      h('div', { class: 'loader' }, h('span'), h('span'), h('span')),
      h('p', { class: 'hint', text: 'Registering your room and loading the song library. Keep this window and the launcher open while you play — your PC is the server.' }));
  }

  #join() {
    const code = normalizeRoomCode(this.#codeInput.value);
    if (!isValidRoomCode(code)) return;
    this.#client.join(code);
  }

  #syncButton(connecting = false) {
    if (!this.#connectButton) return;
    const valid = isValidRoomCode(normalizeRoomCode(this.#codeInput.value));
    this.#connectButton.disabled = connecting || !valid;
  }

  update(state) {
    const { status, error } = state.connection;
    const connecting = status === 'connecting';
    const failed = status === 'error' || status === 'closed';
    this.#status.className = `connect__status${failed ? ' connect__status--error' : ''}`;
    if (state.mode === 'host') {
      setText(this.#status, failed ? error : 'Booting server…');
      this.#retryButton.hidden = !failed;
    } else {
      const { rejoin } = state;
      if (failed && !this.#codeInput.value && state.roomCode) this.#codeInput.value = state.roomCode;
      this.#updateRejoin(rejoin);
      let message = connecting ? 'Establishing link…' : failed ? error : '';
      if (rejoin) message = rejoin.pending ? 'Checking…' : rejoin.error;
      setText(this.#status, message);
      this.#status.classList.toggle('connect__status--error', Boolean(rejoin?.error && !rejoin.pending));
      this.#syncButton(connecting);
    }
  }

  unmount() {
    this.#root.remove();
  }
}
