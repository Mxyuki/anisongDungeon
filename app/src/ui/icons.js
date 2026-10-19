/**
 * Static inline SVG icons (trusted markup — the only allowed use of innerHTML).
 */

const PATHS = {
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M14 9l2 2"/>',
  door: '<path d="M5 21V4l10-1v18M15 3l4 2v16M3 21h18"/><circle cx="12" cy="12" r=".8" fill="currentColor"/>',
  start: '<path d="M12 3l8 9-8 9-8-9z"/><circle cx="12" cy="12" r="2"/>',
  lock: '<rect x="5" y="11" width="14" height="10"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  crown: '<path d="M3 18l2-11 5 5 2-7 2 7 5-5 2 11z"/>',
  copy: '<rect x="8" y="8" width="12" height="12"/><path d="M16 8V4H4v12h4"/>',
  play: '<path d="M7 4l13 8-13 8z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  replay: '<path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v5h5"/>',
  reroll: '<path d="M20 7H8a4 4 0 0 0 0 8M4 17h12a4 4 0 0 0 0-8"/><path d="M17 4l3 3-3 3M7 14l-3 3 3 3"/>',
  check: '<path d="M4 12l5 5L20 6"/>',
  cross: '<path d="M5 5l14 14M19 5L5 19"/>',
  skip: '<path d="M5 4l10 8-10 8zM19 4v16"/>',
  flag: '<path d="M5 21V4M5 4h12l-2 4 2 4H5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  volume: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  signal: '<path d="M4 20v-4M9 20v-8M14 20V8M19 20V4"/>',
  trophy: '<path d="M7 4h10v5a5 5 0 0 1-10 0zM7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4M12 14v4M8 21h8"/>',
};

/**
 * @param {keyof typeof PATHS} name
 * @param {string} [className]
 * @returns {HTMLSpanElement}
 */
export function icon(name, className = '') {
  const span = document.createElement('span');
  span.className = `icon ${className}`.trim();
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" '
    + `stroke-linecap="square" stroke-linejoin="miter">${PATHS[name] ?? ''}</svg>`;
  return span;
}
