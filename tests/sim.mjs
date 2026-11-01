// sim.mjs - headless bot-v-bot simulator for balance work.
//
//   node tests/sim.mjs --ahab=medium --whale=medium --games=2000 --seed=1 [--jitter=5]
//        [--mode=game|tournament] [--seat0=medium --seat1=hard] [--const.HAND_SIZE=11] [--out=path]
//
//  --ahab / --whale   bot level for each ROLE (easy | medium | hard). Game mode.
//  --seat0 / --seat1  bot level for each SEAT. Tournament mode (roles swap between games, R7.2).
//  --games=N          games (game mode) or tournaments (tournament mode).
//  --seed=S           run seed; game i uses deriveSeed(S,'game',i); bot streams are separate from the game RNG.
//  --jitter=N         N percent chance per decision that the bot plays a random legal card instead of its
//                     own choice (a noise floor; stops the two seats being copies of one function). Default 0.
//  --const.NAME=VALUE any constant of the VARIANTS table, type-checked by the engine's resolver.
//  --out=path         JSON output (default tests/tmp/sim-<auto-name>.json).
//
// Deterministic for a fixed argument list: the JSON holds no clock values (timing goes to stderr).
// Seats alternate across runs (game i: Ahab in seat 0 when i is even) so seat artefacts cancel.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createGame, createTournament, applyAction, startNextGame, viewFor, legalActionsFromView, toActOf,
  makeRng, deriveSeed, rngInt, rngNext, VARIANTS, resolveVariants, centreDistance, inHarpoonRange,
} from '../src/engine/index.js';
import { getBot, botLevels } from '../src/bots/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------- arguments ----------
export function parseArgs(argv) {
  const a = { ahab: 'medium', whale: 'medium', seat0: 'medium', seat1: 'medium', games: 1000, seed: 1, jitter: 0, mode: 'game', out: null, consts: {} };
  for (const raw of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(raw);
    if (!m) throw new Error(`Bad argument "${raw}" (use --name=value)`);
    const [, key, val] = m;
    if (key.startsWith('const.')) {
      const name = key.slice(6);
      const def = VARIANTS.find((v) => v.name === name);
      if (!def) throw new Error(`Unknown constant "${name}". Known: ${VARIANTS.map((v) => v.name).join(', ')}`);
      if (def.type === 'integer') a.consts[name] = Number(val);
      else if (def.type === 'boolean') a.consts[name] = val === 'true';
      else a.consts[name] = def.values.find((x) => String(x) === val) ?? val;
    } else if (['ahab', 'whale', 'seat0', 'seat1', 'mode', 'out'].includes(key)) a[key] = val;
    else if (['games', 'seed', 'jitter'].includes(key)) {
      a[key] = key === 'seed' && !/^\d+$/.test(val) ? val : Number(val);
      if (key !== 'seed' && !Number.isFinite(a[key])) throw new Error(`--${key} must be a number`);
    } else throw new Error(`Unknown option --${key}`);
  }
  if (!['game', 'tournament'].includes(a.mode)) throw new Error('--mode must be game or tournament');
  const known = botLevels().map((l) => l.id);
  for (const k of ['ahab', 'whale', 'seat0', 'seat1']) if (!known.includes(a[k])) throw new Error(`--${k}: unknown bot "${a[k]}" (${known.join(', ')})`);
  if (a.jitter < 0 || a.jitter > 100) throw new Error('--jitter is a percentage 0..100');
  a.rules = resolveVariants(a.consts); // throws on a bad value
  return a;
}

function defaultOut(a) {
  const who = a.mode === 'game' ? `${a.ahab}-v-${a.whale}` : `t-${a.seat0}-v-${a.seat1}`;
  const consts = Object.entries(a.consts).map(([k, v]) => `${k.toLowerCase().replace(/_/g, '-')}-${v}`).join('-');
  const name = `sim-${a.mode}-${who}-n${a.games}-s${a.seed}${a.jitter ? `-j${a.jitter}` : ''}${consts ? `-${consts}` : ''}.json`;
  return resolve(HERE, 'tmp', name);
}

// ---------- recording ----------
/** One compact record from a finished game state. */
export function recordGame(g) {
  const rules = g.rules;
  const c = Math.floor(rules.GRID_SIZE / 2);
  const tricks = g.tricks;
  const path = tricks.map((t) => [t.to.x, t.to.y]);
  let still = 0; let run = 0; let maxStill = 0; let freezes = 0; let brinkTricks = 0; let drift = 0; let followerWon = 0;
  const closeRun = () => { if (run >= 3) freezes++; run = 0; };
  for (const t of tricks) {
    const moved = t.from.x !== t.to.x || t.from.y !== t.to.y;
    if (!moved) { still++; run++; if (run > maxStill) maxStill = run; } else closeRun();
    if (centreDistance(t.to, rules) === c - 1) brinkTricks++;
    if (!t.followed) drift++;
    if (t.winner === t.follower) followerWon++;
  }
  closeRun();
  // Whose side is winning after each trick: whale wins unless in harpoon range (Python in_range definition).
  const ahabWinning = (cell) => inHarpoonRange({ x: cell[0], y: cell[1] }, rules);
  const status = [true, ...path.map(ahabWinning)]; // index 0 = start cell
  const final = status[status.length - 1];
  let decidedAt = 0;
  for (let k = 1; k < status.length; k++) if (status[k] !== status[k - 1]) decidedAt = k;
  // Python late_decision: status before the third-last trick or after any of the last 3 differs from the final one.
  const n = tricks.length;
  let late = false;
  for (let k = Math.max(0, n - 3); k < n; k++) if (status[k] !== final) late = true;
  return {
    winner: g.result.winnerRole,
    reason: g.result.reason,
    cell: [g.whale.x, g.whale.y],
    path,
    firstLeader: g.roles[g.firstLeader],
    tricks: n,
    still, maxStill, freezes,
    brink: brinkTricks > 0, brinkTricks,
    decidedAt, late,
    drift, followerWon,
  };
}

// ---------- playing ----------
function makeChooser(level, jitter, rngBot, rngJit) {
  const bot = getBot(level);
  return (view) => {
    if (jitter > 0 && rngNext(rngJit) * 100 < jitter) {
      const legal = legalActionsFromView(view);
      return legal[rngInt(rngJit, legal.length)];
    }
    return bot.chooseAction(view, rngBot);
  };
}

function playToEnd(state, choosers, onGameEnd) {
  let guard = 0;
  while (toActOf(state) !== null || state.phase === 'between') {
    if (state.phase === 'between') { startNextGame(state); continue; }
    const seat = toActOf(state);
    const act = choosers[seat](viewFor(state, seat));
    applyAction(state, act, { silent: true });
    if (++guard > 5000) throw new Error('livelock');
    if (state.kind === 'tournament' && state.game.phase === 'over' && onGameEnd) onGameEnd(state.game);
    if (state.kind === 'game' && state.phase === 'over') onGameEnd?.(state);
  }
}

export function runSim(a) {
  const games = [];
  const t0 = Date.now();
  for (let i = 0; i < a.games; i++) {
    const seed = deriveSeed(a.seed, 'game', i);
    const mk = (seat, level) => makeChooser(level, a.jitter, makeRng(deriveSeed(seed, 'bot', seat)), makeRng(deriveSeed(seed, 'jitter', seat)));
    if (a.mode === 'game') {
      const ahabSeat = i % 2 === 0 ? 0 : 1;
      const roles = ahabSeat === 0 ? ['ahab', 'whale'] : ['whale', 'ahab'];
      const g = createGame({ seed, roles, rules: a.consts });
      const choosers = [mk(0, roles[0] === 'ahab' ? a.ahab : a.whale), mk(1, roles[1] === 'ahab' ? a.ahab : a.whale)];
      playToEnd(g, choosers, null);
      games.push(recordGame(g));
    } else {
      const roles = i % 2 === 0 ? ['ahab', 'whale'] : ['whale', 'ahab'];
      const t = createTournament({ seed, roles, rules: a.consts });
      const rec = [];
      playToEnd(t, [mk(0, a.seat0), mk(1, a.seat1)], (g) => rec.push({ roles: [...g.roles], ...recordGame(g) }));
      games.push({
        length: t.history.length,
        seatWinner: t.winnerSeat,
        seat0Role1: roles[0],
        wins: [...t.wins],
        games: rec.map((r) => ({ roles: r.roles, winner: r.winner, cell: r.cell, firstLeader: r.firstLeader })),
      });
    }
  }
  return { games, ms: Date.now() - t0 };
}

// ---------- main ----------
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const a = parseArgs(process.argv.slice(2));
    const { games, ms } = runSim(a);
    const out = a.out ? resolve(a.out) : defaultOut(a);
    const meta = { tool: 'ahab-sim', version: 1, mode: a.mode, games: a.games, seed: a.seed, jitter: a.jitter, rules: a.rules, consts: a.consts,
      ...(a.mode === 'game' ? { ahab: a.ahab, whale: a.whale } : { seat0: a.seat0, seat1: a.seat1 }) };
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify({ meta, games }) + '\n');
    console.error(`${a.games} ${a.mode === 'game' ? 'games' : 'tournaments'} in ${(ms / 1000).toFixed(1)}s`);
    console.log(out);
  } catch (e) {
    console.error(`sim: ${e.message}`);
    process.exit(2);
  }
}
