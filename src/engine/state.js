// state.js - createGame, createTournament, resolveRoles.
//
// SERIALISABILITY IS LOAD-BEARING: every state survives JSON.parse(JSON.stringify(state))
// unchanged. Plain JSON only, null never undefined, no functions or class instances.
//
// Seats vs roles (R6.3): seats are 0 and 1 (who is human or bot is a UI concern and is
// NOT in the engine state). `state.roles[seat]` is 'ahab' or 'whale'. Everything that
// is "per player" (hands, winner, toAct, leader) is indexed by SEAT.
//
// Tournament model (R7): a tournament WRAPS game states. `t.game` is an ordinary game
// state (the current game); `t.history` holds a summary of each finished game. A game
// carries no series information, so every game function works unchanged on `t.game`.

import { resolveVariants, ROLES } from './rules.js';
import { makeRng, rngInt, shuffle, deriveSeed } from './rng.js';
import { fullDeck, sortCards, isCard } from './cards.js';
import { startCell } from './board.js';

/**
 * Turns two role choices ('ahab' | 'whale' | 'random') into roles by seat (R6.2).
 * Throws if both seats chose the same fixed role.
 * @returns {string[]} e.g. ['whale', 'ahab']
 */
export function resolveRoles(choice0, choice1, rng) {
  const ok = ['ahab', 'whale', 'random'];
  if (!ok.includes(choice0) || !ok.includes(choice1)) {
    throw new Error(`Role choices must be ahab, whale or random; got ${choice0}, ${choice1}`);
  }
  if (choice0 !== 'random' && choice0 === choice1) {
    throw new Error(`Both seats chose ${choice0}; one seat must be Ahab and the other the Whale`);
  }
  const other = (r) => (r === 'ahab' ? 'whale' : 'ahab');
  if (choice0 !== 'random') return [choice0, other(choice0)];
  if (choice1 !== 'random') return [other(choice1), choice1];
  return rngInt(rng, 2) === 0 ? ['ahab', 'whale'] : ['whale', 'ahab'];
}

function checkRoles(roles) {
  if (!Array.isArray(roles) || roles.length !== 2 || !ROLES.includes(roles[0]) || !ROLES.includes(roles[1]) || roles[0] === roles[1]) {
    throw new Error(`roles must be ['ahab','whale'] or ['whale','ahab'], got ${JSON.stringify(roles)}`);
  }
}

function checkDeal(deal, rules) {
  const n = rules.HAND_SIZE;
  const hands = deal.hands;
  if (!Array.isArray(hands) || hands.length !== 2 || hands[0].length !== n || hands[1].length !== n) {
    throw new Error(`deal.hands must be two hands of ${n} cards`);
  }
  const all = [...hands[0], ...hands[1], ...(deal.unused || [])];
  for (const c of all) if (!isCard(c, rules.MAX_RANK)) throw new Error(`Bad card id in deal: ${JSON.stringify(c)}`);
  if (new Set(all).size !== all.length) throw new Error('deal contains a card twice');
}

/**
 * A new standalone game (R2), ready for the first lead.
 * @param {object} opts
 * @param {number|string} opts.seed          drives the deal and a random first leader
 * @param {string[]} [opts.roles]            roles by seat; default ['ahab', 'whale']
 * @param {object} [opts.rules]              rule overrides (see rules.js VARIANTS)
 * @param {number|null} [opts.firstLeader]   force the first leader's seat (tournaments, replays)
 * @param {{hands: string[][], unused?: string[]}|null} [opts.deal]  fixed deal by seat (replays, tests)
 */
export function createGame(opts = {}) {
  const { seed, roles = ['ahab', 'whale'], firstLeader = null, deal = null } = opts;
  const rules = resolveVariants(opts.rules || {});
  checkRoles(roles);
  const rng = makeRng(seed);

  let hands;
  let unused;
  if (deal) {
    checkDeal(deal, rules);
    hands = [sortCards(deal.hands[0]), sortCards(deal.hands[1])];
    unused = deal.unused ? sortCards(deal.unused) : sortCards(fullDeck(rules.MAX_RANK).filter((c) => !hands[0].includes(c) && !hands[1].includes(c)));
  } else {
    // R2.2: shuffle all cards, deal HAND_SIZE each, the rest set aside unseen.
    const deck = shuffle(rng, fullDeck(rules.MAX_RANK));
    const n = rules.HAND_SIZE;
    hands = [sortCards(deck.slice(0, n)), sortCards(deck.slice(n, 2 * n))];
    unused = sortCards(deck.slice(2 * n));
  }

  let leader;
  if (firstLeader !== null) {
    if (firstLeader !== 0 && firstLeader !== 1) throw new Error(`firstLeader must be 0, 1 or null, got ${firstLeader}`);
    leader = firstLeader;
  } else if (rules.FIRST_LEADER === 'random') {
    leader = rngInt(rng, 2); // R2.4
  } else {
    leader = roles.indexOf(rules.FIRST_LEADER);
  }

  return {
    kind: 'game',
    schema: 1,
    seed: String(seed),
    rules,
    rng,
    roles: [...roles],
    hands,
    unused,
    whale: startCell(rules), // R1.7
    firstLeader: leader,
    leader, // leader of the current trick
    lead: null, // card led in the current trick, while awaiting the follow
    phase: 'lead', // 'lead' | 'follow' | 'over'
    toAct: leader, // seat that must act, null when over
    trickNo: 0, // completed tricks
    tricks: [], // completed tricks in order (see actions.js for the shape)
    result: null, // set when phase is 'over' (see scoring.js)
  };
}

/**
 * A new first-to-N-wins tournament (R7) with game 1 dealt.
 * @param {object} opts
 * @param {number|string} opts.seed
 * @param {string[]} [opts.roles]  game-1 roles by seat; default ['ahab', 'whale']
 * @param {object} [opts.rules]    rule overrides, applied to every game
 */
export function createTournament(opts = {}) {
  const { seed, roles = ['ahab', 'whale'] } = opts;
  const rules = resolveVariants(opts.rules || {});
  checkRoles(roles);
  const rng = makeRng(deriveSeed(seed, 'tournament'));
  const firstLeader = rngInt(rng, 2); // R7.3: game 1 first leader is random
  const game = createGame({ seed: deriveSeed(seed, 'game', 1), roles, rules, firstLeader });
  return {
    kind: 'tournament',
    schema: 1,
    seed: String(seed),
    rules,
    rng,
    gameNo: 1, // 1-based number of the current game
    wins: [0, 0], // game wins by SEAT (R7.5)
    history: [], // finished games: { gameNo, roles, firstLeader, winnerSeat, winnerRole, whale, reason }
    game, // the current game state
    phase: 'playing', // 'playing' | 'between' (game over, next not dealt) | 'over'
    winnerSeat: null,
  };
}
