import { AVATAR_DIR, AVATAR_LIST_URL, AVATAR_SIZE, MAX_AVATARS } from '../config.js';

/**
 * @typedef {object} Avatar
 * @property {string} id    File name, e.g. "rem_smile.png".
 * @property {string} name  Display name derived from the file name ("rem smile").
 * @property {string} url   Small square data URL, safe to send to every player.
 */

const IMAGE_FILE = /\.(png|webp|jpe?g|gif)$/i;

/**
 * Turns "rem_smile-2.png" into "rem smile 2".
 * @param {string} fileName
 * @returns {string}
 */
export function avatarName(fileName) {
  return fileName.replace(IMAGE_FILE, '').replace(/[_-]+/g, ' ').trim();
}

/**
 * Loads every image of app/avatars/ (listed by the launcher) and shrinks it to a small square,
 * so the host can send the whole catalog to players whose folder may differ.
 * Missing folder or broken images are skipped: the game works without avatars.
 * @returns {Promise<Avatar[]>}
 */
export async function loadAvatarCatalog() {
  let files;
  try {
    const response = await fetch(AVATAR_LIST_URL, { cache: 'no-store' });
    if (!response.ok) return [];
    files = await response.json();
  } catch {
    return [];
  }
  if (!Array.isArray(files)) return [];

  const images = files.filter((file) => typeof file === 'string' && IMAGE_FILE.test(file))
    .slice(0, MAX_AVATARS);
  const avatars = await Promise.all(images.map(async (file) => {
    try {
      return { id: file, name: avatarName(file), url: await shrinkImage(AVATAR_DIR + encodeURIComponent(file)) };
    } catch (error) {
      console.warn(`[avatars] skipped ${file}`, error);
      return null;
    }
  }));
  return avatars.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}

/** Center-crops an image to a square of AVATAR_SIZE px and returns it as a WebP data URL. */
async function shrinkImage(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = new OffscreenCanvas(AVATAR_SIZE, AVATAR_SIZE);
  canvas.getContext('2d').drawImage(
    bitmap,
    (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side,
    0, 0, AVATAR_SIZE, AVATAR_SIZE,
  );
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
  return `data:image/webp;base64,${toBase64(new Uint8Array(await blob.arrayBuffer()))}`;
}

function toBase64(bytes) {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
