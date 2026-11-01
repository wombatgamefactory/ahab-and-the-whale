// bots.mjs - the Easy / Medium / Hard bots: legality, determinism, fidelity to the Python sim, strength.
//
//  1. registry: easy, medium, hard are registered with labels.
//  2. legality: 500 games for every pairing of {easy, medium}, 25 for pairings with hard: every
//     proposal is a legal action from the view, zero refusals, the view is not mutated.
//  3. determinism: same seed and levels -> identical game; same view and rng -> same action.
//  4. variants: medium and hard play legally under the variant rules this engine implements.
//  5. Medium v the Python GreedyBot: tests/fixtures/python-greedy-decisions.json holds Python
//     greedy-v-greedy games (rule book v3 + variants); the JS bot must choose the same card at every
//     decision (generator: tests/tmp/make-greedy-fixture.py, run against the sim, read-only).
//  6. Hard's rollout simulator agrees with the engine (legal cards, whale cell, voids, trick winners).
//  7. strength: Medium beats Easy and Hard beats Medium in the same role against the same opponent,
//     by a margin that is significant (z >= 3) at the game counts used.
//  8. controller: medium v hard single game and tournament through the controller, no refusals.
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createGame, applyAction, viewFor, legalActionsFromView, getValidActions, getActionBlockReason, toActOf,
  makeRng, deriveSeed, determinise, shownVoids, rngNext,
} from '../src/engine/index.js';
import { getBot, botLevels } from '../src/bots/index.js';
import { GREEDY_PARAMS, cardObj, roleIndex, greedyModelFor } from '../src/bots/greedy.js';
import { LOOKAHEAD_PARAMS, lookaheadInternals } from '../src/bots/lookahead.js';
import { createController } from '../src/ui/controller.js';
import { suite } from './lib.mjs';

const { check, done } = suite('bots');
const startedAt = Date.now(); // a test file may read the clock; src/ may not

/** Plays one game with bots; returns { state, refusals, illegal, mutated, actions }. */
function playGame({ levels, seed, roles = ['ahab', 'whale'], rules = {}, firstLeader = null }) {
  const state = createGame({ seed, roles, rules, firstLeader });
  const rngs = [makeRng(deriveSeed(seed, 'bot', 0)), makeRng(deriveSeed(seed, 'bot', 1))];
  let refusals = 0; let illegal = 0; let mutated = 0; let actions = 0;
  while (toActOf(state) !== null && actions < 100) {
    const seat = toActOf(state);
    const view = viewFor(state, seat);
    const before = JSON.stringify(view);
    const act = getBot(levels[seat]).chooseAction(view, rngs[seat]);
    if (JSON.stringify(view) !== before) mutated++;
    if (!legalActionsFromView(view).some((a) => a.type === act.type && a.card === act.card)) illegal++;
    if (getActionBlockReason(state, act) !== null) { refusals++; break; }
    applyAction(state, act, { silent: true });
    actions++;
  }
  return { state, refusals, illegal, mutated, actions };
}

// ---------- 1. registry ----------
{
  const levels = botLevels();
  const ids = levels.map((l) => l.id);
  check('registry has easy, medium, hard', ['easy', 'medium', 'hard'].every((x) => ids.includes(x)), ids.join(','));
  check('labels are Easy / Medium / Hard', ['Easy', 'Medium', 'Hard'].every((x) => levels.some((l) => l.label === x)));
}

// ---------- 2. legality sweep ----------
{
  const cheap = ['easy', 'medium'];
  let games = 0; let refusals = 0; let illegal = 0; let mutated = 0; let unfinished = 0;
  const run = (a, b, n) => {
    for (let i = 0; i < n; i++) {
      const r = playGame({ levels: [a, b], seed: deriveSeed('legal', a, b, i) });
      games++; refusals += r.refusals; illegal += r.illegal; mutated += r.mutated;
      if (r.state.phase !== 'over' || r.actions !== 24) unfinished++;
    }
  };
  for (const a of cheap) for (const b of cheap) run(a, b, 500);
  for (const [a, b] of [['hard', 'easy'], ['easy', 'hard'], ['hard', 'medium'], ['medium', 'hard'], ['hard', 'hard']]) run(a, b, 25);
  check(`${games} games (4 x 500 easy/medium pairings, 5 x 25 with hard) all finish in 24 actions`, unfinished === 0, `${unfinished} unfinished`);
  check('every bot proposal is a legal action from the view', illegal === 0, `${illegal} illegal`);
  check('zero refused proposals', refusals === 0, `${refusals}`);
  check('no bot mutates its view', mutated === 0, `${mutated}`);
}

// ---------- 3. determinism ----------
{
  for (const [a, b] of [['medium', 'medium'], ['hard', 'medium'], ['medium', 'hard'], ['hard', 'hard']]) {
    const run = (seed) => JSON.stringify(playGame({ levels: [a, b], seed }).state);
    check(`same seed -> identical game (${a} v ${b})`, run('bdet-1') === run('bdet-1'));
  }
  const g = createGame({ seed: 'bdet-view' });
  for (const level of ['medium', 'hard']) {
    const view = viewFor(g, toActOf(g));
    const x = getBot(level).chooseAction(view, { s: 77 });
    const y = getBot(level).chooseAction(JSON.parse(JSON.stringify(view)), { s: 77 });
    check(`same view and rng -> same action (${level})`, JSON.stringify(x) === JSON.stringify(y));
  }
  // Medium never uses the rng (noise is 0); Hard does (determinisation), so it must advance it.
  const view = viewFor(g, toActOf(g));
  const r1 = { s: 5 };
  getBot('medium').chooseAction(view, r1);
  check('medium leaves the rng untouched', r1.s === 5);
  const r2 = { s: 5 };
  getBot('hard').chooseAction(view, r2);
  check('hard draws from the rng it is given', r2.s !== 5);
}

// ---------- 4. variants the engine implements ----------
{
  const VARIANTS = [
    { VOID_RULE: 'none' }, { VOID_RULE: 'calm' }, { LEAD_RESTRICTION: 'not_previous' },
    { LEAD_RESTRICTION: 'not_own_previous' }, { ESCAPE_CHECK: 'immediate' }, { HARPOON_RADIUS: 1 }, { GRID_SIZE: 9, HARPOON_RADIUS: 3 },
  ];
  let bad = 0; let games = 0;
  for (const rules of VARIANTS) {
    for (const [a, b, n] of [['medium', 'medium', 30], ['hard', 'medium', 4], ['medium', 'hard', 4]]) {
      for (let i = 0; i < n; i++) {
        const r = playGame({ levels: [a, b], seed: deriveSeed('var', JSON.stringify(rules), a, i), rules });
        games++;
        if (r.refusals || r.illegal || r.state.phase !== 'over') bad++;
      }
    }
  }
  check(`${games} variant games (${VARIANTS.length} rule sets) play legally to the end`, bad === 0, `${bad} bad`);
}

// ---------- 5. Medium v the Python GreedyBot ----------
{
  const fx = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/python-greedy-decisions.json', import.meta.url)), 'utf8'));
  let decisions = 0; let mismatches = 0; let games = 0; let winnerMismatch = 0; const first = [];
  for (const set of fx.sets) {
    for (const [gi, g] of set.games.entries()) {
      const state = createGame({
        seed: 1, rules: set.rules, firstLeader: g.first === 'ahab' ? 0 : 1,
        deal: { hands: [g.ahab.split(' '), g.whale.split(' ')] },
      });
      games++;
      for (const card of g.plays.split(' ')) {
        const act = getBot('medium').chooseAction(viewFor(state, toActOf(state)), { s: 1 });
        decisions++;
        if (act.card !== card) { mismatches++; if (first.length < 3) first.push(`${set.name}#${gi} trick ${state.trickNo + 1}: js ${act.card} py ${card}`); }
        applyAction(state, { type: 'play', card }, { silent: true }); // follow Python so decisions stay comparable
      }
      if (state.result.winnerRole !== g.winner) winnerMismatch++;
    }
  }
  check(`Medium picks the Python GreedyBot's card at all ${decisions} decisions (${games} games, ${fx.sets.length} rule sets)`, mismatches === 0, first.join('; '));
  check('the engine agrees with Python on the winner of every fixture game', winnerMismatch === 0, `${winnerMismatch}`);
}

// ---------- 6. Hard's rollout simulator v the engine ----------
{
  const { simFromWorld, playOut, legalFor, resolveTrick } = lookaheadInternals;
  const RULESETS = [{}, { VOID_RULE: 'none' }, { VOID_RULE: 'calm' }, { LEAD_RESTRICTION: 'not_previous' }, { LEAD_RESTRICTION: 'not_own_previous' }, { ESCAPE_CHECK: 'immediate' }];
  let steps = 0; let bad = 0; const notes = [];
  for (const [ri, rules] of RULESETS.entries()) {
    for (let i = 0; i < 25; i++) {
      const rng = makeRng(deriveSeed('sim', ri, i));
      const g = createGame({ seed: deriveSeed('simgame', ri, i), rules });
      // play a random number of random cards (0..20) on the real game, then branch
      const stop = Math.floor(rngNext(rng) * 21);
      for (let k = 0; k < stop && toActOf(g) !== null; k++) {
        const acts = getValidActions(g);
        applyAction(g, acts[Math.floor(rngNext(rng) * acts.length)], { silent: true });
      }
      if (toActOf(g) === null) continue;
      const seat = toActOf(g);
      const view = viewFor(g, seat);
      const world = determinise(view, rng);
      const model = greedyModelFor(world.rules);
      const sim = simFromWorld(world, view, world.rules);
      const N = world.rules.GRID_SIZE;
      const complain = (msg) => { bad++; if (notes.length < 4) notes.push(`rules ${JSON.stringify(rules)} game ${i}: ${msg}`); };
      while (toActOf(world) !== null) {
        const s = toActOf(world);
        const role = roleIndex(world.roles[s]);
        const leadObj = world.lead === null ? null : cardObj(world.lead);
        const simLegal = legalFor(sim, role, leadObj, world.rules).map((c) => c.id).sort().join(' ');
        const engLegal = getValidActions(world).map((a) => a.card).sort().join(' ');
        steps++;
        if (simLegal !== engLegal) { complain(`legal ${simLegal} v ${engLegal}`); break; }
        const acts = getValidActions(world);
        const act = acts[Math.floor(rngNext(rng) * acts.length)];
        applyAction(world, act, { silent: true });
        const card = cardObj(act.card);
        playOut(sim, role, card);
        if (leadObj !== null) {
          resolveTrick(sim, model, leadObj, card, 1 - role, world.rules);
          const wv = shownVoids(viewFor(world, 0));
          const vm = [0, 0];
          for (let st = 0; st < 2; st++) for (const x of wv[st]) vm[roleIndex(world.roles[st])] |= 1 << 'NESW'.indexOf(x);
          if (sim.cell !== world.whale.y * N + world.whale.x) { complain('whale cell'); break; }
          if (sim.voids[0] !== vm[0] || sim.voids[1] !== vm[1]) { complain('voids'); break; }
          if (sim.trickNo !== world.trickNo) { complain('trick count'); break; }
          if (world.phase === 'over') { if (world.result.reason === 'escape' && !sim.over) complain('escape not seen'); break; }
          if (sim.leader !== roleIndex(world.roles[world.leader])) { complain('next leader'); break; }
        }
      }
    }
  }
  check(`rollout simulator matches the engine over ${steps} steps (6 rule sets)`, bad === 0 && steps > 1000, `${bad} differences; ${notes.join('; ')}`);
}

// ---------- 7. strength ----------
/** Ahab win count over `n` games (seat 0 Ahab, seat 1 Whale), deals shared across pairings by tag. */
function ahabWins(ahabLevel, whaleLevel, n, tag) {
  let w = 0;
  for (let i = 0; i < n; i++) {
    const r = playGame({ levels: [ahabLevel, whaleLevel], seed: deriveSeed(tag, i) });
    w += r.state.result.winnerRole === 'ahab';
  }
  return w;
}
/** One-sided two-proportion z for p1 > p2. */
function zScore(x1, n1, x2, n2) {
  const p1 = x1 / n1; const p2 = x2 / n2; const p = (x1 + x2) / (n1 + n2);
  return (p1 - p2) / Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
}
const pct = (x, n) => `${((100 * x) / n).toFixed(1)}%`;
{
  const N = 1000;
  // Medium as Ahab v an Easy Whale, against Easy as Ahab v the same Easy Whale
  const mA = ahabWins('medium', 'easy', N, 'str-me');
  const eA = ahabWins('easy', 'easy', N, 'str-ee2');
  const z1 = zScore(mA, N, eA, N);
  console.log(`  Ahab wins: Medium v Easy-Whale ${pct(mA, N)}, Easy v Easy-Whale ${pct(eA, N)} (z=${z1.toFixed(1)}, ${N} games each)`);
  check('Medium as Ahab beats Easy as Ahab (same Easy Whale), z >= 3', z1 >= 3, `z=${z1.toFixed(2)}`);
  // Medium as Whale v an Easy Ahab: the Whale wins when Ahab does not
  const mW = N - ahabWins('easy', 'medium', N, 'str-em');
  const eW = N - ahabWins('easy', 'easy', N, 'str-ee3');
  const z2 = zScore(mW, N, eW, N);
  console.log(`  Whale wins: Medium v Easy-Ahab ${pct(mW, N)}, Easy v Easy-Ahab ${pct(eW, N)} (z=${z2.toFixed(1)}, ${N} games each)`);
  check('Medium as Whale beats Easy as Whale (same Easy Ahab), z >= 3', z2 >= 3, `z=${z2.toFixed(2)}`);

  // Hard v Medium: Hard games are the slow ones, so fewer of them; Medium's baselines are cheap.
  const NH = 100; const NB = 1000;
  const hA = ahabWins('hard', 'medium', NH, 'str-hm');
  const mmA = ahabWins('medium', 'medium', NB, 'str-mm');
  const z3 = zScore(hA, NH, mmA, NB);
  console.log(`  Ahab wins: Hard v Medium-Whale ${pct(hA, NH)} (${NH} games), Medium v Medium-Whale ${pct(mmA, NB)} (${NB} games), z=${z3.toFixed(1)}`);
  check('Hard as Ahab beats Medium as Ahab (same Medium Whale), z >= 3', z3 >= 3, `z=${z3.toFixed(2)}`);
  const hW = NH - ahabWins('medium', 'hard', NH, 'str-mh');
  const mmW = NB - mmA;
  const z4 = zScore(hW, NH, mmW, NB);
  console.log(`  Whale wins: Hard v Medium-Ahab ${pct(hW, NH)} (${NH} games), Medium v Medium-Ahab ${pct(mmW, NB)} (${NB} games), z=${z4.toFixed(1)}`);
  check('Hard as Whale beats Medium as Whale (same Medium Ahab), z >= 3', z4 >= 3, `z=${z4.toFixed(2)}`);
}

// ---------- 8. through the controller ----------
{
  const single = createController({ seats: [{ type: 'medium' }, { type: 'hard' }], roleChoices: ['random', 'random'], mode: 'single', seed: 4242 });
  single.runBots();
  check('controller: medium v hard single game finishes, no refusals', single.isFinished() && single.botRefusals === 0, `refusals ${single.botRefusals}`);
  const t = createController({ seats: [{ type: 'hard' }, { type: 'medium' }], roleChoices: ['ahab', 'whale'], mode: 'tournament', seed: 4343 });
  let guard = 0;
  while (!t.isFinished() && guard++ < 10) { t.runBots(); if (t.canStartNextGame()) t.startNextGame(); }
  check('controller: hard v medium tournament finishes, no refusals', t.isFinished() && t.botRefusals === 0, `refusals ${t.botRefusals}`);
}

check('constants are exported', GREEDY_PARAMS.lead_weight === 0.7 && LOOKAHEAD_PARAMS.samples >= 1);
console.log(`  bots suite took ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
done();
