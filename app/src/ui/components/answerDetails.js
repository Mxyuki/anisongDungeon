import { h } from '../dom.js';
import { formatSongSlot } from '../format.js';

/**
 * Anime, song and artist of a revealed song (Signal panel, results map review).
 * @param {{ anime: string, englishName?: string, title: string, artist: string, type: string,
 *   number: number, guessRate: number }} answer
 * @param {{ compact?: boolean }} [options]  compact: no English name and guess rate.
 * @returns {HTMLElement[]}
 */
export function answerDetails(answer, { compact = false } = {}) {
  return [
    h('p', { class: 'result__anime', text: answer.anime }),
    !compact && answer.englishName && h('p', { class: 'result__english', text: answer.englishName }),
    h('p', { class: 'result__song' },
      h('span', { class: 'chip chip--mono', text: formatSongSlot(answer.type, answer.number) }),
      h('span', { text: ` ${answer.title}` })),
    h('p', { class: 'result__artist', text: answer.artist }),
    !compact && h('p', { class: 'result__rate', text: `Guess rate ${answer.guessRate}%` }),
  ].filter(Boolean);
}
