import { MIN_PLAY_SECONDS, STORAGE_KEYS } from '../../config.js';
import { Emitter } from '../../core/emitter.js';

const DEFAULT_VOLUME = 0.6;

/**
 * The player's saved music volume (0-1), also used for other music (win theme).
 * @returns {number}
 */
export function savedVolume() {
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEYS.volume));
    return Number.isFinite(stored) && stored > 0 ? Math.min(1, stored) : DEFAULT_VOLUME;
  } catch {
    return DEFAULT_VOLUME;
  }
}

/**
 * Plays challenge audio with mirror fallback and a random start point.
 * Emits `state` with 'idle' | 'loading' | 'playing' | 'paused' | 'error'.
 */
export class AudioPlayer extends Emitter {
  #audio = new Audio();
  #urls = [];
  #urlIndex = 0;
  #startFraction = 0;
  #startTime = 0;
  /** @type {string | number | null} */ currentId = null;
  state = 'idle';

  constructor() {
    super();
    this.#audio.preload = 'auto';
    this.#audio.volume = savedVolume();
    this.#audio.addEventListener('loadedmetadata', () => this.#seekToStart());
    this.#audio.addEventListener('playing', () => this.#setState('playing'));
    this.#audio.addEventListener('pause', () => this.#setState('paused'));
    this.#audio.addEventListener('waiting', () => this.#setState('loading'));
    this.#audio.addEventListener('error', () => this.#tryNextUrl());
  }

  get volume() {
    return this.#audio.volume;
  }

  set volume(value) {
    this.#audio.volume = value;
    try {
      localStorage.setItem(STORAGE_KEYS.volume, String(value));
    } catch {
      // Volume simply won't be remembered.
    }
  }

  /**
   * Starts a challenge's song. Calling again with the same id does nothing.
   * @param {{ id: string | number, media: string[], startFraction: number }} challenge
   */
  play({ id, media, startFraction }) {
    if (id === this.currentId) return;
    this.currentId = id;
    this.#urls = media;
    this.#urlIndex = 0;
    this.#startFraction = startFraction;
    this.#load();
  }

  /** Restarts from the challenge's start point. */
  replay() {
    if (!this.#urls.length) return;
    this.#audio.currentTime = this.#startTime;
    this.#start();
  }

  togglePause() {
    if (this.#audio.paused) this.#start();
    else this.#audio.pause();
  }

  stop() {
    this.#audio.pause();
    this.currentId = null;
    this.#setState('idle');
  }

  destroy() {
    this.stop();
    this.#audio.removeAttribute('src');
    this.#audio.load();
    this.removeAllListeners();
  }

  #load() {
    this.#setState('loading');
    this.#audio.src = this.#urls[this.#urlIndex];
    this.#start();
  }

  #start() {
    this.#audio.play().catch((error) => {
      // Autoplay can be blocked until the user interacts; they can press play.
      if (error.name === 'NotAllowedError') this.#setState('paused');
    });
  }

  #seekToStart() {
    const duration = this.#audio.duration;
    const playable = Number.isFinite(duration) ? Math.max(0, duration - MIN_PLAY_SECONDS) : 0;
    this.#startTime = playable * this.#startFraction;
    this.#audio.currentTime = this.#startTime;
  }

  #tryNextUrl() {
    if (!this.#audio.getAttribute('src')) return;
    this.#urlIndex++;
    if (this.#urlIndex < this.#urls.length) this.#load();
    else this.#setState('error');
  }

  #setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }
}
