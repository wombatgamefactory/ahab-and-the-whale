// stats-node.mjs - local stats store, CSV/JSON export, analytics parameter whitelist and the
// bug-report snapshot, all in Node (fake localStorage, stubbed window.gtag).
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure. Run: node tests/stats-node.mjs
// (not yet in run-all.mjs; add 'stats-node.mjs' to its SUITES list)

import { suite } from './lib.mjs';
import { createController } from '../src/ui/controller.js';
import {
  createStatsStore, createRecorder, toCsv, csvCell, CSV_COLUMNS, summarise, exportFilename,
  STORE_KEY, MAX_GAMES,
} from '../src/ui/stats-store.js';
import * as analytics from '../src/ui/analytics.js';
import { buildReport, logAction, logEvent, _resetLogs, archiveReport, loadArchive, ARCHIVE_MAX, BUG_REPORT_EMAIL } from '../src/ui/bug-report.js';

const { check, done } = suite('stats-node');

// ---------- helpers ----------
function fakeStorage() {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
}
const throwing = () => { throw new Error('blocked'); };

/** Minimal RFC 4180 parser for the round trip. */
function parseCsv(text) {
  const rows = [];
  let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** A mirror of main.js fireHooks(): same hooks, same info shape, driven from the controller. */
function runSession({ seats, mode, seed, roleChoices }, hooks) {
  const ctl = createController({ seats: seats.map((type) => ({ type })), roleChoices, mode, seed, names: ['A', 'B'] });
  let processed = ctl.lastEvents;
  const info = () => {
    const g = ctl.game();
    return {
      mode: ctl.mode, seed: ctl.seed, seats: ctl.seats.map((s) => s.type), names: [...ctl.names], roles: [...g.roles],
      gameNo: ctl.mode === 'tournament' ? ctl.state.gameNo : 1,
      wins: ctl.mode === 'tournament' ? [...ctl.state.wins] : null,
      gamesPlayed: ctl.mode === 'tournament' ? ctl.state.history.length : 1, game: g,
    };
  };
  ctl.subscribe(() => {
    if (ctl.lastEvents === processed) return;
    processed = ctl.lastEvents;
    const events = processed;
    const i = info();
    for (const ev of events) if (ev.type === 'game-started') hooks.onGameStart({ ...i, gameNo: ev.gameNo, roles: ev.roles });
    if (events.some((e) => e.type === 'card-played')) hooks.onCardPlayed({ ...i, events, trickDone: events.some((e) => e.type === 'trick-won') });
    const over = events.find((e) => e.type === 'game-over');
    if (over) hooks.onGameEnd({ ...i, result: over });
    const tover = events.find((e) => e.type === 'tournament-over');
    if (tover) hooks.onTournamentEnd({ ...i, winnerSeat: tover.winnerSeat, wins: tover.wins });
  });
  if (mode === 'tournament') hooks.onTournamentStart(info());
  hooks.onGameStart(info());
  for (let guard = 0; guard < 20; guard++) {
    ctl.runBots();
    if (ctl.canStartNextGame()) ctl.startNextGame(); else break;
  }
  return ctl;
}

// ---------- store: append, cap, blocked storage ----------
{
  const st = fakeStorage();
  const store = createStatsStore(() => st);
  const rec = createRecorder(store);
  const hooks = {
    onGameStart: (i) => rec.gameStart(i), onCardPlayed() {}, onGameEnd: (i) => rec.gameEnd(i),
    onTournamentStart() {}, onTournamentEnd: (i) => rec.tournamentEnd(i),
  };
  runSession({ seats: ['easy', 'medium'], mode: 'single', seed: 5, roleChoices: ['ahab', 'whale'] }, hooks);
  runSession({ seats: ['hard', 'easy'], mode: 'single', seed: 6, roleChoices: ['random', 'random'] }, hooks);
  let data = store.load();
  check('store: two games appended', data.games.length === 2, String(data.games.length));
  const g = data.games[0];
  check('store: record shape', g.v === 1 && g.mode === 'single' && g.tid === null && g.seats.length === 2 && g.seats[0].type === 'easy' && g.seats[0].role === 'ahab');
  check('store: 12 path cells and 24 cards with seats', g.path.length === 12 && g.cards.length === 24 && g.cards.every(([c, s]) => /^[NESW][1-9]$/.test(c) && (s === 0 || s === 1)));
  check('store: final whale equals last path cell', g.path[11][0] === g.whale.x && g.path[11][1] === g.whale.y);
  check('store: winner fields agree', g.winnerType === g.seats[g.winnerSeat].type && g.seats[g.winnerSeat].role === g.winnerRole);
  check('store: first leader role matches seat', g.seats[g.firstLeaderSeat].role === g.firstLeaderRole && g.tricks === 12);
  check('store: stored under the versioned key', st.m.has(STORE_KEY) && JSON.parse(st.m.get(STORE_KEY)).v === 1);

  runSession({ seats: ['medium', 'medium'], mode: 'tournament', seed: 7, roleChoices: ['random', 'random'] }, hooks);
  data = store.load();
  const tg = data.games.filter((x) => x.mode === 'tournament');
  check('store: tournament games recorded with id and numbers', tg.length >= 3 && tg.every((x, i) => x.tid === 't7' && x.gameNo === i + 1), String(tg.length));
  check('store: one tournament record with wins', data.tournaments.length === 1 && data.tournaments[0].gamesPlayed === tg.length && Math.max(...data.tournaments[0].wins) === 3 && data.tournaments[0].wins[data.tournaments[0].winnerSeat] === 3);
  check('store: tournament roles swap each game', tg.length < 2 || tg[0].seats[0].role !== tg[1].seats[0].role);

  // cap
  const big = fakeStorage();
  const capStore = createStatsStore(() => big);
  for (let i = 0; i < MAX_GAMES + 25; i++) capStore.addGame({ ...g, seconds: i });
  const loaded = capStore.load();
  check('store: capped at MAX_GAMES, oldest dropped', loaded.games.length === MAX_GAMES && loaded.games[0].seconds === 25 && loaded.games[MAX_GAMES - 1].seconds === MAX_GAMES + 24);

  // clear
  store.clear();
  check('store: clear empties', store.load().games.length === 0 && !st.m.has(STORE_KEY));

  // summary and export on `data`
  const sum = summarise(data.games, data.tournaments);
  check('summary: totals add up', sum.total === data.games.length && sum.ahabWins + sum.whaleWins === sum.total);
  check('summary: matchup counts add up', sum.matchups.reduce((a, m) => a + m.n, 0) === sum.total);
  check('summary: heatmap counts every game', sum.heat.flat().reduce((a, b) => a + b, 0) === sum.total);
  check('summary: first-leader counts add up', sum.leadOverall.n === sum.total);
  check('summary: tournament winner counted', sum.tournaments === 1 && Object.values(sum.tournamentWinners)[0] === 1);

  const csv = toCsv(data.games);
  const rows = parseCsv(csv);
  check('csv: header then one row per game', rows.length === data.games.length + 1 && rows[0].join(',') === CSV_COLUMNS.join(','));
  check('csv: every row has the header width', rows.every((r) => r.length === CSV_COLUMNS.length));
  const col = (name) => CSV_COLUMNS.indexOf(name);
  check('csv: cards column is 24 space-separated ids', rows.slice(1).every((r) => r[col('cards')].split(' ').length === 24));
  check('csv: values round-trip', rows[1][col('winner_role')] === data.games[0].winnerRole && rows[1][col('seat1_type')] === 'easy' && Number(rows[1][col('final_whale_x')]) === data.games[0].whale.x);
  check('csv: LF only (no CR)', !csv.includes('\r'));
  check('csv: quoting', csvCell('a,b') === '"a,b"' && csvCell('say "hi"') === '"say ""hi"""' && csvCell('x\ny') === '"x\ny"' && csvCell(null) === '' && csvCell(3) === '3');
  const odd = toCsv([{ ...data.games[0], reason: 'a,"b"\nc' }]);
  check('csv: awkward value survives parse', parseCsv(odd)[1][col('end_reason')] === 'a,"b"\nc');
  check('filename: ahab-stats-YYYY-MM-DD', exportFilename('csv', new Date(2026, 10, 1)) === 'ahab-stats-2026-11-01.csv');
}

// ---------- store: blocked / throwing storage ----------
{
  const bad = createStatsStore(throwing);
  let ok = true;
  try {
    ok = bad.addGame({ x: 1 }) === false && bad.addTournament({}) === false && bad.load().games.length === 0 && bad.clear() === false;
  } catch { ok = false; }
  check('blocked storage: nothing throws, store forgets', ok);
  const nul = createStatsStore(() => null);
  check('null storage tolerated', nul.addGame({}) === false && nul.load().games.length === 0);
  const half = fakeStorage();
  half.setItem = () => { throw new Error('QuotaExceededError'); };
  check('quota error tolerated', createStatsStore(() => half).addGame({}) === false);
  const corrupt = fakeStorage();
  corrupt.setItem(STORE_KEY, '{not json');
  check('corrupt data reads as empty and can be overwritten', createStatsStore(() => corrupt).load().games.length === 0 && createStatsStore(() => corrupt).addGame({ a: 1 }) === true);
  const wrongVer = fakeStorage();
  wrongVer.setItem(STORE_KEY, JSON.stringify({ v: 99, games: [{}] }));
  check('unknown schema version ignored', createStatsStore(() => wrongVer).load().games.length === 0);

  // a whole session with throwing storage still plays to the end
  const rec = createRecorder(bad);
  const ctl = runSession({ seats: ['easy', 'easy'], mode: 'single', seed: 3, roleChoices: ['random', 'random'] }, {
    onGameStart: (i) => rec.gameStart(i), onCardPlayed() {}, onGameEnd: (i) => rec.gameEnd(i), onTournamentStart() {}, onTournamentEnd: (i) => rec.tournamentEnd(i),
  });
  check('blocked storage: game still finishes', ctl.isFinished());
}

// ---------- analytics ----------
{
  const FORBIDDEN = /winner|whale|role|result|outcome|score|ahab/i;
  const calls = [];
  globalThis.window = { gtag: (...a) => calls.push(a), addEventListener() {} };
  analytics._reset();
  const hooks = {
    onGameStart: (i) => analytics.trackGameStart(i), onCardPlayed: (i) => analytics.trackCardPlayed(i),
    onGameEnd: (i) => analytics.trackGameEnd(i), onTournamentStart: (i) => analytics.trackTournamentStart(i), onTournamentEnd: (i) => analytics.trackTournamentEnd(i),
  };
  runSession({ seats: ['hard', 'medium'], mode: 'single', seed: 11, roleChoices: ['random', 'random'] }, hooks);
  runSession({ seats: ['easy', 'easy'], mode: 'tournament', seed: 12, roleChoices: ['random', 'random'] }, hooks);
  analytics.trackStatsViewed(); analytics.trackStatsExported('csv'); analytics.trackRulesOpened('pdf');
  const names = calls.map((c) => c[1]);
  check('analytics: every call is an event', calls.every((c) => c[0] === 'event'));
  for (const n of ['game_start', 'game_end', 'tournament_start', 'tournament_end', 'stats_viewed', 'stats_exported', 'rules_opened']) {
    check(`analytics: ${n} fired`, names.includes(n));
  }
  check('analytics: every event name is known', names.every((n) => analytics.EVENT_NAMES.includes(n)));
  const allKeys = new Set(calls.flatMap((c) => Object.keys(c[2])));
  check('analytics: params are a subset of the whitelist', [...allKeys].every((k) => analytics.ALLOWED_PARAMS.includes(k)), [...allKeys].join(','));
  check('analytics: no result keys (winner/whale/role/score)', [...allKeys].every((k) => k === 'game_name' || !FORBIDDEN.test(k)), [...allKeys].join(','));
  check('analytics: no result values either', calls.every((c) => Object.values(c[2]).every((v) => typeof v !== 'object' && !/ahab|winner/i.test(String(v)) || v === 'ahab-and-the-whale')));
  const gs = calls.find((c) => c[1] === 'game_start')[2];
  check('analytics: game_start params', gs.game_name === 'ahab-and-the-whale' && gs.mode === 'single' && gs.human_players === 0 && gs.bot_players === 2 && gs.bot_levels === 'hard,medium' && gs.game_number === undefined, JSON.stringify(gs));
  const ge = calls.find((c) => c[1] === 'game_end')[2];
  check('analytics: game_end has 12 tricks and a duration', ge.tricks === 12 && Number.isInteger(ge.duration_seconds));
  const tgames = calls.filter((c) => c[1] === 'game_start' && c[2].mode === 'tournament').map((c) => c[2].game_number);
  check('analytics: tournament games are numbered 1..n', tgames.length >= 3 && tgames.every((n, i) => n === i + 1), tgames.join(','));
  const te = calls.find((c) => c[1] === 'tournament_end')[2];
  check('analytics: tournament_end games_played matches', te.games_played === tgames.length && te.bot_levels === 'easy,easy');
  check('analytics: game_end fires once per game', calls.filter((c) => c[1] === 'game_end').length === 1 + tgames.length);
  check('analytics: stats_exported format', calls.find((c) => c[1] === 'stats_exported')[2].format === 'csv' && calls.find((c) => c[1] === 'rules_opened')[2].where === 'pdf');

  // unknown params are dropped, never forwarded
  calls.length = 0;
  analytics.trackStatsExported('csv');
  // (track() is private; prove the filter through a hook that carries extra info keys)
  analytics.trackGameStart({ mode: 'single', seats: ['human', 'easy'], winnerRole: 'ahab', whale: { x: 1 } });
  check('analytics: extra info keys never reach gtag', calls.every((c) => Object.keys(c[2]).every((k) => analytics.ALLOWED_PARAMS.includes(k))));
  const hb = calls.find((c) => c[1] === 'game_start')[2];
  check('analytics: human + bot seat counts', hb.human_players === 1 && hb.bot_players === 1 && hb.bot_levels === 'easy');
  const hh = (analytics.trackGameStart({ mode: 'single', seats: ['human', 'human'] }), calls[calls.length - 1][2]);
  check('analytics: no bots reads "none"', hh.bot_levels === 'none' && hh.human_players === 2);

  // abandonment: pagehide handler
  let pagehide = null;
  globalThis.window = { gtag: (...a) => calls.push(a), addEventListener: (n, f) => { if (n === 'pagehide') pagehide = f; } };
  analytics.installAbandonTracking();
  calls.length = 0;
  analytics.trackGameStart({ mode: 'single', seats: ['human', 'easy'] });
  pagehide();
  const ab = calls.find((c) => c[1] === 'game_abandoned');
  check('analytics: pagehide mid-game fires game_abandoned', !!ab);
  const abKeys = Object.keys(ab ? ab[2] : {}).filter((k) => !analytics.ALLOWED_PARAMS.includes(k));
  check('analytics: abandonment adds only the beacon transport directive', abKeys.length === 1 && abKeys[0] === 'transport_type');
  calls.length = 0;
  pagehide();
  check('analytics: abandonment fires once', calls.length === 0);

  // no gtag: silent
  globalThis.window = {};
  let threw = false;
  try { analytics.trackGameStart({ mode: 'single', seats: ['human', 'easy'] }); analytics.trackGameEnd({}); analytics.trackStatsViewed(); } catch { threw = true; }
  check('analytics: no gtag is a silent no-op', !threw);
  globalThis.window = { gtag() { throw new Error('boom'); } };
  try { analytics.trackGameStart({ mode: 'single', seats: ['human', 'easy'] }); } catch { threw = true; }
  check('analytics: a throwing gtag never reaches the caller', !threw);
  delete globalThis.window;
}

// ---------- bug report ----------
{
  _resetLogs();
  const st = fakeStorage();
  globalThis.localStorage = st;
  globalThis.window = { innerWidth: 800, innerHeight: 600, devicePixelRatio: 2 };
  globalThis.location = { href: 'http://x/?seed=1' };
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'test-agent' }, configurable: true });

  const ctl = createController({ seats: [{ type: 'human' }, { type: 'easy' }], roleChoices: ['ahab', 'whale'], mode: 'single', seed: 21, names: ['You', 'Easy bot'] });
  ctl.runBots();
  const before = JSON.stringify(ctl.state);
  for (let i = 0; i < 70; i++) logAction({ seat: 0, card: 'N1', n: i });
  logEvent('refused-click', 'x');
  const r = buildReport({ ctl, screen: 'game' }, { title: 'Stuck', happened: 'it hung', expected: 'it moves' });
  check('bug: state not mutated', JSON.stringify(ctl.state) === before);
  check('bug: valid JSON round trip', JSON.stringify(JSON.parse(JSON.stringify(r))) === JSON.stringify(r));
  check('bug: header fields', r.schemaVersion === 1 && /^ahab-\d{8}-\d{6}-[a-z0-9]+$/.test(r.id) && !Number.isNaN(Date.parse(r.timestamp)));
  check('bug: environment', r.environment.url === 'http://x/?seed=1' && r.environment.userAgent === 'test-agent' && r.environment.viewport.width === 800 && r.environment.devicePixelRatio === 2);
  check('bug: player words', r.player.title === 'Stuck' && r.player.whatHappened === 'it hung' && r.player.whatIExpected === 'it moves');
  check('bug: full game state included', r.game && r.game.kind === 'game' && r.game.hands && r.game.tricks);
  check('bug: controller seats', r.controller.seats[0].type === 'human' && r.controller.seed === 21);
  const d = r.diagnostics;
  check('bug: diagnostics for the human seat', d && d.seat === 0 && d.cards.length === r.game.hands[0].length && Array.isArray(d.legalCards));
  check('bug: a block reason for each illegal card, null for each legal one', d.cards.every((c) => (d.legalCards.includes(c.card) ? c.blockReason === null : typeof c.blockReason === 'string')));
  check('bug: action log capped at 60, newest kept', r.actionLog.length === 60 && r.actionLog[59].n === 69);
  check('bug: event log has the refusal', r.eventLog.some((e) => e.kind === 'refused-click'));
  check('bug: mailto address is the contact address', BUG_REPORT_EMAIL === 'info@wombatgamefactory.com');
  const none = buildReport({ ctl: null, screen: 'landing' }, {});
  check('bug: works on the landing page (no game)', none.game === null && none.diagnostics === null && none.schemaVersion === 1);
  const broken = buildReport({ ctl: { get state() { throw new Error('x'); } } }, {});
  check('bug: a failing section becomes an error, not a throw', broken && broken.schemaVersion === 1 && broken.game && broken.game.error);

  for (let i = 0; i < ARCHIVE_MAX + 5; i++) archiveReport({ ...none, id: `r${i}` });
  const arch = loadArchive();
  check('bug: archive capped at 20, oldest evicted', arch.length === ARCHIVE_MAX && arch[0].id === 'r5');
  globalThis.localStorage = { getItem: throwing, setItem: throwing, removeItem: throwing };
  check('bug: archive tolerates blocked storage', archiveReport(none) === false && loadArchive().length === 0);
  delete globalThis.localStorage; delete globalThis.window; delete globalThis.location;
}

done();
