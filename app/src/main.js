/**
 * Bootstrap. The launcher opens `?mode=host` (start a server and play) or `?mode=join`.
 */
import { GameClient } from './client/GameClient.js';
import { createInitialState, Store } from './client/store.js';
import { HostServer } from './server/HostServer.js';
import { App } from './ui/App.js';

const mode = new URLSearchParams(location.search).get('mode') === 'host' ? 'host' : 'join';
const store = new Store(createInitialState(mode));
const client = new GameClient(store);
let server = null;

async function startHost() {
  store.set({ connection: { status: 'connecting', error: '' } });
  try {
    server = await HostServer.start();
    client.attach(server.connectLocal());
  } catch (error) {
    console.error('[main] host failed to start', error);
    client.fail(error.message);
  }
}

new App(document.getElementById('app'), { store, client, onRetryHost: startHost });

if (mode === 'host') {
  startHost();
  window.addEventListener('beforeunload', (event) => {
    if (!server) return;
    // Closing this tab shuts the room down for everyone.
    event.preventDefault();
  });
  window.addEventListener('pagehide', () => server?.shutdown());
}
