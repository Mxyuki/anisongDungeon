/**
 * Connections between the host server and clients.
 *
 * Every connection exposes the same interface (`send(message)`, `close()`, events `message` and
 * `close`) whether it is a real WebRTC link (PeerJS) or the host's in-memory loopback.
 */
import {
  CONNECT_TIMEOUT_MS,
  MAX_HOST_ID_ATTEMPTS,
  MAX_MESSAGE_CHARS,
  PEER_OPTIONS,
} from '../config.js';
import { Emitter } from '../core/emitter.js';
import { generateRoomCode, peerIdForCode } from './roomCode.js';

const FRAME_WHOLE = 'M';
const FRAME_CHUNK = 'C';

/** Base class: subclasses implement #transmit-like `sendRaw` and call `receive`. */
export class Connection extends Emitter {
  /** @type {string} */ id;
  closed = false;

  constructor(id) {
    super();
    this.id = id;
  }

  /** @param {object} message */
  send(message) {
    if (!this.closed) this.sendRaw(message);
  }

  /** @abstract */
  sendRaw() {
    throw new Error('sendRaw() not implemented');
  }

  close() {
    this.markClosed();
  }

  markClosed() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

/** Wraps a PeerJS DataConnection, adding JSON framing and chunking of large messages. */
export class PeerConnection extends Connection {
  #dataConnection;
  #chunks = new Map();
  #nextChunkId = 0;

  constructor(dataConnection) {
    super(dataConnection.peer);
    this.#dataConnection = dataConnection;
    dataConnection.on('data', (data) => this.#receive(data));
    dataConnection.on('close', () => this.markClosed());
    dataConnection.on('error', (error) => {
      console.warn('[PeerConnection] error', error);
      this.markClosed();
    });
  }

  sendRaw(message) {
    const text = JSON.stringify(message);
    if (text.length <= MAX_MESSAGE_CHARS) {
      this.#dataConnection.send(FRAME_WHOLE + text);
      return;
    }
    const id = this.#nextChunkId++;
    const total = Math.ceil(text.length / MAX_MESSAGE_CHARS);
    for (let i = 0; i < total; i++) {
      const part = text.slice(i * MAX_MESSAGE_CHARS, (i + 1) * MAX_MESSAGE_CHARS);
      this.#dataConnection.send(`${FRAME_CHUNK}${id}|${i}|${total}|${part}`);
    }
  }

  close() {
    this.#dataConnection.close();
    this.markClosed();
  }

  #receive(data) {
    if (typeof data !== 'string' || data.length === 0) return;
    if (data[0] === FRAME_WHOLE) {
      this.#emitParsed(data.slice(1));
      return;
    }
    if (data[0] === FRAME_CHUNK) this.#receiveChunk(data.slice(1));
  }

  #receiveChunk(body) {
    const [id, index, total] = body.split('|', 3);
    const headerLength = id.length + index.length + total.length + 3;
    if (!this.#chunks.has(id)) this.#chunks.set(id, []);
    const parts = this.#chunks.get(id);
    parts[Number(index)] = body.slice(headerLength);
    if (parts.filter((part) => part !== undefined).length === Number(total)) {
      this.#chunks.delete(id);
      this.#emitParsed(parts.join(''));
    }
  }

  #emitParsed(text) {
    try {
      const message = JSON.parse(text);
      if (message && typeof message.type === 'string') this.emit('message', message);
    } catch {
      console.warn('[PeerConnection] dropped malformed message');
    }
  }
}

/** One side of an in-memory connection pair. Messages are cloned to mimic the wire. */
class LoopbackConnection extends Connection {
  /** @type {LoopbackConnection} */ peer;

  sendRaw(message) {
    const copy = structuredClone(message);
    queueMicrotask(() => this.peer.emit('message', copy));
  }

  close() {
    this.markClosed();
    this.peer.markClosed();
  }
}

/**
 * Creates two linked connections: what one sends, the other receives.
 * @param {string} id
 * @returns {[Connection, Connection]} [serverSide, clientSide]
 */
export function createLoopbackPair(id) {
  const serverSide = new LoopbackConnection(id);
  const clientSide = new LoopbackConnection(id);
  serverSide.peer = clientSide;
  clientSide.peer = serverSide;
  return [serverSide, clientSide];
}

function getPeerClass() {
  if (typeof window === 'undefined' || !window.Peer) {
    throw new Error('Networking library failed to load. Check your internet connection.');
  }
  return window.Peer;
}

function describePeerError(error) {
  switch (error?.type) {
    case 'peer-unavailable': return 'No server found with this code. Check the code and retry.';
    case 'network':
    case 'server-error':
    case 'socket-error': return 'Cannot reach the connection broker. Check your internet.';
    case 'browser-incompatible': return 'This browser does not support WebRTC.';
    default: return error?.message || 'Connection failed.';
  }
}

/**
 * Listens for incoming players under a room code. Emits `connection` (PeerConnection).
 */
export class HostTransport extends Emitter {
  /** @type {string} */ code;
  #peer;

  /**
   * Registers a fresh room code with the broker, retrying if the code is taken.
   * @returns {Promise<HostTransport>}
   */
  static async create() {
    const Peer = getPeerClass();
    let lastError;
    for (let attempt = 0; attempt < MAX_HOST_ID_ATTEMPTS; attempt++) {
      const code = generateRoomCode();
      try {
        const peer = await openPeer(new Peer(peerIdForCode(code), PEER_OPTIONS));
        return new HostTransport(code, peer);
      } catch (error) {
        lastError = error;
        if (error?.type !== 'unavailable-id') break;
      }
    }
    throw new Error(describePeerError(lastError));
  }

  constructor(code, peer) {
    super();
    this.code = code;
    this.#peer = peer;
    peer.on('connection', (dataConnection) => {
      dataConnection.on('open', () => this.emit('connection', new PeerConnection(dataConnection)));
    });
    // Losing the broker only blocks *new* players; existing links keep working.
    peer.on('disconnected', () => {
      if (!peer.destroyed) peer.reconnect();
    });
    peer.on('error', (error) => console.warn('[HostTransport]', error.type, error));
  }

  destroy() {
    this.#peer.destroy();
  }
}

function openPeer(peer) {
  return new Promise((resolve, reject) => {
    const fail = (error) => {
      peer.destroy();
      reject(error);
    };
    const timer = setTimeout(() => fail({ type: 'network' }), CONNECT_TIMEOUT_MS);
    peer.once('open', () => {
      clearTimeout(timer);
      peer.off('error', fail);
      resolve(peer);
    });
    peer.once('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
  });
}

/**
 * Connects to a host by room code.
 * @param {string} code
 * @returns {Promise<PeerConnection>}
 */
export async function connectToRoom(code) {
  const Peer = getPeerClass();
  let peer;
  try {
    peer = await openPeer(new Peer(PEER_OPTIONS));
  } catch (error) {
    throw new Error(describePeerError(error));
  }

  return new Promise((resolve, reject) => {
    const fail = (error) => {
      clearTimeout(timer);
      peer.destroy();
      reject(new Error(describePeerError(error)));
    };
    const timer = setTimeout(
      () => fail({ message: 'The server did not answer. Is the host still online?' }),
      CONNECT_TIMEOUT_MS,
    );
    peer.on('error', fail);

    const dataConnection = peer.connect(peerIdForCode(code), {
      reliable: true,
      serialization: 'raw',
    });
    dataConnection.on('open', () => {
      clearTimeout(timer);
      peer.off('error', fail);
      const connection = new PeerConnection(dataConnection);
      connection.on('close', () => peer.destroy());
      resolve(connection);
    });
  });
}
