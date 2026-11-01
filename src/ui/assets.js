// assets.js - the one place that turns an art id into an <img>.
//
// Every image in the UI is asked for by manifest id (assets/manifest.json): `img('board-7x7')`.
// Missing art never leaves a broken image: an unknown id, a failed manifest load or a 404 on
// the file all end in a small text chip carrying the id's label. The page is built to look
// finished with the chips, and to improve by itself when the art is there.

const BASE = 'assets/';

// Built-in id -> file table, used until (and if) assets/manifest.json loads. It mirrors the
// manifest, so the page works even if the manifest fetch fails (offline, file://, 404).
const BUILT_IN = {
  'hero-wide': 'hero/hero-wide.jpg',
  'hero-square': 'hero/hero-square.jpg',
  'board-7x7': 'board/board-7x7.jpg',
  'card-back': 'cards/card-back.jpg',
  'suit-north-face': 'cards/face-north.webp',
  'suit-east-face': 'cards/face-east.webp',
  'suit-south-face': 'cards/face-south.webp',
  'suit-west-face': 'cards/face-west.webp',
  'glyph-north': 'glyphs/glyph-north.png',
  'glyph-east': 'glyphs/glyph-east.png',
  'glyph-south': 'glyphs/glyph-south.png',
  'glyph-west': 'glyphs/glyph-west.png',
  'arrow-north': 'arrows/arrow-north.png',
  'arrow-east': 'arrows/arrow-east.png',
  'arrow-south': 'arrows/arrow-south.png',
  'arrow-west': 'arrows/arrow-west.png',
  'whale-token': 'tokens/whale-token.png',
  'role-whale': 'roles/role-whale.png',
  'role-ahab': 'roles/role-ahab.png',
  'favicon-64': 'favicon/favicon-64.png',
  'favicon-32': 'favicon/favicon-32.png',
};

const table = new Map(Object.entries(BUILT_IN).map(([id, file]) => [id, { file, w: 0, h: 0 }]));

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Reads assets/manifest.json. Never throws; on any failure the built-in table stays. */
export async function loadManifest(timeoutMs = 2500) {
  try {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    const res = await fetch(`${BASE}manifest.json`, ctl ? { signal: ctl.signal } : undefined);
    if (timer) clearTimeout(timer);
    if (!res.ok) return false;
    const list = await res.json();
    if (!Array.isArray(list)) return false;
    for (const a of list) {
      if (a && typeof a.id === 'string' && typeof a.file === 'string' && a.status !== 'missing') {
        table.set(a.id, { file: a.file, w: a.width || 0, h: a.height || 0 });
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** URL for an art id, or null if the id is unknown. */
export function assetUrl(id) {
  const a = table.get(id);
  return a ? BASE + a.file : null;
}

/** A text chip standing in for art. */
export function chip(label, cls = '') {
  return `<span class="asset-chip ${cls}" role="img" aria-label="${esc(label)}">${esc(label)}</span>`;
}

/**
 * An <img> for an art id, as an HTML string. Options: alt, cls, label (chip text if the art
 * is missing; defaults to alt or the id).
 */
export function img(id, { alt = '', cls = '', label = '' } = {}) {
  const url = assetUrl(id);
  const text = label || alt || id;
  if (!url) return chip(text, cls);
  return `<img class="${esc(cls)}" src="${url}" alt="${esc(alt)}" data-asset="${esc(id)}" data-label="${esc(text)}" decoding="async">`;
}

/**
 * Once per page: turns any <img data-asset> that fails to load into its text chip.
 * `error` does not bubble, so the listener is a capture listener on the document.
 */
export function installImageFallback(doc = document) {
  doc.addEventListener('error', (e) => {
    const el = e.target;
    if (!el || el.tagName !== 'IMG' || !el.dataset || !el.dataset.asset) return;
    const span = doc.createElement('span');
    span.className = `asset-chip ${el.className || ''}`.trim();
    span.setAttribute('role', 'img');
    span.setAttribute('aria-label', el.dataset.label || el.dataset.asset);
    span.textContent = el.dataset.label || el.dataset.asset;
    el.replaceWith(span);
  }, true);
}

/** The art id for a wind's glyph / arrow / card face. */
export const GLYPH_ID = { N: 'glyph-north', E: 'glyph-east', S: 'glyph-south', W: 'glyph-west' };
export const ARROW_ID = { N: 'arrow-north', E: 'arrow-east', S: 'arrow-south', W: 'arrow-west' };
export const FACE_ID = { N: 'suit-north-face', E: 'suit-east-face', S: 'suit-south-face', W: 'suit-west-face' };
