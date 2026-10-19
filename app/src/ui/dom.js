/**
 * Tiny DOM builder. Text is always set through textContent, never parsed as HTML.
 */

/**
 * Creates an element.
 *
 *   h('button', { class: 'btn', onClick: go, disabled: true }, 'Start')
 *
 * Props: `class`, `dataset` (object), `style` (object), `on<Event>` (listener),
 * `text`, booleans (`disabled`, `hidden`…), anything else becomes an attribute.
 * Children: strings, numbers, nodes, arrays, null/false (skipped).
 * @param {string} tag
 * @param {Record<string, any>} [props]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = value;
    else if (key === 'dataset') Object.assign(element.dataset, value);
    else if (key === 'style') Object.assign(element.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) element.setAttribute(key, '');
    else element.setAttribute(key, String(value));
  }
  append(element, children);
  return element;
}

function append(element, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(element, child);
    else element.append(child instanceof Node ? child : String(child));
  }
}

/**
 * Replaces all children of an element.
 * @param {HTMLElement} element
 * @param {...any} children
 */
export function replaceChildren(element, ...children) {
  element.replaceChildren();
  append(element, children);
}

/**
 * Sets text only when it changed (avoids needless layout work in frequent updates).
 * @param {HTMLElement} element
 * @param {string | number} text
 */
export function setText(element, text) {
  const value = String(text);
  if (element.textContent !== value) element.textContent = value;
}

/**
 * Standard panel: angled frame with a header strip.
 * @param {object} options
 * @param {string} options.title
 * @param {string} [options.code]   Small mono label on the right ("02 // SYS").
 * @param {string} [options.className]
 * @param {...any} children
 * @returns {{ root: HTMLElement, body: HTMLElement }}
 */
export function panel({ title, code = '', className = '' }, ...children) {
  const body = h('div', { class: 'panel__body' }, ...children);
  const root = h('section', { class: `panel ${className}`.trim() },
    h('header', { class: 'panel__header' },
      h('span', { class: 'panel__title', text: title }),
      code && h('span', { class: 'panel__code', text: code })),
    body);
  return { root, body };
}
