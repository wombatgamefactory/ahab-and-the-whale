// sim-check.mjs - the simulator is deterministic and its records are consistent.
// ~200 fast games twice with the same seed give identical JSON; every game terminates and every
// record's final cell agrees with its winner; a tournament run does the same; bad constants are refused.
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure.

import { parseArgs, runSim } from './sim.mjs';
import { report } from './sim-report.mjs';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite } from './lib.mjs';

const { check, done } = suite('sim-check');
const run = (argv) => runSim(parseArgs(argv)).games;

// ---- game mode: determinism, termination, winner/cell agreement ----
for (const argv of [
  ['--ahab=easy', '--whale=easy', '--games=100', '--seed=7'],
  ['--ahab=medium', '--whale=easy', '--games=60', '--seed=7', '--jitter=10'],
  ['--ahab=medium', '--whale=medium', '--games=40', '--seed=9', '--const.HAND_SIZE=11'],
]) {
  const a = JSON.stringify(run(argv));
  const b = JSON.stringify(run(argv));
  check(`same seed, same JSON (${argv.slice(0, 2).join(' ')} ${argv.slice(3).join(' ')})`, a === b);
  const games = JSON.parse(a);
  const handSize = argv.includes('--const.HAND_SIZE=11') ? 11 : 12;
  check('every game terminated with all tricks played', games.every((g) => g.tricks === handSize && g.path.length === handSize));
  const ok = games.every((g) => {
    const [x, y] = g.cell; const last = g.path[g.path.length - 1];
    const open = x === 0 || y === 0 || x === 6 || y === 6;
    return last[0] === x && last[1] === y && g.winner === (open ? 'whale' : 'ahab');
  });
  check('final cell agrees with winner (open sea = Whale)', ok);
}
check('different seeds differ', JSON.stringify(run(['--games=30', '--seed=1', '--ahab=easy', '--whale=easy'])) !== JSON.stringify(run(['--games=30', '--seed=2', '--ahab=easy', '--whale=easy'])));

// ---- tournament mode ----
{
  const argv = ['--mode=tournament', '--seat0=medium', '--seat1=easy', '--games=30', '--seed=3'];
  const a = JSON.stringify(run(argv)); const b = JSON.stringify(run(argv));
  check('tournaments deterministic', a === b);
  const ts = JSON.parse(a);
  check('tournaments end with a seat on 3 wins in 3..5 games', ts.every((t) => t.length >= 3 && t.length <= 5 && t.wins[t.seatWinner] === 3 && t.games.length === t.length));
}

// ---- refusals and the report ----
{
  let threw = 0;
  for (const bad of [['--const.HAND_SIZE=abc'], ['--const.NOPE=1'], ['--const.VOID_RULE=calm_pass'], ['--ahab=genius']]) {
    try { parseArgs(bad); } catch { threw++; }
  }
  check('bad constants and bot names are refused', threw === 4, `${threw}/4`);

  const dir = mkdtempSync(join(tmpdir(), 'sim-check-'));
  try {
    const f = join(dir, 'a.json');
    const a = parseArgs(['--ahab=easy', '--whale=easy', '--games=20', '--seed=1']);
    writeFileSync(f, JSON.stringify({ meta: { mode: 'game', ahab: 'easy', whale: 'easy', jitter: 0, consts: {}, rules: a.rules }, games: runSim(a).games }));
    const text = report([f]);
    check('report prints win rate and heatmap', /Ahab win %/.test(text) && /Final whale cell/.test(text));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

done();
