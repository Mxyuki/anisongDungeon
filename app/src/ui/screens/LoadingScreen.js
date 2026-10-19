import { h, setText } from '../dom.js';

/**
 * Shown while the host builds the song pool and the first floor.
 */
export class LoadingScreen {
  #root;
  #message;

  mount(root, state) {
    this.#message = h('p', { class: 'loading__message' });
    this.#root = h('div', { class: 'screen loading' },
      h('p', { class: 'eyebrow', text: '// Deploying' }),
      h('h2', { class: 'loading__title', text: 'Preparing operation' }),
      h('div', { class: 'loading__bar' }, h('span')),
      this.#message);
    root.append(this.#root);
    this.update(state);
  }

  update(state) {
    setText(this.#message, state.loadingMessage || 'Synchronizing with the host…');
  }

  unmount() {
    this.#root.remove();
  }
}
