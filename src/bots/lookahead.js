// lookahead.js - Hard bot: perfect-information Monte Carlo ("determinise and roll out").
//
// A port of the Python sim's LookaheadBot (research/four-winds-sim/fourwinds/bots/lookahead.py) for
// the rule paths this engine plays (see greedy.js for the list).
//
// It reads only its view. Nothing hidden is used: the opponent's hand in every simulation is a guess
// dealt by the engine's determinise(view, rng) from the cards the bot cannot place, never from the
// true game state. Stateless between calls (only pure position caches in the shared greedy model).
//
// How it plays
// ------------
// For each decision the bot draws `samples` determinisations: complete guessed deals, consistent with
// the cards played so far and with every void the opponent has shown. For each legal card and each
// deal it
//
//   1. plays that card in the guessed world (as leader the opponent answers with the rollout policy;
//      as follower the card answers the real led card),
//   2. plays out the rest of the hand (or `horizon` tricks of it) with the rollout policy for both
//      seats, and
//   3. scores the end position from its own role's point of view, as a chance of winning the game
//      (0 to 1).
//
// The card with the best average wins. The same deals are used for every candidate card (common random
// numbers), and the cards are evaluated deal by deal, so luck of the deal cancels out of the comparison.
//
// Scoring a finished rollout (Ahab's game-winning chance, flipped for the Whale)
//   * escape (immediate variant): 0 for Ahab (a certain Whale win);
//   * hand over: Greedy's position model `terminal` (in harpoon range = 1, open sea or outside = 0);
//   * horizon reached before the hand ends: Greedy's `u` utility of the cell with the tricks left;
//   * then blended with a small shaped term, shape * (1 - d / c) (d = distance of the whale from the
//     centre, c = distance to open sea), so a rollout that ends near the edge scores a little worse
//     for Ahab than one that ends near the centre even when both miss or make the range.
//
// Speed-up that does not change the answer: a single legal card is returned at once; cards that no
// unknown card separates within a suit are interchangeable, so only the lowest of each such run is
// searched.
//
// The rollouts use a compact internal simulator (hands as card objects, ranks as bitmasks) instead of
// the engine's state, because they run thousands of tricks per decision. It replays the same trick
// rules as engine/actions.js; tests/bots.mjs checks it against the engine.

import { determinise, legalActionsFromView, unknownCards, legalCards, shownVoids, rngNext, forkRng } from '../engine/index.js';
import { cardObj, roleIndex, popcount, greedyModelFor, greedyBot } from './greedy.js';

/**
 * Tuning constants (Python names and comments kept).
 *
 * samples (30)          Determinisations per decision.  More = steadier and slower (cost is linear).
 *                       [The Python default is 30; see the timing note in the report/README for the
 *                       browser budget.]
 * rollout ("greedy")    Policy both seats follow in the simulated rest of the hand: "greedy" (the
 *                       Medium heuristic, honest views of the guessed world) or "random".
 * horizon (null)        Tricks to simulate, counting the current one.  null = to the end of the hand.
 *                       A short horizon scores the cell reached with Greedy's `u` utility.
 * shape (0.1)           Weight of the shaped distance term (0 = pure game-win estimate).
 * greedy_bonus (0.0)    Added to the value of the card Medium would play (a prior that damps noise
 *                       with few samples; 0 = off).
 * prune (true)          Skip interchangeable cards (see above).
 *
 * (The Python time_budget / min_samples knobs make play depend on the clock, so they are left out:
 * this module has no clock. hand_win_prior is unused with one hand per game.)
 */
export const LOOKAHEAD_PARAMS = {
  samples: 30,
  rollout: 'greedy',
  horizon: null,
  shape: 0.1,
  greedy_bonus: 0.0,
  prune: true,
};

const STILL = -1;

// ---------- the rollout simulator (by role: 0 Ahab, 1 Whale) ----------

function simFromWorld(world, view, rules) {
  const sim = {
    hands: [null, null],
    own: new Int32Array(8), // [role * 4 + suit] bitmask of the ranks that role holds
    played: new Int32Array(4), // bitmask of ranks played (including a card led this trick)
    voids: [0, 0],
    cell: view.whale.y * rules.GRID_SIZE + view.whale.x,
    trickNo: view.trickNo,
    leader: roleIndex(view.roles[view.leader]),
    lastLead: null, // card object led on the previous trick (lead restriction only)
    lastLeader: -1, // role who led it
    over: false,
  };
  for (let seat = 0; seat < 2; seat++) {
    const role = roleIndex(world.roles[seat]);
    sim.hands[role] = world.hands[seat].map(cardObj);
    for (const c of sim.hands[role]) sim.own[role * 4 + c.suit] |= 1 << c.rank;
  }
  const full = fullMasks(rules.MAX_RANK);
  const unused = [0, 0, 0, 0]; // the guessed unused pile
  for (const id of world.unused) { const c = cardObj(id); unused[c.suit] |= 1 << c.rank; }
  // played = every card that is in neither hand nor the unused pile (includes a card led this trick)
  for (let s = 0; s < 4; s++) sim.played[s] = full[s] & ~sim.own[s] & ~sim.own[4 + s] & ~unused[s];
  const voids = shownVoids(view);
  for (let seat = 0; seat < 2; seat++) {
    let m = 0;
    for (const s of voids[seat]) m |= 1 << 'NESW'.indexOf(s);
    sim.voids[roleIndex(view.roles[seat])] = m;
  }
  if (view.tricks.length) {
    const last = view.tricks[view.tricks.length - 1];
    sim.lastLead = cardObj(last.lead);
    sim.lastLeader = roleIndex(view.roles[last.leader]);
  }
  return sim;
}

function fullMasks(maxRank) {
  const m = ((1 << (maxRank + 1)) - 1) & ~1; // bits 1..maxRank
  return [m, m, m, m];
}

function cloneSim(sim) {
  return {
    hands: [sim.hands[0].slice(), sim.hands[1].slice()],
    own: sim.own.slice(),
    played: sim.played.slice(),
    voids: [sim.voids[0], sim.voids[1]],
    cell: sim.cell,
    trickNo: sim.trickNo,
    leader: sim.leader,
    lastLead: sim.lastLead,
    lastLeader: sim.lastLeader,
    over: sim.over,
  };
}

/** Removes `card` from `role`'s hand (it is now played). */
function playOut(sim, role, card) {
  const h = sim.hands[role];
  h.splice(h.indexOf(card), 1);
  sim.own[role * 4 + card.suit] &= ~(1 << card.rank);
  sim.played[card.suit] |= 1 << card.rank;
}

/** The cards `role` may play: a lead (lead = null) or a follow of `lead`. */
function legalFor(sim, role, lead, rules) {
  const hand = sim.hands[role];
  if (lead !== null) {
    const same = hand.filter((c) => c.suit === lead.suit);
    return same.length ? same : hand;
  }
  if (rules.LEAD_RESTRICTION === 'none' || sim.lastLead === null) return hand;
  // Wind ban: let the engine's own function decide (rare path), mapping ids back to cards.
  const stub = [{ lead: sim.lastLead.id, leader: sim.lastLeader }];
  const ids = legalCards(hand.map((c) => c.id), null, rules, stub, role);
  return ids.map(cardObj);
}

/** Resolves a trick between the cards (the leader's card is already out of his hand). */
function resolveTrick(sim, model, lead, follow, leaderRole, rules) {
  const followed = follow.suit === lead.suit;
  let dir;
  if (followed) dir = follow.rank > lead.rank ? (lead.suit + 2) % 4 : lead.suit;
  else if (rules.VOID_RULE === 'drift') dir = follow.suit;
  else if (rules.VOID_RULE === 'none') dir = lead.suit;
  else dir = STILL;
  const winner = followed && follow.rank > lead.rank ? 1 - leaderRole : leaderRole;
  if (dir !== STILL) sim.cell = model.stepCell(sim.cell, dir);
  if (!followed) sim.voids[1 - leaderRole] |= 1 << lead.suit;
  sim.trickNo += 1;
  sim.leader = winner;
  sim.lastLead = lead;
  sim.lastLeader = leaderRole;
  if (rules.ESCAPE_CHECK === 'immediate' && model.isRim(sim.cell)) sim.over = true;
}

/** A greedy decision for `role` in the simulated world: honest view (its own hand, public facts). */
function greedyPick(sim, model, role, lead, ctx, rules) {
  const own = sim.own;
  const full = (1 << (rules.MAX_RANK + 1)) - 2;
  for (let s = 0; s < 4; s++) {
    const mine = own[role * 4 + s];
    ctx.unk[s] = full & ~mine & ~sim.played[s];
    ctx.counts[s] = popcount(mine);
  }
  ctx.me = role;
  ctx.legal = legalFor(sim, role, lead, rules);
  ctx.cell = sim.cell;
  ctx.tricksLeft = rules.HAND_SIZE - sim.trickNo;
  ctx.m0 = sim.voids[0];
  ctx.m1 = sim.voids[1];
  ctx.oppHandSize = sim.hands[1 - role].length;
  ctx.lead = lead;
  ctx.leader = lead === null ? role : 1 - role;
  return lead === null ? model.chooseLead(ctx) : model.chooseFollow(ctx);
}

// ---------- the search ----------

/** Ahab's estimated chance of winning the game from a rolled-out state. */
function ahabValue(sim, model, rules, P) {
  let g;
  if (sim.over) g = 0.0; // only an escape ends a game mid-hand
  else if (sim.trickNo >= rules.HAND_SIZE) g = model.terminal(sim.cell);
  else g = model.u(sim.cell, rules.HAND_SIZE - sim.trickNo);
  const shape = P.shape;
  if (!shape) return g;
  const d = model.centreDistance(sim.cell);
  return (1.0 - shape) * g + shape * (1.0 - d / model.centre);
}

/** Plays `card` in a copy of the guessed world, plays on, and scores it for `me` (0 or 1). */
function rolloutValue(base, view, card, me, model, rules, P, ctx, pickRng) {
  const sim = cloneSim(base);
  const pick = (role, lead) => {
    if (P.rollout === 'random') {
      const legal = legalFor(sim, role, lead, rules);
      return legal[Math.floor(rngNext(pickRng) * legal.length)];
    }
    return greedyPick(sim, model, role, lead, ctx, rules);
  };
  if (view.lead === null) {
    playOut(sim, me, card);
    const follow = pick(1 - me, card);
    playOut(sim, 1 - me, follow);
    resolveTrick(sim, model, card, follow, me, rules);
  } else {
    const lead = cardObj(view.lead);
    // the leader's card is already out of his (guessed) hand and counted as played
    playOut(sim, me, card);
    resolveTrick(sim, model, lead, card, 1 - me, rules);
  }
  let left = P.horizon === null ? Infinity : P.horizon - 1;
  while (!sim.over && sim.trickNo < rules.HAND_SIZE && left > 0) {
    const leaderRole = sim.leader;
    const lead = pick(leaderRole, null);
    playOut(sim, leaderRole, lead);
    const follow = pick(1 - leaderRole, lead);
    playOut(sim, 1 - leaderRole, follow);
    resolveTrick(sim, model, lead, follow, leaderRole, rules);
    left -= 1;
  }
  const v = ahabValue(sim, model, rules, P);
  return me === 0 ? v : 1.0 - v;
}

/** Legal cards minus interchangeable ones (no unknown rank between them in a suit), sorted. */
function candidates(view, legal, P) {
  const sorted = legal.map(cardObj).sort((a, b) => a.suit - b.suit || a.rank - b.rank);
  if (!P.prune || sorted.length < 2) return sorted;
  const unknown = [0, 0, 0, 0];
  for (const id of unknownCards(view)) { const c = cardObj(id); unknown[c.suit] |= 1 << c.rank; }
  const kept = [];
  let prev = null;
  for (const card of sorted) {
    if (prev !== null && prev.suit === card.suit) {
      const between = ((1 << card.rank) - 1) & ~((1 << (prev.rank + 1)) - 1); // ranks strictly between
      if ((unknown[card.suit] & between) === 0) continue; // same run as the previous card: skip it
    }
    kept.push(card);
    prev = card;
  }
  return kept;
}

/** Hard bot's decision. `params` overrides LOOKAHEAD_PARAMS (tests and experiments). */
export function lookaheadChoose(view, rng, params = LOOKAHEAD_PARAMS) {
  const P = { ...LOOKAHEAD_PARAMS, ...params };
  const legal = legalActionsFromView(view);
  if (legal.length === 0) throw new Error('lookahead bot: no legal action (not this seat\'s turn?)');
  if (legal.length === 1) return legal[0];
  const cands = candidates(view, legal.map((a) => a.card), P);
  if (cands.length === 1) return { type: 'play', card: cands[0].id };

  const rules = view.rules;
  const model = greedyModelFor(rules);
  const me = roleIndex(view.role);
  const sums = new Array(cands.length).fill(0.0);
  const ctx = { me, legal: null, cell: 0, tricksLeft: 0, m0: 0, m1: 0, oppHandSize: 0, unk: [0, 0, 0, 0], counts: [0, 0, 0, 0], rng: null, lead: null, leader: 0 };
  const wanted = Math.max(1, Math.floor(P.samples));
  for (let done = 0; done < wanted; done++) {
    const world = determinise(view, rng);
    const base = simFromWorld(world, view, rules);
    const pickRng = P.rollout === 'random' ? forkRng(rng) : null;
    for (let i = 0; i < cands.length; i++) sums[i] += rolloutValue(base, view, cands[i], me, model, rules, P, ctx, pickRng);
  }
  const values = sums.map((s) => s / wanted);
  if (P.greedy_bonus) {
    // the card Medium would play gets a bonus (a prior that damps noise with few samples)
    const g = greedyChoice(view, rng);
    const gi = cands.findIndex((c) => c.id === g);
    if (gi >= 0) values[gi] += P.greedy_bonus;
  }
  let bi = 0;
  for (let i = 1; i < cands.length; i++) {
    const a = cands[i];
    const b = cands[bi];
    if (values[i] > values[bi] || (values[i] === values[bi] && (a.rank < b.rank || (a.rank === b.rank && a.suit < b.suit)))) bi = i;
  }
  return { type: 'play', card: cands[bi].id };
}

function greedyChoice(view, rng) {
  return greedyBot.chooseAction(view, rng).card;
}

export const lookaheadBot = {
  id: 'hard',
  label: 'Hard',
  chooseAction(view, rng) {
    return lookaheadChoose(view, rng);
  },
};

/** The rollout simulator's parts, exported only so tests/bots.mjs can check them against the engine. */
export const lookaheadInternals = { simFromWorld, cloneSim, playOut, legalFor, resolveTrick };
