import { h } from '../dom.js';

const TOAST_DURATION_MS = 4000;
let container = null;

/**
 * Shows a short message in the bottom-right corner.
 * @param {string} message
 * @param {'info' | 'error' | 'success'} [kind]
 */
export function showToast(message, kind = 'info') {
  if (!container) {
    container = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(container);
  }
  const toast = h('div', { class: `toast toast--${kind}`, text: message });
  container.append(toast);
  setTimeout(() => {
    toast.classList.add('toast--leaving');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }, TOAST_DURATION_MS);
}
