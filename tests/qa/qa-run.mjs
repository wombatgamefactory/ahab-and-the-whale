// qa-run.mjs - browser QA over the whole game, run from a sub-path the way GitHub Pages serves it.
//
// 1. Copies the tracked files (plus any untracked, un-ignored ones) into
//    <system temp>/ahab-and-the-whale-qa/site/ahab-and-the-whale/ and serves <temp>/site on a
//    CASE-SENSITIVE static server (a request must match a real file name exactly, like Pages).
// 2. Drives the game in headless Chromium: every bot level as each role, bot v bot, pass-and-play,
//    a full tournament, the stats screen and exports, the bug reporter, the rules dialog and PDF,
//    several widths, reduced motion, keyboard play, first-paint image weight and a case check of
//    every referenced path.
// 3. Prints PASS/FAIL per check, writes screenshots to <temp>/ahab-and-the-whale-qa/shots/ and a
//    JSON summary to <temp>/ahab-and-the-whale-qa/qa-results.json. Exit 1 if anything fails.
//
// Needs Playwright (not a dependency of this repo): found as `playwright`, in the global npm root,
// or from PLAYWRIGHT_PATH. Run: node tests/qa/qa-run.mjs [--only=<scenario substring>]

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = path.join(os.tmpdir(), 'ahab-and-the-whale-qa');
const SITE = path.join(TMP, 'site');
const SUB = 'ahab-and-the-whale';
const SHOTS = path.join(TMP, 'shots');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);

async function loadPlaywright() {
  const tries = [() => import('playwright')];
  const dirs = [process.env.PLAYWRIGHT_PATH];
  try { dirs.push(path.join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright')); } catch { /* none */ }
  for (const d of dirs.filter(Boolean)) tries.push(() => import(pathToFileURL(path.join(d, 'index.mjs')).href));
  for (const t of tries) {
    try { const m = await t(); return m.chromium || (m.default && m.default.chromium); } catch { /* next */ }
  }
  return null;
}
const chromium = await loadPlaywright();
if (!chromium) { console.log('qa-run: Playwright not found'); process.exit(1); }

// ---------- the sub-path copy of the site ----------
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean);
const tracked = git('ls-files');
const untracked = git('ls-files', '-o', '--exclude-standard');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });
const served = new Set(); // exact-case relative paths under SITE
for (const f of [...tracked, ...untracked]) {
  const src = path.join(ROOT, f);
  if (!fs.existsSync(src)) continue; // tracked but deleted in the working tree
  const dst = path.join(SITE, SUB, f);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  served.add(`${SUB}/${f}`);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf', '.md': 'text/markdown' };
const requestLog = []; // { url, status }
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (rel.endsWith('/')) rel += 'index.html';
  if (!served.has(rel) && served.has(`${rel}/index.html`)) rel += '/index.html';
  const ok = served.has(rel);
  requestLog.push({ url: url.pathname, status: ok ? 200 : 404 });
  if (!ok) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(rel)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(path.join(SITE, rel)).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const BASE = `${ORIGIN}/${SUB}/`;

// ---------- result bookkeeping ----------
const results = []; // { scenario, name, pass, detail, shots }
let current = null;
const shotsByScenario = new Map();
function check(name, cond, detail = '') {
  const pass = !!cond;
  results.push({ scenario: current, name, pass, detail: String(detail || '') });
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}${detail && !pass ? ` -- ${detail}` : ''}`);
  return pass;
}
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
async function shot(page, name, opts = {}) {
  const file = path.join(SHOTS, `${slug(current || 'qa')}--${slug(name)}.png`);
  try { await page.screenshot({ path: file, ...opts }); } catch (e) { console.log(`  (screenshot failed: ${e.message})`); return null; }
  if (!shotsByScenario.has(current)) shotsByScenario.set(current, []);
  shotsByScenario.get(current).push(file);
  return file;
}
async function scenario(name, fn) {
  if (ONLY && !name.toLowerCase().includes(ONLY.toLowerCase())) return;
  current = name;
  console.log(`\n== ${name}`);
  const t0 = Date.now();
  try { await fn(); } catch (e) { check('scenario ran without throwing', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e); }
  console.log(`   (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

// ---------- browser plumbing ----------
const browser = await chromium.launch();
const problems = []; // console errors/warnings, page errors, failed requests, HTTP >= 400
const imageBytes = new Map(); // scenario -> bytes
const FONT_HOSTS = /fonts\.(googleapis|gstatic)\.com/;
async function newPage(w = 1440, h = 900, opts = {}, init = null) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, acceptDownloads: true, ...opts });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const tag = `[${current} @${w}]`;
  page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !FONT_HOSTS.test(m.text())) problems.push(`${tag} console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`${tag} pageerror: ${e.message}`));
  page.on('requestfailed', (r) => { if (!FONT_HOSTS.test(r.url())) problems.push(`${tag} request failed: ${r.url()}`); });
  page.on('response', (r) => {
    if (r.status() >= 400 && !FONT_HOSTS.test(r.url())) problems.push(`${tag} HTTP ${r.status()} ${r.url()}`);
  });
  return page;
}
const touchOpts = (w) => (w < 700 ? { hasTouch: true, isMobile: true } : {});

async function setup(page, { t0 = 'human', t1 = 'easy', r0 = 'random', r1 = 'random', mode = 'single', q = 'seed=11', delay = 40 } = {}) {
  await page.goto(`${BASE}?botdelay=${delay}&${q}`);
  await page.waitForSelector('#setup-form');
  await page.selectOption('select[name=type0]', t0);
  await page.selectOption('select[name=type1]', t1);
  await page.selectOption('select[name=role0]', r0);
  await page.selectOption('select[name=role1]', r1);
  await page.check(`input[name=mode][value=${mode}]`);
  await page.click('button[type=submit]');
}

/** Plays every human turn (cycling through the legal cards) until an end panel shows. */
async function playHuman(page, { maxMs = 150000, pick = 0 } = {}) {
  // Phone-width pages run as touch devices (isMobile). A full-page screenshot resets Chromium's touch
  // emulation, so the media query is unreliable here: decide from the viewport instead.
  const touch = page.viewportSize().width < 700;
  const st = { plays: 0, covers: 0, illegalTried: 0, illegalMatch: true };
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await page.locator('.end').count()) break;
    if (await page.locator('.cover').count()) { st.covers++; await page.click('.cover .btn--primary'); continue; }
    const legal = page.locator('.hand .card.is-legal');
    const n = await legal.count();
    if (n) {
      const blocked = page.locator('.hand .card.is-blocked');
      if (st.illegalTried < 2 && await blocked.count()) {
        st.illegalTried++;
        const title = await blocked.first().getAttribute('title');
        await blocked.first().click({ force: true }); // aria-disabled cards stay clickable so the click can explain itself
        if (!title || title !== (await page.textContent('#note'))) st.illegalMatch = false;
      }
      const before = await page.locator('.log__item').count();
      const target = legal.nth((pick + st.plays) % n);
      if (touch) { // a real tap: the first tap previews, the second plays
        await target.tap();
        if (await page.locator('.hand .card.is-selected').count()) await page.locator('.hand .card.is-selected').first().tap();
      } else await target.click();
      st.plays++;
      if (st.plays > 60) { st.stuck = await page.evaluate(() => ({ cards: document.querySelectorAll('.hand .card').length, legal: document.querySelectorAll('.hand .card.is-legal').length, selected: document.querySelectorAll('.is-selected').length, log: document.querySelectorAll('.log__item').length, note: document.getElementById('note') && document.getElementById('note').textContent })); break; }
      // wait for the card to land (the log grows when a trick completes; a lead just waits a beat)
      await page.waitForTimeout(30);
      void before;
    } else await page.waitForTimeout(40);
  }
  return st;
}

async function waitEnd(page, ms = 90000) { await page.waitForSelector('.end', { timeout: ms }); }

// ---------- in-page audits ----------
const AUDIT = () => {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const out = { hscroll: document.documentElement.scrollWidth - vw, vscroll: document.documentElement.scrollHeight - vh, clipped: [], off: [], vw, vh };
  const name = (el) => `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? `.${el.className.trim().split(/\s+/).join('.')}` : ''}`;
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('.sr-only') || el.closest('.hand .card')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (['hidden', 'clip'].includes(cs.overflowX) && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) out.clipped.push(`${name(el)} (${el.scrollWidth}>${el.clientWidth})`);
    if (cs.position !== 'fixed' && !el.closest('.overlay, .cover') && (r.right > vw + 1 || r.left < -1)) out.off.push(`${name(el)} [${Math.round(r.left)},${Math.round(r.right)}]`);
  }
  return out;
};
async function audit(page, label, { allowVScroll = true } = {}) {
  const a = await page.evaluate(AUDIT);
  check(`${label}: no horizontal scroll`, a.hscroll <= 0, `scrollWidth - clientWidth = ${a.hscroll}`);
  check(`${label}: nothing outside the viewport horizontally`, a.off.length === 0, a.off.slice(0, 4).join('; '));
  check(`${label}: no clipped text (overflow hidden with hidden content)`, a.clipped.length === 0, a.clipped.slice(0, 4).join('; '));
  if (!allowVScroll) check(`${label}: fits the viewport height without page scroll`, a.vscroll <= 0, `scrollHeight - clientHeight = ${a.vscroll}`);
  return a;
}

/** Rectangles of the game's regions must not overlap one another (1 px tolerance). */
async function regionOverlaps(page) {
  return page.evaluate(() => {
    const sels = ['.g-board .board', '.legend', '.g-status', '.g-opp', '.g-trick', '.g-me > .seat', '.g-log', '.handbox'];
    const rects = sels.map((s) => [s, document.querySelector(s)]).filter(([, e]) => e).map(([s, e]) => [s, e.getBoundingClientRect()]);
    const bad = [];
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i][1]; const b = rects[j][1];
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) bad.push(`${rects[i][0]} x ${rects[j][0]}`);
    }
    return bad;
  });
}

const CONTRAST = () => {
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const blend = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
  const bgOf = (el) => {
    const stack = [];
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage !== 'none') return null; // art behind: cannot judge
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) { stack.push(c); if (c.a >= 0.99) break; }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (const c of stack.reverse()) base = blend(c, base);
    return base;
  };
  const seen = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const t = walker.currentNode;
    if (!t.nodeValue.trim()) continue;
    const el = t.parentElement;
    if (!el || el.closest('.sr-only, .hand .card, script, style')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    let op = 1; for (let e = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
    if (op < 0.99) continue;
    const fg = parse(cs.color); const bg = bgOf(el);
    if (!fg || !bg) continue;
    const f = blend(fg, bg);
    const L1 = lum(f); const L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const size = parseFloat(cs.fontSize); const bold = Number(cs.fontWeight) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    const need = large ? 3 : 4.5;
    if (ratio < need) {
      const key = `${el.tagName.toLowerCase()}.${(el.className || '').toString().trim().split(/\s+/)[0]} ${cs.color} on ${cs.backgroundColor}`;
      if (!seen.has(key)) seen.set(key, { ratio: Math.round(ratio * 100) / 100, need, text: t.nodeValue.trim().slice(0, 40) });
    }
  }
  return [...seen.entries()].map(([k, v]) => `${k}: ${v.ratio}:1 (need ${v.need}) "${v.text}"`);
};

const SIZES_ONLY = (process.argv.find((a) => a.startsWith('--widths=')) || '').slice(9).split(',').filter(Boolean).map(Number);
const SCREENS = [
  { w: 1440, h: 900 }, { w: 1280, h: 800 }, { w: 1024, h: 768 }, { w: 768, h: 1024 }, { w: 390, h: 844 }, { w: 360, h: 740 },
].filter((s) => !SIZES_ONLY.length || SIZES_ONLY.includes(s.w));

// =====================================================================================
await scenario('Static check: referenced paths match file names exactly (Pages is case-sensitive)', async () => {
  const exact = new Set(tracked);
  const lower = new Map(tracked.map((f) => [f.toLowerCase(), f]));
  const bad = [];
  let refs = 0;
  const verify = (from, ref) => {
    if (/^(https?:|data:|mailto:|#|\/\/)/.test(ref)) return;
    const clean = ref.split('#')[0].split('?')[0];
    if (!clean) return;
    const resolved = path.posix.normalize(clean.startsWith('/') ? clean.slice(1) : path.posix.join(path.posix.dirname(from), clean));
    refs++;
    if (exact.has(resolved)) return;
    bad.push(`${from} -> ${ref}${lower.has(resolved.toLowerCase()) ? ` (case differs: ${lower.get(resolved.toLowerCase())})` : ' (no such file)'}`);
  };
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  for (const m of read('index.html').matchAll(/\b(?:src|href)="([^"]+)"/g)) verify('index.html', m[1]);
  for (const m of read('style.css').matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) verify('style.css', m[1]);
  for (const f of tracked.filter((t) => /^src\/.*\.js$/.test(t))) {
    const text = read(f);
    for (const m of text.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)) verify(f, m[1]);
    for (const m of text.matchAll(/\bimport\(\s*['"](\.[^'"]+)['"]/g)) verify(f, m[1]);
    for (const m of text.matchAll(/new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url/g)) verify(f, m[1]);
    for (const m of text.matchAll(/new Worker\(\s*['"]([^'"]+)['"]/g)) verify(f, m[1]);
    for (const m of text.matchAll(/['"`]((?:assets|rules)\/[^'"`$]+\.[a-z0-9]+)['"`]/gi)) verify('index.html', m[1]); // page-relative strings
    if (f === 'src/ui/assets.js') for (const m of text.matchAll(/:\s*'([a-z]+\/[a-z0-9-]+\.[a-z]+)'/g)) verify('assets/x', m[1]);
  }
  let manifestAbs = 0;
  const manifest = JSON.parse(read('assets/manifest.json'));
  for (const a of manifest) {
    if (/^([a-z]:|[\\/])/i.test(a.file) || /[a-z]:\\/i.test(JSON.stringify(a))) manifestAbs++;
    verify('assets/manifest.json', a.file);
  }
  check(`${refs} references checked, every one an exact-case match for a tracked file`, bad.length === 0, bad.slice(0, 6).join('; '));
  check('assets/manifest.json has no absolute or Windows paths', manifestAbs === 0, `${manifestAbs} entries`);
  const upper = tracked.filter((f) => /[A-Z]/.test(f));
  check('tracked file names are lowercase (nothing relies on case)', upper.length === 0, upper.slice(0, 5).join(', '));
});

await scenario('Landing page from the sub-path: first paint weight, links, social tags', async () => {
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const page = await newPage(w, h, touchOpts(w));
    let bytes = 0; const imgs = [];
    page.on('response', async (r) => {
      if (r.request().resourceType() === 'image') { try { const b = (await r.body()).length; bytes += b; imgs.push(`${path.basename(new URL(r.url()).pathname)} ${Math.round(b / 1024)}KB`); } catch { /* aborted */ } }
    });
    await page.goto(`${BASE}`, { waitUntil: 'load' });
    await page.waitForSelector('#setup-form');
    await page.waitForLoadState('networkidle');
    imageBytes.set(`landing-${w}`, bytes);
    check(`first paint at ${w}px loads under 2 MB of images (${(bytes / 1048576).toFixed(2)} MB: ${imgs.join(', ')})`, bytes < 2 * 1048576, `${bytes} bytes`);
    if (w === 1440) {
      check('title and hook render', (await page.title()) === 'Ahab and the Whale' && /wind that blows/.test(await page.textContent('.hero__hook')));
      const og = await page.$eval('meta[property="og:image"]', (m) => m.content);
      const ogu = await page.$eval('meta[property="og:url"]', (m) => m.content);
      check('og:image and og:url are absolute URLs under https://www.wombatgamefactory.com/ahab-and-the-whale/', og.startsWith(`https://www.wombatgamefactory.com/${SUB}/`) && ogu === `https://www.wombatgamefactory.com/${SUB}/`, `${og} | ${ogu}`);
      const ogPath = og.replace(`https://www.wombatgamefactory.com/${SUB}/`, '');
      check('og:image path exists as a published file', served.has(`${SUB}/${ogPath}`), ogPath);
      const tw = await page.$eval('meta[name="twitter:image"]', (m) => m.content);
      check('twitter:image is absolute', tw.startsWith(`https://www.wombatgamefactory.com/${SUB}/`), tw);
      const href = await page.getAttribute('a[data-action=rulebook]', 'href');
      const r = await page.request.get(new URL(href, BASE).href);
      const body = await r.body();
      check(`rule book PDF link (${href}) answers 200 application/pdf from the sub-path`, r.status() === 200 && /pdf/.test(r.headers()['content-type'] || '') && body.slice(0, 4).toString() === '%PDF', `${r.status()} ${r.headers()['content-type']}`);
      const man = await page.request.get(`${BASE}assets/manifest.json`);
      check('assets/manifest.json served', man.status() === 200);
      check('root of the origin is not the game (so every path in the page is relative to the sub-path)', (await page.request.get(`${ORIGIN}/`)).status() === 404);
      check('hero image loaded', await page.$eval('.hero__art img', (i) => i.complete && i.naturalWidth > 100));
      await shot(page, 'landing-1440', { fullPage: true });
    }
    await page.close();
  }
});

await scenario('Responsive: landing page at every width', async () => {
  for (const { w, h } of SCREENS) {
    const page = await newPage(w, h, touchOpts(w));
    await page.goto(`${BASE}?seed=1`);
    await page.waitForSelector('#setup-form');
    await audit(page, `landing ${w}px`);
    await shot(page, `landing-${w}`, { fullPage: true });
    await page.close();
  }
});

await scenario('Game screen layout: 1440x900 and 1280x800 fit without page scroll', async () => {
  for (const { w, h } of [{ w: 1440, h: 900 }, { w: 1280, h: 800 }, { w: 1920, h: 1080 }, { w: 1366, h: 768 }]) {
    const page = await newPage(w, h);
    await setup(page, { t1: 'medium', q: 'seed=11' });
    await page.waitForSelector('.hand .card');
    await page.waitForTimeout(300);
    const a = await audit(page, `game ${w}x${h} (trick 1)`, { allowVScroll: h >= 800 ? false : true });
    void a;
    const geo = await page.evaluate(() => {
      const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height }; };
      const cards = [...document.querySelectorAll('.hand .card')].map((c) => c.getBoundingClientRect());
      return { board: r('.g-board .board'), status: r('.status__trick'), hand: r('.handbox'), handCards: cards.map((c) => ({ l: c.left, r: c.right, t: c.top, b: c.bottom, w: c.width })), vh: innerHeight, side: r('.col--side') };
    });
    if (h >= 800) {
      check(`game ${w}x${h}: board top is on screen`, geo.board.top >= 0, `top ${geo.board.top}`);
      check(`game ${w}x${h}: trick counter is on screen`, geo.status.top >= 0 && geo.status.bottom <= geo.vh, `${geo.status.top}`);
      check(`game ${w}x${h}: hand box bottom is on screen`, geo.hand.bottom <= geo.vh + 0.5, `${geo.hand.bottom} vs ${geo.vh}`);
      check(`game ${w}x${h}: board is large (>= ${h >= 900 ? 520 : 420}px square)`, geo.board.width >= (h >= 900 ? 520 : 420), `${Math.round(geo.board.width)}px`);
    }
    check(`game ${w}x${h}: board stays above the hand (no overlap)`, geo.board.bottom <= geo.hand.top + 0.5, `${geo.board.bottom} vs ${geo.hand.top}`);
    const overlaps = await regionOverlaps(page);
    check(`game ${w}x${h}: no regions overlap`, overlaps.length === 0, overlaps.join(', '));
    // hand spread: step between consecutive cards vs card width
    const step = geo.handCards.slice(1).map((c, i) => c.l - geo.handCards[i].l);
    const minStep = Math.min(...step); const cw = geo.handCards[0].w;
    const overlapPct = Math.max(0, Math.round((1 - minStep / cw) * 100));
    if (w >= 1280) check(`game ${w}x${h}: 12 cards are fanned without overlap when the width allows (card ${Math.round(cw)}px, step >= card width)`, minStep >= cw - 0.5, `min step ${Math.round(minStep)} vs card ${Math.round(cw)}`);
    else check(`game ${w}x${h}: cards overlap by at most 45%`, overlapPct <= 45, `${overlapPct}%`);
    check(`game ${w}x${h}: all 12 hand cards inside the hand box`, geo.handCards.every((c) => c.l >= geo.hand.left - 0.5 && c.r <= geo.hand.right + 0.5), '');
    // whale on its cell
    const wh = await page.evaluate(() => {
      const g = document.querySelector('.board:not(.board--mini) .board__grid').getBoundingClientRect();
      const t = document.querySelector('.board:not(.board--mini) .whale'); const b = t.getBoundingClientRect();
      const x = Number(t.dataset.x); const y = Number(t.dataset.y); const cell = g.width / 7;
      return { dx: b.left + b.width / 2 - (g.left + (x + 0.5) * cell), dy: b.top + b.height / 2 - (g.top + (y + 0.5) * cell), cell, gridW: g.width, gridH: g.height };
    });
    check(`game ${w}x${h}: whale token centred on its cell (within 2 px)`, Math.abs(wh.dx) < 2 && Math.abs(wh.dy) < 2 && Math.abs(wh.gridW - wh.gridH) < 1, `dx ${wh.dx.toFixed(1)} dy ${wh.dy.toFixed(1)}`);
    await shot(page, `game-${w}x${h}-trick1`);
    // hover a leading card: ghosts + preview text
    const legal = page.locator('.hand .card.is-legal');
    await legal.nth(2).hover();
    await page.waitForTimeout(250);
    const ghostOk = await page.evaluate(() => {
      const g = document.querySelector('.board:not(.board--mini) .board__grid').getBoundingClientRect(); const cell = g.width / 7;
      return [...document.querySelectorAll('.ghost')].map((e) => { const b = e.getBoundingClientRect(); return { cx: (b.left + b.width / 2 - g.left) / cell, cy: (b.top + b.height / 2 - g.top) / cell }; });
    });
    check(`game ${w}x${h}: preview ghosts sit in the middle of grid cells`, ghostOk.length > 0 && ghostOk.every((p) => Math.abs((p.cx % 1) - 0.5) < 0.06 && Math.abs((p.cy % 1) - 0.5) < 0.06), JSON.stringify(ghostOk));
    const a2 = await page.evaluate(AUDIT);
    if (h >= 800) check(`game ${w}x${h}: still fits with the long preview line showing`, a2.vscroll <= 0, `vscroll ${a2.vscroll}`);
    await shot(page, `game-${w}x${h}-preview`);
    // play a card, then provoke a refusal note on the follow
    await legal.nth(2).click();
    await page.waitForFunction(() => document.querySelectorAll('.log__item').length >= 1, null, { timeout: 15000 });
    await page.mouse.move(5, 5);
    const blocked = page.locator('.hand .card.is-blocked');
    if (await blocked.count()) {
      await blocked.first().click({ force: true });
      await page.waitForTimeout(100);
      const a3 = await page.evaluate(AUDIT);
      if (h >= 800) check(`game ${w}x${h}: still fits with a refusal note showing`, a3.vscroll <= 0, `vscroll ${a3.vscroll}`);
      check(`game ${w}x${h}: refusal note is displayed`, (await page.textContent('#note')).length > 10);
      await shot(page, `game-${w}x${h}-refusal`);
    }
    await page.close();
  }
});

await scenario('Tournament screen layout (extra scoreboard) at desktop sizes', async () => {
  for (const { w, h } of [{ w: 1440, h: 900 }, { w: 1280, h: 800 }]) {
    const page = await newPage(w, h);
    await setup(page, { mode: 'tournament', t1: 'easy', q: 'seed=21' });
    await page.waitForSelector('.hand .card');
    await page.locator('.hand .card.is-legal').first().click();
    await page.waitForFunction(() => document.querySelectorAll('.log__item').length >= 1, null, { timeout: 15000 });
    await page.mouse.move(5, 5);
    await page.waitForTimeout(300);
    await audit(page, `tournament game ${w}x${h}`, { allowVScroll: false });
    const geo = await page.evaluate(() => ({ hand: document.querySelector('.handbox').getBoundingClientRect().bottom, vh: innerHeight, log: document.querySelector('.g-log').getBoundingClientRect().height, side: document.querySelector('.g-me > .seat').getBoundingClientRect().bottom, handTop: document.querySelector('.handbox').getBoundingClientRect().top }));
    check(`tournament ${w}x${h}: side column ends above the hand`, geo.side <= geo.handTop + 0.5, `${geo.side} vs ${geo.handTop}`);
    check(`tournament ${w}x${h}: trick log keeps room for at least two lines (${Math.round(geo.log)} px)`, geo.log >= 70, `${geo.log}`);
    const overlaps = await regionOverlaps(page);
    check(`tournament ${w}x${h}: no regions overlap`, overlaps.length === 0, overlaps.join(', '));
    await shot(page, `tournament-${w}x${h}`);
    await page.close();
  }
});

// ---------- full games ----------
for (const level of ['easy', 'medium', 'hard']) {
  for (const role of ['ahab', 'whale']) {
    await scenario(`Human v ${level} bot, human plays ${role}, to the end`, async () => {
      const page = await newPage(1440, 900);
      await setup(page, { t0: 'human', t1: level, r0: role, r1: 'random', q: `seed=${level === 'easy' ? 3 : level === 'medium' ? 4 : 5}` });
      await page.waitForSelector('.hand .card');
      const roleLabel = await page.textContent('.g-me .seat__role b');
      check(`human got the ${role} role`, roleLabel.trim().toLowerCase() === (role === 'ahab' ? 'ahab' : 'whale'), roleLabel);
      await shot(page, 'start');
      await page.evaluate(() => { window.__gap = 0; let last = performance.now(); setInterval(() => { const n = performance.now(); window.__gap = Math.max(window.__gap, n - last); last = n; }, 16); });
      const s = await playHuman(page);
      check('12 human plays and the end panel appears', s.plays === 12 && (await page.locator('.end').count()) === 1, `${s.plays} plays`);
      check('illegal cards explain themselves (tooltip equals the click message)', s.illegalTried === 0 || s.illegalMatch, `${s.illegalTried} tried`);
      check('trick log has 12 lines (end panel up)', (await page.locator('.log__item').count()) === 12);
      const head = await page.textContent('.end h2');
      check(`end panel names a winner ("${head}") and shows a final board and seat badges`, /win/i.test(head) && (await page.locator('.end .board').count()) === 1 && (await page.locator('.end .badge').count()) >= 2);
      const endOk = await page.evaluate(() => {
        const wh = document.querySelector('.end .board .whale'); const g = document.querySelector('.end .board .board__grid').getBoundingClientRect(); const b = wh.getBoundingClientRect();
        const x = Number(wh.dataset.x); const y = Number(wh.dataset.y); const cell = g.width / 7;
        return { dx: b.left + b.width / 2 - (g.left + (x + 0.5) * cell), dy: b.top + b.height / 2 - (g.top + (y + 0.5) * cell), open: wh.classList.contains('whale--open'), x, y };
      });
      check('end panel: mini-board whale centred on its cell', Math.abs(endOk.dx) < 2 && Math.abs(endOk.dy) < 2, JSON.stringify(endOk));
      const outer = endOk.x === 0 || endOk.y === 0 || endOk.x === 6 || endOk.y === 6;
      const winnerText = await page.textContent('.end .end__line');
      check('end panel verdict agrees with the whale position (outer ring = Whale wins)', outer === /Whale wins/.test(winnerText), `${winnerText} at ${endOk.x},${endOk.y}`);
      if (level === 'hard') {
        const gap = await page.evaluate(() => window.__gap);
        check(`Hard bot: main thread never stalled (longest gap ${Math.round(gap)} ms < 250)`, gap < 250);
        check('Hard bot: decisions came from a Web Worker', (await page.evaluate(() => document.body.dataset.botMode)) === 'worker');
      }
      await shot(page, 'end-panel');
      await audit(page, 'end panel 1440');
      await page.click('.end [data-action=review]');
      await page.waitForSelector('.endbar');
      await page.waitForTimeout(200);
      await audit(page, 'end bar after "Look at the board" 1440x900', { allowVScroll: false });
      const ov = await regionOverlaps(page);
      check('end bar state: no regions overlap', ov.length === 0, ov.join(', '));
      await shot(page, 'review-after-end');
      await page.click('.endbar [data-action=again]');
      await page.waitForSelector('.hand .card');
      check('Play again deals a fresh game', (await page.locator('.hand .card').count()) === 12 && (await page.locator('.log__item').count()) === 0);
      await page.close();
    });
  }
}

await scenario('Bot v bot (Hard v Medium, Easy v Easy), no human', async () => {
  for (const [a, b, seed] of [['hard', 'medium', 3], ['easy', 'easy', 6]]) {
    const page = await newPage(1280, 800);
    await setup(page, { t0: a, t1: b, q: `seed=${seed}`, delay: 20 });
    await page.waitForSelector('.board');
    await page.waitForTimeout(400);
    check(`${a} v ${b}: no hand is shown, both seats show card backs`, (await page.locator('.hand .card').count()) === 0 && (await page.locator('.seat__backs').count()) === 2);
    await shot(page, `${a}-v-${b}-midgame`);
    await waitEnd(page);
    check(`${a} v ${b}: finishes by itself with a result panel`, (await page.locator('.end h2').count()) === 1 && (await page.locator('.log__item').count()) === 12, await page.textContent('.end h2'));
    await shot(page, `${a}-v-${b}-end`);
    await page.close();
  }
});

await scenario('Pass-and-play: the hand is never visible under the cover', async () => {
  for (const { w, h } of [{ w: 1440, h: 900 }, { w: 390, h: 844 }]) {
    const page = await newPage(w, h, touchOpts(w));
    await page.addInitScript(() => {
      window.__leaks = 0; window.__covers = 0;
      new MutationObserver(() => {
        const cover = document.querySelector('.cover');
        if (cover) { window.__covers++; if (document.querySelector('[data-card], .hand, .board, .log__list, .card')) window.__leaks++; }
      }).observe(document, { subtree: true, childList: true, attributes: true });
    });
    await setup(page, { t0: 'human', t1: 'human', r0: 'ahab', r1: 'whale', q: 'seed=2' });
    await page.waitForSelector('.cover');
    check(`pass-and-play ${w}: the first screen is a cover with no cards, board or log in the DOM`, (await page.locator('[data-card], .hand, .board, .log__list, .card').count()) === 0);
    const cov = await page.evaluate(() => { const r = document.querySelector('.cover').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height, z: getComputedStyle(document.querySelector('.cover')).zIndex, text: document.body.innerText }; });
    check(`pass-and-play ${w}: the cover fills the whole viewport`, cov.l <= 0 && cov.t <= 0 && cov.w >= w - 1 && cov.h >= h - 1, JSON.stringify(cov));
    check(`pass-and-play ${w}: the cover names the next player and role`, /Pass to Player \d \((Ahab|Whale)\)/.test(cov.text), cov.text.slice(0, 80));
    await shot(page, `cover-${w}`);
    await audit(page, `cover ${w}`);
    if (w === 1440) {
      await page.click('.cover [data-action=open-rules]');
      await page.waitForSelector('.dialog');
      check('rules dialog opens over the cover without exposing cards', (await page.locator('[data-card]').count()) === 0);
      await page.keyboard.press('Escape');
    }
    const s = await playHuman(page);
    const leaks = await page.evaluate(() => window.__leaks);
    const covers = await page.evaluate(() => window.__covers);
    check(`pass-and-play ${w}: 24 plays with a cover between players`, s.plays === 24 && s.covers >= 6, `${s.plays} plays, ${s.covers} covers`);
    check(`pass-and-play ${w}: a MutationObserver saw ${covers} cover mutations and never a card, hand or board behind one`, leaks === 0 && covers > 0, `${leaks} leaks`);
    await shot(page, `end-${w}`);
    await page.close();
  }
  // the revealed hand shows only my cards: the opponent is card backs only
  const page = await newPage(1440, 900);
  await setup(page, { t0: 'human', t1: 'human', r0: 'ahab', r1: 'whale', q: 'seed=2' });
  await page.click('.cover .btn--primary');
  await page.waitForSelector('.hand .card');
  check('after revealing: only one hand in the DOM (12 cards), the other seat shows backs', (await page.locator('.hand .card').count()) === 12 && (await page.locator('.g-opp .seat__back').count()) === 12);
  await shot(page, 'revealed-hand');
  await page.close();
});

await scenario('Tournament: full first-to-3 with role swaps and the tournament-over screen', async () => {
  const page = await newPage(1440, 900);
  await setup(page, { t0: 'human', t1: 'easy', r0: 'ahab', mode: 'tournament', q: 'seed=21' });
  await page.waitForSelector('.hand .card');
  const rolesSeen = []; let games = 0; let boardAlways = true; const gameEnds = [];
  for (;;) {
    rolesSeen.push((await page.locator('.g-score .score__seat small').allTextContents()).join('|'));
    const s = await playHuman(page);
    boardAlways = boardAlways && (await page.locator('.g-score').count()) === 1 && s.plays === 12;
    games++;
    gameEnds.push(await page.textContent('.end h2'));
    if (games === 1) await shot(page, 'game-1-over');
    const next = page.locator('.end [data-action=next-game]');
    if (await next.count()) { await next.click(); await page.waitForSelector('.hand .card'); } else break;
  }
  const title = await page.textContent('.end h2');
  check(`ends with a tournament-over panel ("${title}")`, /tournament/i.test(title));
  check(`3 to 5 games played (${games})`, games >= 3 && games <= 5);
  check('roles swap every game', rolesSeen.every((r, i) => i === 0 || r !== rolesSeen[i - 1]) && rolesSeen[0] === 'Ahab this game|Whale this game', rolesSeen.join(' / '));
  check('scoreboard stays visible and every game had 12 human plays', boardAlways);
  check('someone has three win pips on the tournament-over panel', (await page.locator('.end .score .pip--won').count()) >= 3);
  check('tournament-over panel lists every game', (await page.locator('.end__history li').count()) === games, `${await page.locator('.end__history li').count()} vs ${games}`);
  await shot(page, 'tournament-over');
  await audit(page, 'tournament-over 1440');
  await page.close();
  const small = await newPage(390, 844, touchOpts(390));
  await setup(small, { t0: 'easy', t1: 'easy', mode: 'tournament', q: 'seed=7', delay: 0 });
  for (let i = 0; i < 6; i++) {
    await small.waitForSelector('.end', { timeout: 60000 });
    if (/tournament/i.test(await small.textContent('.end h2'))) break;
    await small.click('.end [data-action=next-game]');
  }
  await audit(small, 'tournament-over 390');
  await shot(small, 'tournament-over-390', { fullPage: true });
  await small.close();
});

await scenario('Stats screen, CSV and JSON exports, Clear', async () => {
  const page = await newPage(1280, 900);
  await page.goto(`${BASE}?botdelay=0`);
  await page.waitForSelector('#setup-form');
  await page.click('[data-action=open-stats]');
  await page.waitForSelector('.dialog .st');
  check('empty state before any game', /No games recorded yet/.test(await page.textContent('.dialog .st')));
  check('export buttons are disabled when empty', await page.$eval('[data-action=export-csv]', (b) => b.disabled) && await page.$eval('[data-action=export-json]', (b) => b.disabled));
  await shot(page, 'stats-empty');
  await page.keyboard.press('Escape');
  for (const [a, b, mode] of [['easy', 'medium', 'single'], ['hard', 'easy', 'single'], ['medium', 'medium', 'tournament']]) {
    await page.selectOption('select[name=type0]', a); await page.selectOption('select[name=type1]', b);
    await page.check(`input[name=mode][value=${mode}]`);
    await page.click('button[type=submit]');
    for (let g = 0; g < 8; g++) {
      await page.waitForSelector('.end', { timeout: 60000 });
      if (mode === 'single' || /tournament/i.test(await page.textContent('.end h2'))) break;
      await page.click('.end [data-action=next-game]');
    }
    await page.click('.end [data-action=new]');
    await page.waitForSelector('#setup-form');
  }
  await page.click('[data-action=open-stats]');
  await page.waitForSelector('.dialog .st__table');
  const games = await page.evaluate(() => JSON.parse(localStorage.getItem('ahab-stats-v1')).games.length);
  check(`stats list the games played (${games} stored, 2 singles + a tournament of 3 to 5)`, games >= 5 && games <= 7);
  check('lead line, matchup table, 7x7 heatmap and tournament summary are present', (await page.locator('.st__lead').count()) === 1 && (await page.locator('.st__table').count()) >= 2 && (await page.locator('.heat__cell').count()) === 49 && /Tournaments\s*1 finished/.test(await page.textContent('.dialog .st')));
  await shot(page, 'stats-filled');
  await audit(page, 'stats dialog 1280');
  const [csvDl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action=export-csv]')]);
  const csv = fs.readFileSync(await csvDl.path(), 'utf8');
  const lines = csv.trim().split('\n');
  check(`CSV export: dated name (${csvDl.suggestedFilename()}), header plus one row per game, LF line endings`, /^ahab-stats-\d{4}-\d{2}-\d{2}\.csv$/.test(csvDl.suggestedFilename()) && lines.length === games + 1 && !csv.includes('\r'), `${lines.length} lines`);
  check('CSV rows have the same column count as the header', lines.every((l) => l.split(',').length === lines[0].split(',').length));
  const [jsDl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action=export-json]')]);
  let parsed = null;
  try { parsed = JSON.parse(fs.readFileSync(await jsDl.path(), 'utf8')); } catch { /* reported below */ }
  check(`JSON export is valid JSON (${jsDl.suggestedFilename()}) with every game and the tournament`, parsed && parsed.games.length === games && parsed.tournaments.length === 1);
  page.once('dialog', (d) => d.dismiss());
  await page.click('[data-action=clear-stats]');
  check('Clear: dismissing the confirm keeps the data', (await page.locator('.dialog .st__table').count()) > 0);
  page.once('dialog', (d) => d.accept());
  await page.click('[data-action=clear-stats]');
  await page.waitForSelector('.st__empty');
  check('Clear: accepting empties the store and the screen', (await page.evaluate(() => localStorage.getItem('ahab-stats-v1'))) === null);
  await shot(page, 'stats-after-clear');
  await page.close();
});

await scenario('Bug reporter: button and Ctrl+Shift+B download valid JSON', async () => {
  const page = await newPage(1440, 900, { permissions: [] });
  await setup(page, { t0: 'human', t1: 'easy', q: 'seed=11' });
  await page.waitForSelector('.hand .card.is-legal');
  check('bug button is on the page (landing and game)', (await page.locator('body > #bug-button').count()) === 1);
  await page.locator('.hand .card.is-legal').first().click();
  await page.waitForSelector('.hand .card.is-legal');
  if (await page.locator('.hand .card.is-blocked').count()) await page.locator('.hand .card.is-blocked').first().click({ force: true });
  check('bug button survives re-renders', (await page.locator('body > #bug-button').count()) === 1);
  // by button
  await page.click('#bug-button');
  await page.waitForSelector('#bug-form');
  await page.fill('#bug-form [name=title]', 'QA run: by button');
  await page.fill('#bug-form [name=happened]', 'checking');
  await shot(page, 'bug-modal');
  await audit(page, 'bug modal 1440');
  const [d1] = await Promise.all([page.waitForEvent('download'), page.click('#bug-form button[type=submit]')]);
  let r1 = null; try { r1 = JSON.parse(fs.readFileSync(await d1.path(), 'utf8')); } catch { /* below */ }
  check(`button: valid JSON report (${d1.suggestedFilename()}) with state, diagnostics and an action log`, r1 && r1.schemaVersion === 1 && r1.game && r1.diagnostics && r1.actionLog.length >= 2);
  check('button: no "error" keys anywhere in the report sections', r1 && !JSON.stringify(r1).includes('"error"'), r1 ? (JSON.stringify(r1).match(/"error":"[^"]*"/) || [''])[0] : 'no report');
  check('button: environment recorded (viewport, user agent)', r1 && r1.environment && r1.environment.viewport !== undefined);
  await shot(page, 'bug-saved');
  await page.click('.bug .btn--primary');
  // by shortcut, on three screens
  for (const [label, prep] of [['mid-game', async () => {}], ['landing', async () => { page.once('dialog', (d) => d.accept()); await page.click('[data-action=quit]'); await page.waitForSelector('#setup-form'); }]]) {
    await prep();
    await page.keyboard.press('Control+Shift+B');
    await page.waitForSelector('#bug-form');
    const [d] = await Promise.all([page.waitForEvent('download'), page.click('#bug-form button[type=submit]')]);
    let r = null; try { r = JSON.parse(fs.readFileSync(await d.path(), 'utf8')); } catch { /* below */ }
    check(`Ctrl+Shift+B on ${label}: valid JSON report`, r && r.schemaVersion === 1 && typeof r.id === 'string');
    await page.click('.bug .btn--primary');
  }
  // on the end screen
  await setup(page, { t0: 'easy', t1: 'easy', q: 'seed=5', delay: 0 });
  await waitEnd(page);
  await page.keyboard.press('Control+Shift+B');
  await page.waitForSelector('#bug-form');
  const [d3] = await Promise.all([page.waitForEvent('download'), page.click('#bug-form button[type=submit]')]);
  let r3 = null; try { r3 = JSON.parse(fs.readFileSync(await d3.path(), 'utf8')); } catch { /* below */ }
  check('Ctrl+Shift+B on the end screen: valid JSON report', r3 && r3.schemaVersion === 1);
  await page.close();
  const phone = await newPage(390, 844, touchOpts(390));
  await phone.goto(`${BASE}`);
  await phone.waitForSelector('#setup-form');
  await phone.click('#bug-button');
  await phone.waitForSelector('#bug-form');
  await audit(phone, 'bug modal 390');
  await shot(phone, 'bug-modal-390');
  await phone.close();
});

await scenario('Rules dialog and rule book PDF', async () => {
  const page = await newPage(1280, 800);
  await page.goto(`${BASE}?seed=1`);
  await page.waitForSelector('#setup-form');
  await page.click('.topnav [data-action=open-rules]');
  await page.waitForSelector('.dialog');
  check('rules dialog opens with its heading and five steps', /How to play/.test(await page.textContent('.dialog h2')) && (await page.locator('.dialog .how__steps > li').count()) === 5);
  check('dialog is modal (page behind is inert) and focus is inside it', await page.evaluate(() => document.getElementById('app').inert && !!document.activeElement.closest('.dialog')));
  await shot(page, 'rules-dialog');
  await audit(page, 'rules dialog 1280');
  const href = await page.getAttribute('.dialog a[data-action=rulebook]', 'href');
  const res = await page.request.get(new URL(href, BASE).href);
  const body = await res.body();
  check(`PDF link "${href}" is 200 from the sub-path and is a PDF (${Math.round(body.length / 1024)} KB)`, res.status() === 200 && body.slice(0, 4).toString() === '%PDF');
  await page.keyboard.press('Escape');
  check('Escape closes the dialog and returns focus to the opener', (await page.locator('.dialog').count()) === 0 && await page.evaluate(() => document.activeElement && document.activeElement.dataset.action === 'open-rules'));
  // from in-game
  await page.selectOption('select[name=type0]', 'human');
  await page.click('button[type=submit]');
  await page.waitForSelector('.hand .card');
  await page.click('.topbar [data-action=open-rules]');
  await page.waitForSelector('.dialog');
  await shot(page, 'rules-dialog-in-game');
  await page.click('.dialog .btn--primary');
  check('rules dialog opens and closes in-game; the game is untouched', (await page.locator('.hand .card').count()) === 12);
  await page.close();
  for (const w of [390, 360]) {
    const p = await newPage(w, 740, touchOpts(w));
    await p.goto(`${BASE}`);
    await p.waitForSelector('#setup-form');
    await p.click('.topnav [data-action=open-rules]');
    await p.waitForSelector('.dialog');
    await audit(p, `rules dialog ${w}`);
    await shot(p, `rules-dialog-${w}`);
    await p.close();
  }
});

await scenario('Responsive sweep: in-game, end panel, stats and dialogs at 1440, 1024, 768, 390, 360', async () => {
  for (const { w, h } of SCREENS) {
    const page = await newPage(w, h, touchOpts(w));
    await setup(page, { t0: 'human', t1: 'medium', q: 'seed=9', delay: 0 });
    await page.waitForSelector('.hand .card');
    await page.waitForTimeout(250);
    await audit(page, `game ${w}x${h}`);
    const geo = await page.evaluate(() => { const b = document.querySelector('.g-board .board').getBoundingClientRect(); const c = [...document.querySelectorAll('.hand .card')].map((e) => e.getBoundingClientRect()); const hb = document.querySelector('.handbox').getBoundingClientRect(); return { l: b.left, r: b.right, w: b.width, cards: c.length, handOk: c.every((x) => x.left >= hb.left - 0.5 && x.right <= hb.right + 0.5), cw: c[0].width, vw: innerWidth }; });
    check(`game ${w}x${h}: board fits inside the viewport with gutters (${Math.round(geo.w)} px)`, geo.l >= 0 && geo.r <= geo.vw && geo.w >= 280, JSON.stringify(geo));
    check(`game ${w}x${h}: all 12 cards inside the hand box (card ${Math.round(geo.cw)} px wide)`, geo.cards === 12 && geo.handOk);
    check(`game ${w}x${h}: cards are at least 44 px wide to tap/click`, geo.cw >= 44, `${geo.cw}`);
    const ov = await regionOverlaps(page);
    check(`game ${w}x${h}: no regions overlap`, ov.length === 0, ov.join(', '));
    await shot(page, `game-${w}x${h}`, { fullPage: true });
    const contrast = w === 1440 ? await page.evaluate(CONTRAST) : [];
    if (w === 1440) { check('text contrast on game screen (solid backgrounds, 4.5:1 / 3:1 large)', contrast.length === 0, contrast.slice(0, 6).join(' || ')); }
    await page.locator('.topbar [data-action=open-rules]').click();
    await page.waitForSelector('.dialog');
    await audit(page, `rules dialog in game ${w}`);
    await page.keyboard.press('Escape');
    const s = await playHuman(page);
    check(`game ${w}x${h}: played to the end (${s.plays} plays)`, s.plays === 12 && (await page.locator('.end').count()) === 1, JSON.stringify(s.stuck || {}));
    await audit(page, `end panel ${w}x${h}`);
    const dlg = await page.evaluate(() => { const e = document.querySelector('.end').getBoundingClientRect(); return { t: e.top, b: e.bottom, l: e.left, r: e.right, vh: innerHeight, vw: innerWidth, sh: document.querySelector('.end').scrollHeight, ch: document.querySelector('.end').clientHeight }; });
    check(`end panel ${w}x${h}: inside the viewport (it scrolls inside itself when tall)`, dlg.l >= 0 && dlg.r <= dlg.vw && dlg.t >= 0 && dlg.b <= dlg.vh + 1, JSON.stringify(dlg));
    await shot(page, `end-${w}x${h}`);
    await page.click('.end [data-action=open-stats]');
    await page.waitForSelector('.dialog .st__table');
    await audit(page, `stats ${w}x${h}`);
    await shot(page, `stats-${w}x${h}`);
    const dd = await page.evaluate(() => { const e = document.querySelector('.dialog').getBoundingClientRect(); return { l: e.left, r: e.right, vw: innerWidth }; });
    check(`stats dialog ${w}x${h}: within the viewport width`, dd.l >= 0 && dd.r <= dd.vw);
    await page.close();
  }
});

await scenario('Reduced motion', async () => {
  const page = await newPage(1280, 800);
  await setup(page, { q: 'seed=11' });
  await page.waitForSelector('.whale');
  check('default: the whale token transitions', parseFloat(await page.$eval('.whale', (e) => getComputedStyle(e).transitionDuration)) > 0);
  check('default: the "thinking"/pulse animations exist', await page.evaluate(() => [...document.querySelectorAll('.tpip--now, .thinking i')].some((e) => getComputedStyle(e).animationName !== 'none')));
  await page.close();
  const rm = await newPage(1280, 800, { reducedMotion: 'reduce' });
  await setup(rm, { q: 'seed=11' });
  await rm.waitForSelector('.whale');
  check('reduce: whale transition off', parseFloat(await rm.$eval('.whale', (e) => getComputedStyle(e).transitionDuration)) === 0);
  check('reduce: no running animations anywhere on the game screen', await rm.evaluate(() => [...document.querySelectorAll('*')].every((e) => getComputedStyle(e).animationName === 'none')));
  await rm.locator('.hand .card.is-legal').first().click();
  await rm.waitForFunction(() => document.querySelectorAll('.log__item').length >= 1, null, { timeout: 15000 });
  const g = await rm.evaluate(() => { const t = document.querySelector('.board:not(.board--mini) .whale'); const gr = document.querySelector('.board:not(.board--mini) .board__grid').getBoundingClientRect(); const b = t.getBoundingClientRect(); const cell = gr.width / 7; return { dx: b.left + b.width / 2 - (gr.left + (Number(t.dataset.x) + 0.5) * cell), dy: b.top + b.height / 2 - (gr.top + (Number(t.dataset.y) + 0.5) * cell) }; });
  check('reduce: the whale lands on its new cell immediately', Math.abs(g.dx) < 2 && Math.abs(g.dy) < 2, JSON.stringify(g));
  await shot(rm, 'reduced-motion-game');
  await rm.close();
});

await scenario('Keyboard play', async () => {
  const page = await newPage(1280, 800);
  // a seed where the bot leads first, so the human's first turn is a follow with illegal cards in hand
  for (let seed = 11; seed < 40; seed++) {
    await setup(page, { t0: 'human', t1: 'easy', q: `seed=${seed}` });
    await page.waitForSelector('.hand .card.is-legal');
    if (await page.locator('.hand .card.is-blocked').count()) break;
  }
  check('found a game where the first human turn is a follow with illegal cards', (await page.locator('.hand .card.is-blocked').count()) > 0);
  await page.focus('.hand .card.is-blocked');
  const handBefore = await page.locator('.hand .card').count();
  await page.keyboard.press('Enter');
  check('Enter on an illegal card shows the reason and does not play it', (await page.textContent('#note')).length > 10 && (await page.locator('.hand .card').count()) === handBefore);
  await page.focus('.hand .card');
  const back = [];
  for (let i = 0; i < 2; i++) { await page.keyboard.press('Shift+Tab'); back.push(await page.evaluate(() => document.activeElement.dataset.action || document.activeElement.tagName)); }
  check('Shift+Tab from the hand reaches the Rules and Setup buttons (the page has no other tab stops in between)', back.join() === 'open-rules,quit', back.join());
  await page.focus('.hand .card.is-legal');
  check('focusing a legal card shows its preview and board ghosts', (await page.locator('.ghost').count()) > 0 && (await page.textContent('#preview')).length > 10);
  await page.keyboard.press('ArrowRight');
  check('ArrowRight moves focus to the next card', await page.evaluate(() => document.activeElement.classList.contains('card')));
  await page.keyboard.press('End');
  const last = await page.evaluate(() => document.activeElement === [...document.querySelectorAll('.hand .card')].pop());
  await page.keyboard.press('Home');
  const first = await page.evaluate(() => document.activeElement === document.querySelector('.hand .card'));
  check('Home and End jump to the first and last card', last && first);
  let played = 0;
  for (let i = 0; i < 4; i++) {
    const before = await page.locator('.log__item').count();
    await page.focus('.hand .card.is-legal');
    await page.keyboard.press(i % 2 ? 'Space' : 'Enter');
    await page.waitForFunction((n) => document.querySelectorAll('.log__item').length > n, before, { timeout: 15000 }).catch(() => {});
    if ((await page.locator('.log__item').count()) > before) played++;
  }
  check('four tricks played with Enter / Space on focused cards', played === 4, `${played}`);
  const holds = await page.evaluate(() => !!document.activeElement.closest && !!document.activeElement.closest('.hand'));
  check('after a bot reply, focus returns to a legal card in the hand', holds);
  await page.keyboard.press('Escape');
  await page.click('.topbar [data-action=open-rules]');
  await page.waitForSelector('.dialog');
  for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
  check('Tab stays inside the open dialog', await page.evaluate(() => !!document.activeElement.closest('.dialog')));
  await page.keyboard.press('Escape');
  await shot(page, 'keyboard');
  await page.close();
});

await scenario('Leaving a game: Setup link and Quit, abandon confirm', async () => {
  const page = await newPage(1280, 800);
  await setup(page, { t0: 'human', t1: 'easy', q: 'seed=11' });
  await page.waitForSelector('.hand .card.is-legal');
  await page.locator('.hand .card.is-legal').first().click();
  await page.waitForFunction(() => document.querySelectorAll('.log__item').length >= 1, null, { timeout: 15000 });
  let seen = '';
  page.once('dialog', (d) => { seen = d.message(); d.dismiss(); });
  await page.click('[data-action=quit]');
  check('Setup mid-game asks before throwing the game away; Cancel keeps it', /Leave this game/.test(seen) && (await page.locator('.hand .card').count()) > 0);
  page.once('dialog', (d) => d.accept());
  await page.click('[data-action=quit]');
  await page.waitForSelector('#setup-form');
  check('confirming returns to the setup screen with the previous choices kept', (await page.$eval('select[name=type1]', (s) => s.value)) === 'easy');
  const ev = await page.evaluate(() => (window.dataLayer || []).map((a) => Array.from(a)).filter((a) => a[0] === 'event' && a[1] === 'game_abandoned'));
  check('game_abandoned was queued once when leaving via Setup, with usage params only', ev.length === 1 && ev[0][2].tricks >= 1 && !('winner' in ev[0][2]), JSON.stringify(ev));
  await page.close();
});

await scenario('Console errors, warnings and HTTP 404s across the whole run', async () => {
  check(`no console errors/warnings, page errors, failed requests or HTTP >= 400 (${problems.length})`, problems.length === 0, [...new Set(problems)].slice(0, 8).join(' || '));
  const bad = requestLog.filter((r) => r.status >= 400 && r.url.startsWith(`/${SUB}/`)); // (the deliberate request for the bare origin is not a page request)
  check(`server log: ${requestLog.length} requests, none 404 (exact-case server)`, bad.length === 0, [...new Set(bad.map((b) => `${b.status} ${b.url}`))].slice(0, 8).join('; '));
  const missed = [...new Set(requestLog.filter((r) => r.status === 200).map((r) => r.url))].length;
  check(`${missed} distinct files requested and served`, missed > 20);
});

// ---------- report ----------
await browser.close();
server.close();
const failed = results.filter((r) => !r.pass);
const byScenario = new Map();
for (const r of results) { if (!byScenario.has(r.scenario)) byScenario.set(r.scenario, []); byScenario.get(r.scenario).push(r); }
const summary = [...byScenario.entries()].map(([name, rs]) => ({ scenario: name, pass: rs.every((r) => r.pass), checks: rs.length, failed: rs.filter((r) => !r.pass).map((r) => `${r.name} -- ${r.detail}`), screenshots: shotsByScenario.get(name) || [] }));
fs.writeFileSync(path.join(TMP, 'qa-results.json'), JSON.stringify({ summary, imageBytes: Object.fromEntries(imageBytes), results }, null, 2));
console.log('\n---------------- summary ----------------');
for (const s of summary) console.log(`${s.pass ? 'PASS' : 'FAIL'}  ${s.scenario}  (${s.checks} checks${s.failed.length ? `, ${s.failed.length} failed` : ''})`);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed. Screenshots: ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
