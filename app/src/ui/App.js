import { PHASE } from '../net/protocol.js';
import { showToast } from './components/toast.js';
import { ConnectScreen } from './screens/ConnectScreen.js';
import { GameScreen } from './screens/GameScreen.js';
import { LoadingScreen } from './screens/LoadingScreen.js';
import { LobbyScreen } from './screens/LobbyScreen.js';
import { ResultsScreen } from './screens/ResultsScreen.js';

/** Screen registry: key → factory. Each screen implements mount/update/unmount. */
const SCREENS = {
  connect: (deps) => new ConnectScreen(deps),
  lobby: (deps) => new LobbyScreen(deps),
  loading: () => new LoadingScreen(),
  game: (deps) => new GameScreen(deps),
  results: (deps) => new ResultsScreen(deps),
};

/**
 * Picks which screen matches the client state.
 * @param {import('../client/store.js').ClientState} state
 * @returns {keyof typeof SCREENS}
 */
function screenFor(state) {
  if (state.connection.status !== 'connected' || !state.lobby) return 'connect';
  switch (state.lobby.phase) {
    case PHASE.LOBBY: return 'lobby';
    case PHASE.PLAYING: return state.game && state.run ? 'game' : 'loading';
    case PHASE.RESULTS: return state.results ? 'results' : 'loading';
    default: return 'loading';
  }
}

/**
 * Root UI controller: mounts the right screen and forwards state updates to it.
 */
export class App {
  #root;
  #deps;
  #currentKey = null;
  #current = null;

  /**
   * @param {HTMLElement} root
   * @param {object} deps
   * @param {import('../client/store.js').Store} deps.store
   * @param {import('../client/GameClient.js').GameClient} deps.client
   * @param {() => void} deps.onRetryHost
   */
  constructor(root, deps) {
    this.#root = root;
    this.#deps = deps;
    deps.client.on('notice', (message, kind) => showToast(message, kind));
    deps.store.subscribe((state) => this.#render(state));
    this.#render(deps.store.state);
  }

  #render(state) {
    const key = screenFor(state);
    if (key !== this.#currentKey) {
      this.#current?.unmount();
      this.#currentKey = key;
      this.#current = SCREENS[key](this.#deps);
      this.#current.mount(this.#root, state);
      return;
    }
    this.#current.update(state);
  }
}
