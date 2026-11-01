// stats-browser.mjs - the stats screen, exports, analytics events and the bug reporter in the
// real UI (headless Chromium): two quick bot games and a short tournament are played, then the
// stats screen, CSV/JSON downloads, gtag events (stubbed), blocked localStorage and the bug
// report download are checked. Needs Playwright (found as in ui-browser.mjs); prints SKIPPED
// without it (exit 0), or exits 1 with --require. Run: node tests/stats-browser.mjs [--require]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { suite } from './lib.mjs';
import { ALLOWED_PARAMS } from '../src/ui/analytics.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { check, done } = suite('stats-browser');

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
  console.log('stats-browser: SKIPPED (Playwright not found)');
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
const pageErrors = [];
// index.html defines the real gtag (it pushes onto window.dataLayer), which would overwrite any stub,
// so the events are read back from dataLayer. The third-party scripts (consent banner, GA) are blocked.
const STUB = () => {};
const events = (page) => page.evaluate(() => (window.dataLayer || []).map((a) => Array.from(a)).filter((a) => a[0] === 'event'));

async function newPage(init) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  await ctx.addInitScript(init || STUB);
  await ctx.route(/cdn-cookieyes\.com|googletagmanager\.com|google-analytics\.com/, (r) => r.abort());
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  return page;
}

async function playBots(page, { t0, t1, mode }) {
  await page.goto(`${BASE}?botdelay=0&seed=31`);
  await page.waitForSelector('#setup-form');
  await page.selectOption('select[name=type0]', t0);
  await page.selectOption('select[name=type1]', t1);
  await page.check(`input[name=mode][value=${mode}]`);
  await page.click('button[type=submit]');
}

async function finish(page, mode) {
  for (let guard = 0; guard < 12; guard++) {
    await page.waitForSelector('.end', { timeout: 60000 });
    if (mode === 'single' || /tournament/i.test(await page.textContent('.end h2'))) return;
    await page.click('.end [data-action=next-game]');
    await page.waitForTimeout(50);
  }
}

async function openStats(page) {
  await page.click('[data-action=open-stats]');
  await page.waitForSelector('.dialog .st');
}

// ---------- empty state, then two single games and a tournament ----------
{
  const page = await newPage();
  await page.goto(`${BASE}?botdelay=0`);
  await page.waitForSelector('#setup-form');
  await openStats(page);
  check('empty: shows the empty state', /No games recorded yet/.test(await page.textContent('.dialog .st')));
  check('empty: export buttons disabled', await page.$eval('[data-action=export-csv]', (b) => b.disabled));
  await page.keyboard.press('Escape');

  await playBots(page, { t0: 'easy', t1: 'medium', mode: 'single' });
  await finish(page, 'single');
  await page.click('.end [data-action=new]');
  await page.waitForSelector('#setup-form');
  await playBots(page, { t0: 'hard', t1: 'easy', mode: 'single' });
  await finish(page, 'single');
  await page.click('.end [data-action=open-stats]'); // from the end panel
  await page.waitForSelector('.dialog .st');
  check('stats from end panel: 2 games played', /2<\/b> games played|2 games played/.test(await page.innerHTML('.dialog .st__lead')) || /2\s+games played/.test(await page.textContent('.dialog .st__lead')), await page.textContent('.dialog .st__lead'));
  check('stats: matchup table has a row per pairing with counts', (await page.locator('.st__table').first().locator('tbody tr').count()) >= 1);
  check('stats: small sample flagged', (await page.locator('.st__small').count()) > 0);
  check('stats: heatmap is 7x7 with 2 games', (await page.locator('.heat__cell').count()) === 49 && (await page.$$eval('.heat__cell', (c) => c.reduce((a, x) => a + (Number(x.textContent) || 0), 0))) === 2);
  await page.keyboard.press('Escape');
  await page.click('.end [data-action=new]');
  await page.waitForSelector('#setup-form');
  await playBots(page, { t0: 'easy', t1: 'easy', mode: 'tournament' });
  await finish(page, 'tournament');
  await page.click('.end [data-action=open-stats]');
  await page.waitForSelector('.dialog .st');
  const tText = await page.textContent('.dialog .st');
  check('stats: tournament listed', /Tournaments\s*1 finished/.test(tText), tText.slice(0, 400));
  const games = await page.evaluate(() => JSON.parse(localStorage.getItem('ahab-stats-v1')).games.length);
  check('stats: tournament games are in the store (2 singles + 3..5)', games >= 5 && games <= 7, String(games));

  // exports
  const [csvDl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action=export-csv]')]);
  check('export: csv filename', /^ahab-stats-\d{4}-\d{2}-\d{2}\.csv$/.test(csvDl.suggestedFilename()), csvDl.suggestedFilename());
  const csv = fs.readFileSync(await csvDl.path(), 'utf8').trim().split('\n');
  check('export: csv has header + one row per game', csv.length === games + 1 && csv[0].startsWith('date,mode,tournament_id'), `${csv.length}`);
  const [jsonDl] = await Promise.all([page.waitForEvent('download'), page.click('[data-action=export-json]')]);
  const json = JSON.parse(fs.readFileSync(await jsonDl.path(), 'utf8'));
  check('export: json has every game and the tournament', json.games.length === games && json.tournaments.length === 1 && /\.json$/.test(jsonDl.suggestedFilename()));

  // analytics
  const calls = await events(page);
  const names = calls.map((c) => c[1]);
  for (const n of ['game_start', 'game_end', 'tournament_start', 'tournament_end', 'stats_viewed', 'stats_exported']) check(`analytics: ${n} fired in the page`, names.includes(n));
  const keys = new Set(calls.filter((c) => c[0] === 'event').flatMap((c) => Object.keys(c[2] || {})));
  check('analytics: page params within the whitelist', [...keys].every((k) => ALLOWED_PARAMS.includes(k)), [...keys].join(','));
  check('analytics: exports carry the format', calls.filter((c) => c[1] === 'stats_exported').map((c) => c[2].format).sort().join() === 'csv,json');
  await page.keyboard.press('Escape');

  // rules
  await page.click('.end [data-action=new]');
  await page.waitForSelector('#setup-form');
  await page.click('[data-action=open-rules]');
  const rules = (await events(page)).filter((c) => c[1] === 'rules_opened');
  check('analytics: rules_opened where=dialog', rules.length === 1 && rules[0][2].where === 'dialog');
  await page.keyboard.press('Escape');

  // bug reporter
  check('bug: button on body, survives to the landing page', (await page.locator('body > #bug-button').count()) === 1);
  await playBots(page, { t0: 'human', t1: 'easy', mode: 'single' });
  await page.waitForSelector('.hand .card.is-legal');
  await page.locator('.hand .card.is-blocked').first().click({ force: true }).catch(() => {});
  await page.locator('.hand .card.is-legal').first().click();
  await page.waitForSelector('.hand .card.is-legal');
  check('bug: button still there mid-game after re-renders', (await page.locator('body > #bug-button').count()) === 1);
  await page.keyboard.press('Control+Shift+B');
  await page.waitForSelector('#bug-form');
  await page.fill('#bug-form [name=title]', 'Card would not play');
  await page.fill('#bug-form [name=happened]', 'clicked and nothing');
  const [bugDl] = await Promise.all([page.waitForEvent('download'), page.click('#bug-form button[type=submit]')]);
  const rep = JSON.parse(fs.readFileSync(await bugDl.path(), 'utf8'));
  check('bug: file name from id and title', /^ahab-\d{8}-\d{6}-[a-z0-9]+-card-would-not-play\.json$/.test(bugDl.suggestedFilename()), bugDl.suggestedFilename());
  check('bug: valid report with state, diagnostics and logs', rep.schemaVersion === 1 && rep.game && rep.game.kind === 'game' && rep.diagnostics && rep.diagnostics.cards.length > 0 && rep.actionLog.length >= 2 && rep.player.title === 'Card would not play');
  check('bug: action log covers human and bot cards', new Set(rep.actionLog.map((a) => a.seatType)).size === 2);
  check('bug: mailto link shown with the contact address', (await page.locator('.bug a[href^="mailto:info@wombatgamefactory.com?"]').count()) === 1);
  await page.click('.bug .btn--primary');
  check('bug: modal closes', (await page.locator('.bug').count()) === 0);
  await page.keyboard.press('Control+Shift+B');
  await page.waitForSelector('.bug__past');
  check('bug: past reports list shows the saved report', (await page.locator('.bug__past li').count()) === 1);
  await page.keyboard.press('Escape');
  check('bug: Escape closes the modal', (await page.locator('.bug').count()) === 0);

  // leaving a running game through the Setup link counts as abandoning it (once)
  const before = (await events(page)).filter((c) => c[1] === 'game_abandoned').length;
  page.once('dialog', (d) => d.accept());
  await page.click('[data-action=quit]');
  await page.waitForSelector('#setup-form');
  const abandoned = (await events(page)).filter((c) => c[1] === 'game_abandoned');
  check('analytics: game_abandoned fires when leaving a running game via Setup', before === 0 && abandoned.length === 1, `${before} -> ${abandoned.length}`);
  const ab = abandoned[0] ? abandoned[0][2] : {};
  check('analytics: game_abandoned carries only usage params and a trick count', Object.keys(ab).every((k) => ALLOWED_PARAMS.includes(k)) && ab.tricks >= 1 && ab.duration_seconds >= 0 && ab.human_players === 1, JSON.stringify(ab));
  await playBots(page, { t0: 'easy', t1: 'easy', mode: 'single' });
  await finish(page, 'single');
  await page.click('.end [data-action=new]');
  await page.waitForSelector('#setup-form');
  // (playBots reloads the page, so this is a fresh event list)
  check('analytics: a finished game is not reported as abandoned afterwards', (await events(page)).filter((c) => c[1] === 'game_abandoned').length === 0);

  await page.close();
}

// the Clear button, with a confirm
{
  const page = await newPage();
  await playBots(page, { t0: 'easy', t1: 'easy', mode: 'single' });
  await finish(page, 'single');
  await page.click('.end [data-action=open-stats]');
  await page.waitForSelector('.dialog .st__table');
  page.once('dialog', (d) => d.dismiss());
  await page.click('[data-action=clear-stats]');
  check('clear: dismissing the confirm keeps the data', (await page.locator('.dialog .st__table').count()) > 0);
  page.once('dialog', (d) => d.accept());
  await page.click('[data-action=clear-stats]');
  await page.waitForSelector('.st__empty');
  check('clear: accepting empties the store', (await page.evaluate(() => localStorage.getItem('ahab-stats-v1'))) === null);
  await page.close();
}

// ---------- localStorage blocked: the game and the screens still work ----------
{
  const page = await newPage(() => {
    const boom = () => { throw new Error('storage blocked'); };
    Object.defineProperty(window, 'localStorage', { get: boom, configurable: true });
  });
  await playBots(page, { t0: 'easy', t1: 'medium', mode: 'single' });
  await finish(page, 'single');
  check('blocked storage: game reached the end panel', (await page.locator('.end').count()) === 1);
  await page.click('.end [data-action=open-stats]');
  await page.waitForSelector('.dialog .st');
  check('blocked storage: stats screen shows the empty state', /No games recorded yet/.test(await page.textContent('.dialog .st')));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Shift+B');
  await page.waitForSelector('#bug-form');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#bug-form button[type=submit]')]);
  check('blocked storage: bug report still downloads', JSON.parse(fs.readFileSync(await dl.path(), 'utf8')).schemaVersion === 1);
  await page.close();
}

// ---------- no gtag at all ----------
{
  const page = await newPage(() => { document.addEventListener('DOMContentLoaded', () => { window.gtag = undefined; }); });
  await playBots(page, { t0: 'easy', t1: 'easy', mode: 'single' });
  await finish(page, 'single');
  check('no gtag: game completes', (await page.locator('.end').count()) === 1);
  await page.close();
}

check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
await browser.close();
server.close();
done();
