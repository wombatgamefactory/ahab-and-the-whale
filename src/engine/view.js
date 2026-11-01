// view.js - what one seat may know (rule list §8), and helpers bots compute from it.
//
// viewFor(state, seat) is the ONLY thing a bot receives. It contains the seat's own hand,
// everything public (R8.1: every completed trick in order, the card led to you, the chart,
// who leads, the trick count), and never the opponent's hand or the unused cards (R8.2).
// Voids are not announced (R8.3): shownVoids() derives them from the played cards.

import { SUITS } from './rules.js';
import { cardSuit, fullDeck, sortCards } from './cards.js';
import { legalCards, currentGame } from './legality.js';
import { forkRng, shuffle } from './rng.js';

const clone = (x) => JSON.parse(JSON.stringify(x));

/**
 * The view of `seat` (0 or 1) of a game or tournament. Plain JSON; a fresh copy each call.
 */
export function viewFor(state, seat) {
  if (seat !== 0 && seat !== 1) throw new Error(`viewFor needs seat 0 or 1, got ${seat}`);
  const g = currentGame(state);
  const series = state.kind === 'tournament'
    ? { gameNo: state.gameNo, wins: [...state.wins], history: clone(state.history), phase: state.phase, winnerSeat: state.winnerSeat }
    : null;
  return {
    kind: 'view',
    seat,
    role: g.roles[seat],
    roles: [...g.roles],
    rules: { ...g.rules },
    phase: g.phase, // 'lead' | 'follow' | 'over'
    toAct: series && series.phase !== 'playing' ? null : g.toAct,
    hand: [...g.hands[seat]],
    oppHandSize: g.hands[1 - seat].length,
    whale: { x: g.whale.x, y: g.whale.y },
    trickNo: g.trickNo, // completed tricks
    leader: g.leader, // seat leading the current trick
    firstLeader: g.firstLeader,
    lead: g.lead, // card led this trick (visible to both), or null
    tricks: clone(g.tricks),
    result: g.result ? clone(g.result) : null,
    series, // null for a standalone game
  };
}

/** The legal actions for the viewing seat, computed from the view alone (empty if not its turn). */
export function legalActionsFromView(view) {
  if (view.toAct !== view.seat) return [];
  return legalCards(view.hand, view.lead, view.rules, view.tricks, view.seat).map((card) => ({ type: 'play', card }));
}

/**
 * Winds each seat has publicly shown it lacks: a drift trick shows the follower held none
 * of the led wind (R8.3). Valid for the rest of the game because no cards are drawn (R3.5).
 * @returns {string[][]} by seat, e.g. [[], ['E']]
 */
export function shownVoids(view) {
  const out = [new Set(), new Set()];
  for (const t of view.tricks) if (!t.followed) out[t.follower].add(cardSuit(t.lead));
  return out.map((s) => SUITS.filter((x) => s.has(x)));
}

/** Every card played so far in order, as { seat, card } (includes a card led this trick). */
export function playedCards(view) {
  const out = [];
  for (const t of view.tricks) {
    out.push({ seat: t.leader, card: t.lead });
    out.push({ seat: t.follower, card: t.follow });
  }
  if (view.lead !== null) out.push({ seat: view.leader, card: view.lead });
  return out;
}

/** Cards the viewer cannot place: the opponent's hand plus the unused cards (sorted). */
export function unknownCards(view) {
  const known = new Set(view.hand);
  for (const p of playedCards(view)) known.add(p.card);
  return fullDeck(view.rules.MAX_RANK).filter((c) => !known.has(c));
}

/**
 * A complete game state consistent with the view: the opponent is dealt uniformly from the
 * unknown cards outside their shown voids; the rest become the unused pile. For lookahead
 * bots (clone it and play on with applyAction). Does not model the wind-ban variant's
 * single-suit inference.
 */
export function determinise(view, rng) {
  const opp = 1 - view.seat;
  const unknown = unknownCards(view);
  const voids = new Set(shownVoids(view)[opp]);
  const eligible = shuffle(rng, unknown.filter((c) => !voids.has(cardSuit(c))));
  if (eligible.length < view.oppHandSize) throw new Error('Inconsistent view: not enough unknown cards outside the opponent\'s voids');
  const oppHand = eligible.slice(0, view.oppHandSize);
  const taken = new Set(oppHand);
  const hands = [];
  hands[view.seat] = [...view.hand];
  hands[opp] = sortCards(oppHand);
  return {
    kind: 'game',
    schema: 1,
    seed: 'determinised',
    rules: { ...view.rules },
    rng: forkRng(rng),
    roles: [...view.roles],
    hands,
    unused: unknown.filter((c) => !taken.has(c)),
    whale: { ...view.whale },
    firstLeader: view.firstLeader,
    leader: view.leader,
    lead: view.lead,
    phase: view.phase,
    toAct: view.phase === 'over' ? null : (view.phase === 'lead' ? view.leader : 1 - view.leader),
    trickNo: view.trickNo,
    tricks: clone(view.tricks),
    result: view.result ? clone(view.result) : null,
  };
}
