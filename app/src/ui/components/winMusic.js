import { WIN_MUSIC_URL } from '../../config.js';
import { savedVolume } from './AudioPlayer.js';

/** @type {HTMLAudioElement | null} */
let music = null;

/** Plays the summit theme once, at the player's music volume. */
export async function playWinMusic() {
  stopWinMusic();
  const volume = savedVolume();
  if (volume <= 0) return;
  music = new Audio(WIN_MUSIC_URL);
  music.volume = volume;
  try {
    await music.play();
  } catch (error) {
    // Music is a bonus: a blocked or missing file must never break the results screen.
    console.warn('[winMusic] could not play', error);
  }
}

/** Stops the summit theme (back to the lobby). */
export function stopWinMusic() {
  if (!music) return;
  music.pause();
  music.src = '';
  music = null;
}
