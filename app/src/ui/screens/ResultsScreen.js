import { formatDuration } from '../../core/time.js';
import { h, panel, replaceChildren, setText } from '../dom.js';
import { pad2 } from '../format.js';
import { icon } from '../icons.js';
import { avatarLookup, playerToken } from '../components/playerToken.js';

const COLUMNS = ['#', 'Operator', 'Songs guessed', 'Rerolls used'];
/** Extra columns in S/A mode. */
const PART_COLUMNS = ['Song names found', 'Artists found'];

/**
 * Final ranking, shown when time runs out or everyone reached the top.
 */
export class ResultsScreen {
  #client;
  #root;
  #els = {};

  /** @param {{ client: import('../../client/GameClient.js').GameClient }} options */
  constructor({ client }) {
    this.#client = client;
  }

  mount(root, state) {
    const els = this.#els;
    els.summary = h('p', { class: 'results__summary' });
    els.head = h('tr');
    els.body = h('tbody');
    els.action = h('div', { class: 'results__action' });
    const { root: table } = panel({ title: 'Final Ranking', code: 'REPORT // END', className: 'results__panel' },
      h('div', { class: 'table-wrap' },
        h('table', { class: 'table' },
          h('thead', {}, els.head),
          els.body)),
      els.action);

    this.#root = h('div', { class: 'screen results' },
      h('p', { class: 'eyebrow', text: '// Operation complete' }),
      h('h2', { class: 'results__title', text: 'Mission Report' }),
      els.summary,
      table);
    root.append(this.#root);
    this.update(state);
  }

  update(state) {
    const { results, isHost, playerId } = state;
    if (!results) return;
    const avatarsById = avatarLookup(state.avatars);
    const outcome = results.finished
      ? `Summit reached (floor ${results.totalFloors}) in ${formatDuration(results.durationMs)}`
      : `Time up — the team reached floor ${results.floorReached} of ${results.totalFloors}`;
    setText(this.#els.summary, `${outcome} · ${results.players.length} operators`);
    const showParts = results.answerMode === 'songArtist';
    replaceChildren(this.#els.head, [...COLUMNS, ...(showParts ? PART_COLUMNS : [])]
      .map((label) => h('th', { text: label })));

    replaceChildren(this.#els.body, results.players.map((player) => h('tr', {
      class: `${player.id === playerId ? 'table__row--me' : ''} ${player.rank <= 3 ? `table__row--podium-${player.rank}` : ''}`.trim(),
    },
    h('td', { class: 'table__rank', text: pad2(player.rank) }),
    h('td', { class: 'table__name' },
      h('span', { class: 'table__player' },
        playerToken(player, avatarsById),
        player.name,
        player.rank === 1 && icon('trophy', 'table__trophy'))),
    h('td', { text: player.guessed }),
    h('td', { text: player.rerollsUsed }),
    showParts && h('td', { text: player.songsFound ?? 0 }),
    showParts && h('td', { text: player.artistsFound ?? 0 }))));

    replaceChildren(this.#els.action, isHost
      ? h('button', { class: 'btn btn--primary btn--large', type: 'button', onClick: () => this.#client.returnToLobby() },
        icon('replay'), 'Return to lobby')
      : h('p', { class: 'hint', text: 'Waiting for the host to start a new round…' }));
  }

  unmount() {
    this.#root.remove();
  }
}
