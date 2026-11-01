// sim-report.mjs - summarises one or more sim.mjs JSON files (several = side-by-side comparison).
//
//   node tests/sim-report.mjs tests/tmp/a.json [tests/tmp/b.json ...] [--md]
//
// Game files: Ahab win rate with Wilson 95% CI, first-leader effect, excitement measures, a heatmap of final
// whale cells. Tournament files: length distribution, seat-0 win rate, game-1 role effect.
// Definitions follow the Python simulator this one was checked against: brink = a trick ends one
// step inside the open sea; late = the winning side differed after any of the last 3 tricks; freeze = a run of
// 3 or more still tricks.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function wilson(k, n, z = 1.96) {
  if (n <= 0) return [0, 0];
  const p = k / n; const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
const pct = (x) => `${(x * 100).toFixed(1)}`;
const ci = (k, n) => { const [lo, hi] = wilson(k, n); return `${pct(k / n)} [${pct(lo)}, ${pct(hi)}]`; };
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const share = (games, f) => games.filter(f).length / games.length;

/** Computes every number the report shows for a game file. */
export function summariseGames(data) {
  const gs = data.games; const n = gs.length;
  const ahab = gs.filter((g) => g.winner === 'ahab').length;
  const byLeader = (role) => { const s = gs.filter((g) => g.firstLeader === role); return { n: s.length, ahab: s.filter((g) => g.winner === 'ahab').length }; };
  const lA = byLeader('ahab'); const lW = byLeader('whale');
  const size = data.meta.rules.GRID_SIZE;
  const heat = Array.from({ length: size }, () => Array(size).fill(0));
  for (const g of gs) heat[g.cell[1]][g.cell[0]]++;
  const tricksTotal = gs.reduce((s, g) => s + g.tricks, 0);
  return {
    n, ahab, lA, lW, heat, size,
    meanTricks: mean(gs.map((g) => g.tricks)),
    stillShare: gs.reduce((s, g) => s + g.still, 0) / tricksTotal,
    freezeShare: share(gs, (g) => g.freezes > 0),
    driftShare: gs.reduce((s, g) => s + g.drift, 0) / tricksTotal,
    followerShare: gs.reduce((s, g) => s + g.followerWon, 0) / tricksTotal,
    brinkGames: share(gs, (g) => g.brink),
    brinkEscape: gs.filter((g) => g.brink && g.winner === 'ahab').length / Math.max(1, gs.filter((g) => g.brink).length),
    meanBrink: mean(gs.map((g) => g.brinkTricks)),
    lateShare: share(gs, (g) => g.late),
    meanDecided: mean(gs.map((g) => g.decidedAt)),
    decidedLast: share(gs, (g) => g.decidedAt >= g.tricks - 2),
    whaleOpenSea: share(gs, (g) => g.winner === 'whale'),
  };
}

export function summariseTournaments(data) {
  const ts = data.games; const n = ts.length;
  const lengths = {};
  for (const t of ts) lengths[t.length] = (lengths[t.length] || 0) + 1;
  const seat0 = ts.filter((t) => t.seatWinner === 0).length;
  const g1 = ts.filter((t) => t.seat0Role1 === 'ahab'); // seat 0 started as Ahab
  const g1Ahab = g1.filter((t) => t.seatWinner === 0).length;
  const g1Whale = ts.filter((t) => t.seat0Role1 === 'whale').filter((t) => t.seatWinner === 0).length;
  const allGames = ts.flatMap((t) => t.games);
  const gameAhab = allGames.filter((g) => g.winner === 'ahab').length;
  return {
    n, lengths, seat0, meanLength: mean(ts.map((t) => t.length)),
    g1n: g1.length, g1Ahab, g1Whale, g1WhaleN: n - g1.length,
    gamesN: allGames.length, gameAhab,
  };
}

function heatText(S, label) {
  const total = S.n;
  const lines = [`Final whale cell, % of games (${label}); row 0 = north edge:`];
  const w = 5;
  lines.push('     ' + Array.from({ length: S.size }, (_, x) => String(x).padStart(w)).join(''));
  for (let y = 0; y < S.size; y++) {
    lines.push(` ${y}   ` + S.heat[y].map((v) => (v === 0 ? '.' : ((v / total) * 100).toFixed(1)).padStart(w)).join(''));
  }
  return lines.join('\n');
}

function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const fmt = (r) => '| ' + r.map((c, i) => String(c).padEnd(widths[i])).join(' | ') + ' |';
  return [fmt(headers), '| ' + widths.map((w) => '-'.repeat(w)).join(' | ') + ' |', ...rows.map(fmt)].join('\n');
}

export function labelOf(data, file) {
  const m = data.meta;
  const who = m.mode === 'game' ? `${m.ahab}(A) v ${m.whale}(W)` : `${m.seat0} v ${m.seat1}`;
  const c = Object.entries(m.consts || {}).map(([k, v]) => `${k}=${v}`).join(' ');
  return `${who}${m.jitter ? ` j${m.jitter}` : ''}${c ? ` ${c}` : ''}`;
}

export function report(files) {
  const out = [];
  const loaded = files.map((f) => ({ f, data: JSON.parse(readFileSync(f, 'utf8')) }));
  const gameFiles = loaded.filter((x) => x.data.meta.mode === 'game');
  const tourFiles = loaded.filter((x) => x.data.meta.mode === 'tournament');

  if (gameFiles.length) {
    const S = gameFiles.map((x) => ({ x, s: summariseGames(x.data) }));
    out.push('== Games ==');
    const cols = ['', ...S.map(({ x }, i) => `[${i + 1}] ${labelOf(x.data)}`)];
    const row = (name, f) => [name, ...S.map(({ s }) => f(s))];
    out.push(table(cols, [
      row('games (seed)', (s) => String(s.n)),
      row('Ahab win %  [95% CI]', (s) => ci(s.ahab, s.n)),
      row('Ahab leads first: Ahab win %', (s) => `${ci(s.lA.ahab, s.lA.n)} n=${s.lA.n}`),
      row('Whale leads first: Ahab win %', (s) => `${ci(s.lW.ahab, s.lW.n)} n=${s.lW.n}`),
      row('first-leader gap (pp), z', (s) => {
        const p1 = s.lA.ahab / s.lA.n; const p2 = s.lW.ahab / s.lW.n;
        const se = Math.sqrt((p1 * (1 - p1)) / s.lA.n + (p2 * (1 - p2)) / s.lW.n);
        return `${((p1 - p2) * 100).toFixed(1)}, z=${se ? ((p1 - p2) / se).toFixed(1) : 'n/a'}`;
      }),
      row('mean tricks per game', (s) => s.meanTricks.toFixed(1)),
      row('still tricks % of tricks', (s) => pct(s.stillShare)),
      row('games with a freeze (3+ still) %', (s) => pct(s.freezeShare)),
      row('drift (follower void) % of tricks', (s) => pct(s.driftShare)),
      row('follower wins % of tricks', (s) => pct(s.followerShare)),
      row('games with a brink moment %', (s) => pct(s.brinkGames)),
      row('Ahab won, of brink games %', (s) => pct(s.brinkEscape)),
      row('mean brink tricks per game', (s) => s.meanBrink.toFixed(2)),
      row('decided late (last 3 tricks) %', (s) => pct(s.lateShare)),
      row('mean trick the result was last decided', (s) => s.meanDecided.toFixed(1)),
    ]));
    for (const { x, s } of S) out.push('', heatText(s, labelOf(x.data)));
  }

  for (const { x, s } of tourFiles.map((x) => ({ x, s: summariseTournaments(x.data) }))) {
    out.push('', `== Tournament: ${labelOf(x.data)} (${basename(x.f)}) ==`);
    out.push(`tournaments: ${s.n}; mean length ${s.meanLength.toFixed(2)} games`);
    out.push(table(['games', 'tournaments', '%'], Object.keys(s.lengths).sort().map((k) => [k, s.lengths[k], pct(s.lengths[k] / s.n)])));
    out.push(`seat 0 wins: ${ci(s.seat0, s.n)} %`);
    out.push(`seat 0 wins when it starts as Ahab: ${ci(s.g1Ahab, s.g1n)} % (n=${s.g1n}); as Whale: ${ci(s.g1Whale, s.g1WhaleN)} % (n=${s.g1WhaleN})`);
    out.push(`individual games: Ahab won ${ci(s.gameAhab, s.gamesN)} % of ${s.gamesN}`);
  }
  return out.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!files.length) { console.error('usage: node tests/sim-report.mjs file.json [file2.json ...]'); process.exit(2); }
  console.log(report(files));
}
