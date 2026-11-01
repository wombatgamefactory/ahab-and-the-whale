// conformance.mjs - replays games recorded by the Python simulator and requires the same
// legal-option counts, whale cells, trick winners and final winner.
// Fixtures: tests/fixtures/python-conformance.json, made from the Python simulator's engine
// under rule book v3 plus variant sets (the generator script is not part of this repo).
// Semantics: PERMANENTLY GREEN. Exit 1 on any mismatch.

import { readFileSync } from 'node:fs';
import { createGame, applyAction, getValidActions } from '../src/engine/index.js';
import { suite } from './lib.mjs';

const { check, done } = suite('conformance');
const data = JSON.parse(readFileSync(new URL('./fixtures/python-conformance.json', import.meta.url), 'utf8'));
const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';

let games = 0;
let mismatches = 0;
for (const set of data.sets) {
  let setBad = 0;
  set.games.forEach((fx, i) => {
    const label = `${set.name} #${i}`;
    const problems = [];
    try {
      const g = createGame({
        seed: 0,
        roles: ['ahab', 'whale'],
        rules: set.rules,
        firstLeader: fx.first === 'ahab' ? 0 : 1,
        deal: { hands: [fx.ahab.split(' '), fx.whale.split(' ')] },
      });
      const plays = fx.plays.split(' ');
      plays.forEach((card, k) => {
        const n = getValidActions(g).length;
        if (B36[n] !== fx.legal[k] && problems.length < 3) problems.push(`decision ${k + 1}: ${n} legal, python ${B36.indexOf(fx.legal[k])}`);
        applyAction(g, { type: 'play', card });
      });
      const cells = g.tricks.map((t) => `${t.to.x}${t.to.y}`).join(' ');
      const winners = g.tricks.map((t) => (g.roles[t.winner] === 'ahab' ? 'A' : 'W')).join('');
      if (cells !== fx.cells) problems.push(`whale cells ${cells} vs python ${fx.cells}`);
      if (winners !== fx.winners) problems.push(`trick winners ${winners} vs python ${fx.winners}`);
      if (g.phase !== 'over') problems.push('game not over after the recorded plays');
      else if (g.result.winnerRole !== fx.winner) problems.push(`winner ${g.result.winnerRole} vs python ${fx.winner}`);
    } catch (e) {
      problems.push(`threw: ${e.message}`);
    }
    games++;
    if (problems.length) { mismatches++; setBad++; }
    check(label, problems.length === 0, problems.join('; '));
  });
  console.log(`  ${set.name}: ${set.games.length} games, ${setBad} mismatches`);
}
check('fixtures present (>= 200 games)', games >= 200, `${games}`);
console.log(`conformance: ${games} games replayed, ${mismatches} mismatches`);
done();
