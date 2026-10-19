/**
 * Minimal event emitter used by connections, the store and the server.
 */
export class Emitter {
  #listeners = new Map();

  /**
   * Subscribes to an event.
   * @param {string} event
   * @param {(...args: any[]) => void} listener
   * @returns {() => void} Unsubscribe function.
   */
  on(event, listener) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
    this.#listeners.get(event).add(listener);
    return () => this.off(event, listener);
  }

  /**
   * @param {string} event
   * @param {(...args: any[]) => void} listener
   */
  off(event, listener) {
    this.#listeners.get(event)?.delete(listener);
  }

  /**
   * @param {string} event
   * @param {...any} args
   */
  emit(event, ...args) {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) {
      try {
        listener(...args);
      } catch (error) {
        console.error(`[Emitter] listener for "${event}" failed`, error);
      }
    }
  }

  removeAllListeners() {
    this.#listeners.clear();
  }
}
