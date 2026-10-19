/**
 * Short synthesized sound effects (Web Audio), so no audio files need to ship with the game.
 */

/** Two rising notes, like a small "ding-ding". */
const KEY_CHIME_NOTES = [880, 1318.5];
const NOTE_GAP_S = 0.09;
const NOTE_LENGTH_S = 0.35;
const PEAK_GAIN = 0.3;

let context = null;

/**
 * Plays the key-collected chime.
 * @param {number} volume  0-1, usually the player's music volume.
 */
export function playKeyChime(volume) {
  if (volume <= 0) return;
  try {
    context ??= new AudioContext();
    const start = context.currentTime;
    KEY_CHIME_NOTES.forEach((frequency, index) => {
      const time = start + index * NOTE_GAP_S;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'triangle';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.exponentialRampToValueAtTime(PEAK_GAIN * volume, time + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + NOTE_LENGTH_S);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(time);
      oscillator.stop(time + NOTE_LENGTH_S);
    });
  } catch (error) {
    // A missing sound effect must never break the game.
    console.warn('[sfx] key chime unavailable', error);
  }
}
