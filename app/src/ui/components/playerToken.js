import { h } from '../dom.js';

/**
 * A player's round token: their avatar image, or a colored circle with their initial.
 * @param {{name: string, avatar?: string, color?: number}} player
 * @param {Map<string, {url: string}>} avatarsById
 * @param {object} [options]
 * @param {boolean} [options.self]  Highlights the local player's token.
 * @param {string} [options.className]
 * @returns {HTMLSpanElement}
 */
export function playerToken(player, avatarsById, { self = false, className = '' } = {}) {
  const avatar = player.avatar ? avatarsById.get(player.avatar) : null;
  const token = h('span', {
    class: `token token--color-${player.color ?? 0}${self ? ' token--self' : ''} ${className}`.trim(),
    title: player.name,
  });
  if (avatar) token.append(h('img', { class: 'token__image', src: avatar.url, alt: '' }));
  else token.append(h('span', { class: 'token__initial', text: player.name.slice(0, 1).toUpperCase() }));
  return token;
}

/**
 * Builds a lookup from the avatar catalog (cached per catalog array).
 * @param {{id: string, url: string}[]} avatars
 * @returns {Map<string, {id: string, url: string}>}
 */
export const avatarLookup = (() => {
  let lastCatalog = null;
  let lastMap = new Map();
  return (avatars) => {
    if (avatars !== lastCatalog) {
      lastCatalog = avatars;
      lastMap = new Map(avatars.map((avatar) => [avatar.id, avatar]));
    }
    return lastMap;
  };
})();
