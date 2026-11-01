// ui-browser.mjs - drives the real UI in headless Chromium: landing, human v Easy, human v Hard
// (the page must not freeze), bot v bot, pass-and-play (hands hidden), a full first-to-3
// tournament with role swaps, the no-Worker fallback, reduced motion, phone widths, and a clean
// console. Starts its own static server on a free port; needs Playwright, which is NOT a
// dependency of this repo: it is looked up as `playwright`, then in the global npm root, or
// from PLAYWRIGHT_PATH. Without it the suite prints SKIPPED (exit 0), or exits 1 with --require.
// Run: node tests/ui-browser.mjs [--require]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { suite } from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { check, done } = suite('ui-browser');

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
if (!chromium) {
  console.log('ui-browser: SKIPPED (Playwright not found)');
  process.exit(process.argv.includes('--require') ? 1 : 0);
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.pdf': 'application/pdf' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    if (p.startsWith(ROOT) && fs.existsSync(path.join(p, 'index.html'))) { res.writeHead(200, { 'content-type': 'text/html' }); return fs.createReadStream(path.join(p, 'index.html')).pipe(res); }
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch();
const problems = [];
async function newPage(w = 1280, h = 900, opts = {}, init = null) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, ...opts });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${w}] ${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[${w}] pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`[${w}] request failed: ${r.url()}`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`[${w}] HTTP ${r.status()} ${r.url()}`); });
  return page;
}

async function setup(page, { t0 = 'human', t1 = 'easy', r0 = 'random', r1 = 'random', mode = 'single', q = 'seed=11' } = {}) {
  await page.goto(`${BASE}?botdelay=40&${q}`);
  await page.waitForSelector('#setup-form');
  await page.selectOption('select[name=type0]', t0);
  await page.selectOption('select[name=type1]', t1);
  await page.selectOption('select[name=role0]', r0);
  await page.selectOption('select[name=role1]', r1);
  await page.check(`input[name=mode][value=${mode}]`);
  await page.click('button[type=submit]');
}

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Plays every human turn (first legal card; tries one illegal card first) until an end panel appears. */
async function playHuman(page, stats = {}) {
  const deadline = Date.now() + 120000;
  stats.plays = 0; stats.covers = 0; stats.coverLeaks = 0; stats.refusalsMatchTitle = true; stats.illegalTried = 0; stats.previews = 0;
  while (Date.now() < deadline) {
    if (await page.locator('.end').count()) break;
    if (await page.locator('.cover').count()) {
      stats.covers++;
      if (await page.locator('.hand, .board, .log__list').count()) stats.coverLeaks++;
      await page.click('.cover .btn--primary');
      continue;
    }
    const legal = page.locator('.hand .card.is-legal');
    if (await legal.count()) {
      const blocked = page.locator('.hand .card.is-blocked');
      if (stats.illegalTried < 3 && await blocked.count()) {
        stats.illegalTried++;
        const title = await blocked.first().getAttribute('title');
        await blocked.first().click({ force: true }); // aria-disabled cards stay clickable on purpose
        const note = await page.textContent('#note');
        if (!title || title !== note) stats.refusalsMatchTitle = false;
      }
      await legal.first().hover();
      if ((await page.textContent('#preview')).length > 10 && await page.locator('.ghost').count() > 0) stats.previews++;
      await legal.first().click();
      stats.plays++;
    } else await page.waitForTimeout(40);
  }
  return stats;
}

// ---------- landing ----------
{
  const page = await newPage();
  await page.goto(`${BASE}?seed=1`);
  await page.waitForSelector('#setup-form');
  check('landing: title', (await page.title()) === 'Ahab and the Whale');
  check('landing: the hook', (await page.textContent('.hero__hook')) === 'The suit you lead is the wind that blows.');
  check('landing: stat strip', /2[\s\S]*Players[\s\S]*10[\s\S]*Minutes[\s\S]*10\+[\s\S]*Ages/.test(await page.textContent('.stats')));
  const opts = await page.$$eval('select[name=type1] option', (o) => o.map((x) => x.value));
  check('landing: bot levels come from the registry (easy, medium, hard)', ['human', 'easy', 'medium', 'hard'].every((v) => opts.includes(v)), opts.join(','));
  check('landing: hint to watch bots', /Set both seats to bots to watch a game/.test(await page.textContent('.hint')));
  check('landing: hero art loaded', await page.$eval('.hero__img', (i) => i.complete && i.naturalWidth > 100));
  const href = await page.getAttribute('a[data-action=rulebook]', 'href');
  const r = await page.request.get(BASE + href);
  check('landing: rule book PDF link works', r.status() === 200 && (await r.body()).slice(0, 4).toString() === '%PDF');
  await page.selectOption('select[name=role0]', 'ahab');
  check('landing: the other seat cannot pick the same fixed role', await page.$eval('select[name=role1] option[value=ahab]', (o) => o.disabled));
  const og = await page.$eval('meta[property="og:image"]', (m) => m.content);
  check('landing: og:image is an absolute URL under the published address', og === 'https://www.wombatgamefactory.com/ahab-and-the-whale/assets/hero/hero-square.jpg', og);
  const ogUrl = await page.$eval('meta[property="og:url"]', (m) => m.content);
  check('landing: og:url is the published address', ogUrl === 'https://www.wombatgamefactory.com/ahab-and-the-whale/', ogUrl);
  await page.close();
}

// ---------- human v Easy ----------
{
  const page = await newPage();
  await setup(page);
  await page.waitForSelector('.hand .card');
  const s = await playHuman(page);
  check('human v Easy: 12 human plays, game ends', s.plays === 12 && (await page.locator('.end').count()) === 1, `${s.plays}`);
  check('human v Easy: illegal cards explain themselves (tooltip equals click message)', s.illegalTried > 0 && s.refusalsMatchTitle);
  check('human v Easy: hover shows a preview and board ghosts', s.previews >= 6, `${s.previews}`);
  check('human v Easy: end panel shows winner, final board and badges', (await page.locator('.end .board').count()) === 1 && (await page.locator('.end .badge').count()) >= 2 && /wins|win!/.test(await page.textContent('.end h2')));
  check('human v Easy: trick log has 12 lines', (await page.locator('.log__item').count()) === 12);
  check('human v Easy: no horizontal scroll at the end', (await overflow(page)) <= 0);
  await page.click('.end [data-action=again]');
  await page.waitForSelector('.hand .card');
  check('play again starts a new game with the same setup', (await page.locator('.hand .card').count()) === 12 && (await page.locator('.log__item').count()) === 0);
  await page.close();
}

// ---------- human v Hard: the page must stay responsive ----------
{
  const page = await newPage();
  await setup(page, { t1: 'hard', q: 'seed=5' });
  await page.waitForSelector('.hand .card');
  await page.evaluate(() => { window.__gap = 0; let last = performance.now(); setInterval(() => { const n = performance.now(); window.__gap = Math.max(window.__gap, n - last); last = n; }, 16); });
  const s = await playHuman(page);
  const gap = await page.evaluate(() => window.__gap);
  check('human v Hard: game ends', s.plays === 12 && (await page.locator('.end').count()) === 1);
  check('human v Hard: decisions ran in a Web Worker', (await page.evaluate(() => document.body.dataset.botMode)) === 'worker');
  check('human v Hard: main thread never stalled (longest gap < 200 ms)', gap < 200, `${Math.round(gap)} ms`);
  await page.close();
}

// ---------- bot v bot, with and without Workers ----------
{
  const page = await newPage();
  await setup(page, { t0: 'hard', t1: 'medium', q: 'seed=3' });
  await page.waitForSelector('.end', { timeout: 60000 });
  check('bot v bot: finishes by itself', (await page.locator('.end h2').count()) === 1);
  check('bot v bot: no hand is shown', (await page.locator('.hand .card').count()) === 0 && (await page.locator('.seat__backs').count()) === 2);
  await page.close();
  const p2 = await newPage(1280, 900, {}, () => { delete window.Worker; });
  await setup(p2, { t0: 'medium', t1: 'hard', q: 'seed=4' });
  await p2.waitForSelector('.end', { timeout: 60000 });
  check('no Worker: falls back to synchronous bots and still finishes', (await p2.evaluate(() => document.body.dataset.botMode)) === 'sync');
  await p2.close();
  const p3 = await newPage(1280, 900, {}, () => {
    const Real = window.Worker;
    window.Worker = class { constructor() { throw new Error('blocked'); } };
    window.__RealWorker = Real;
  });
  await setup(p3, { t0: 'easy', t1: 'hard', q: 'seed=8' });
  await p3.waitForSelector('.end', { timeout: 60000 });
  check('Worker constructor throws: falls back and finishes', (await p3.evaluate(() => document.body.dataset.botMode)) === 'sync');
  await p3.close();
}

// ---------- pass and play ----------
{
  const page = await newPage();
  await setup(page, { t0: 'human', t1: 'human', r0: 'ahab', r1: 'whale', q: 'seed=2' });
  await page.waitForSelector('.cover');
  check('pass-and-play: the first screen is the cover with no cards in the DOM', (await page.locator('.card').count()) === 0 && /Pass to Player \d \((Ahab|Whale)\)/.test(await page.textContent('.cover h2')));
  const s = await playHuman(page);
  check('pass-and-play: 24 plays, a cover between players, never a leak', s.plays === 24 && s.covers >= 6 && s.coverLeaks === 0, `${s.plays} plays, ${s.covers} covers, ${s.coverLeaks} leaks`);
  await page.close();
}

// ---------- tournament ----------
{
  const page = await newPage();
  await setup(page, { t0: 'human', t1: 'easy', r0: 'ahab', mode: 'tournament', q: 'seed=21' });
  await page.waitForSelector('.hand .card');
  const rolesSeen = []; let games = 0; let scoreboardAlways = true;
  for (;;) {
    rolesSeen.push((await page.locator('.g-score .score__seat small').allTextContents()).join('|'));
    const s = await playHuman(page);
    scoreboardAlways = scoreboardAlways && (await page.locator('.g-score').count()) === 1;
    games++;
    const next = page.locator('.end [data-action=next-game]');
    if (await next.count()) { await next.click(); await page.waitForSelector('.hand .card'); } else { void s; break; }
  }
  const title = await page.textContent('.end h2');
  check('tournament: ends with a tournament-over panel', /the tournament/.test(title), title);
  check('tournament: 3 to 5 games', games >= 3 && games <= 5, `${games}`);
  check('tournament: roles swap every game', rolesSeen.every((r, i) => i === 0 || r !== rolesSeen[i - 1]) && rolesSeen[0] === 'Ahab this game|Whale this game', rolesSeen.join(' / '));
  check('tournament: scoreboard visible throughout', scoreboardAlways);
  check('tournament: someone has three win pips', (await page.locator('.end .score .pip--won').count()) >= 3);
  await page.close();
}

// ---------- motion ----------
{
  const page = await newPage(1280, 900);
  await setup(page, { q: 'seed=11' });
  await page.waitForSelector('.whale');
  check('motion: the whale token transitions by default', parseFloat(await page.$eval('.whale', (e) => getComputedStyle(e).transitionDuration)) > 0);
  await page.close();
  const rm = await newPage(1280, 900, { reducedMotion: 'reduce' });
  await setup(rm, { q: 'seed=11' });
  await rm.waitForSelector('.whale');
  check('motion: prefers-reduced-motion turns the transition off', parseFloat(await rm.$eval('.whale', (e) => getComputedStyle(e).transitionDuration)) === 0);
  await rm.close();
}

// ---------- the whale visibly moves one step per trick ----------
{
  const page = await newPage(1280, 900);
  await setup(page, { t0: 'human', t1: 'easy', q: 'seed=11' });
  await page.waitForSelector('.hand .card');
  const pos = () => page.$eval('.board:not(.board--mini) .whale', (e) => `${e.dataset.x},${e.dataset.y}`);
  let steps = 0; let last = await pos(); let jumpsOk = true;
  for (let i = 0; i < 12; i++) {
    const c = page.locator('.hand .card.is-legal');
    while (!(await c.count())) await page.waitForTimeout(40);
    await c.first().click();
    // wait for the trick to finish
    await page.waitForFunction((n) => document.querySelectorAll('.log__item').length > n, i, { timeout: 5000 });
    const now = await pos();
    const [a, b] = last.split(',').map(Number); const [x, y] = now.split(',').map(Number);
    const d = Math.abs(a - x) + Math.abs(b - y);
    if (d > 1) jumpsOk = false;
    if (d === 1) steps++;
    last = now;
    await page.waitForTimeout(60);
  }
  check('whale moves at most one cell per trick', jumpsOk && steps > 0, `${steps} moves`);
  await page.close();
}

// ---------- responsive ----------
for (const w of [360, 390, 768, 1280]) {
  const page = await newPage(w, 800, w < 700 ? { hasTouch: true, isMobile: true } : {});
  await page.goto(`${BASE}?seed=1`);
  await page.waitForSelector('#setup-form');
  check(`responsive ${w}px: landing has no horizontal scroll`, (await overflow(page)) <= 0);
  await setup(page, { t1: 'medium', q: 'seed=9' });
  await page.waitForSelector('.hand .card');
  check(`responsive ${w}px: game has no horizontal scroll`, (await overflow(page)) <= 0);
  const box = await page.$eval('.board:not(.board--mini)', (e) => { const r = e.getBoundingClientRect(); return [r.left, r.right]; });
  check(`responsive ${w}px: board fits with gutters`, box[0] >= 0 && box[1] <= w, JSON.stringify(box));
  await page.close();
}

// ---------- keyboard ----------
{
  const page = await newPage();
  await setup(page, { q: 'seed=11' });
  await page.waitForSelector('.hand .card');
  await page.focus('.hand .card.is-legal');
  check('keyboard: focusing a legal card shows its preview', (await page.locator('.ghost').count()) > 0);
  await page.keyboard.press('ArrowRight');
  check('keyboard: arrow keys move along the hand', (await page.evaluate(() => document.activeElement.classList.contains('card'))));
  await page.close();
}

const real = problems.filter((p) => !/fonts\.(googleapis|gstatic)\.com/.test(p)); // web fonts are optional, with fallbacks
check('console is clean (no errors, warnings, failed requests)', real.length === 0, real.slice(0, 5).join(' || '));

await browser.close();
server.close();
done();
