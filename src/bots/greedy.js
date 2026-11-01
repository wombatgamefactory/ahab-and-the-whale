// greedy.js - Medium bot: a one-ply heuristic player that tracks shown voids.
//
// A port of the Python sim's GreedyBot (research/four-winds-sim/fourwinds/bots/greedy.py), for the
// rule paths this engine can play: VOID_RULE drift | none | calm, ESCAPE_CHECK hand_end | immediate,
// LEAD_RESTRICTION none | not_previous | not_own_previous, one hand per game, square chart, no gust,
// must-follow. (The sim's calm_pass, next_trick, gust, may_renounce, diamond chart, multi-hand and
// between-hands paths cannot occur in this engine, so they are not ported.)
//
// It reads only its view (own hand, played cards, public voids, the whale cell). Nothing hidden is used.
// It is stateless between calls: the only memory is caches of pure position values, which never
// change an answer.
//
// How it plays
// ------------
// Every position is given a utility in "Ahab's chance of winning the game" units (0 to 1; the Whale's
// is one minus that). A small dynamic-programming model supplies it: from a cell with `tl` tricks
// left, the next trick's leader picks an axis (x or y), and the trick is a coin toss between the two
// directions along it. A whale on open sea at hand end is an escape (worth 0 to Ahab); otherwise the
// cell is worth 1 in harpoon range and 0 outside it (the Whale wins).
//
// * Follower: each legal card gives a known winner, whale cell and next leader (the bot replays the
//   engine's rules for that very card). The outcome is scored as that cell plus `lead_weight` worth of
//   "who leads next" (the winner picks the axis; known voids make a forced move available to the
//   leader). A small card cost breaks ties: the cheapest winning card when winning, the card least
//   useful later when losing (middle ranks and cards from long suits go first; the last card of a suit
//   is kept). Under drift a void follower weighs each discard by the direction it steers.
// * Leader: for every legal lead the bot estimates how likely each outcome is from the unknown cards
//   (the opponent's hand plus the unseen pile, minus suits they have shown void): the follower may be
//   void (certain if publicly void), forced to lose, forced to win, or free to choose, in which case
//   they are assumed to pick the result that is worse for the leader. It scores expected position
//   value plus lead retention, minus the card cost. Leading into a shown void is therefore chosen
//   when the forced result favours it.

import { legalActionsFromView, shownVoids, unknownCards, rngNext } from '../engine/index.js';

/**
 * Tuning constants (Python names and comments kept). Pass a modified copy to createGreedyModel to
 * experiment; the registered bot uses these.
 *
 * lead_weight (0.7)     0 to 1.  Weight of "who leads next and which axis they will pick" against
 *                       the plain value of the cell.  0 = ignore the lead.
 * lead_control (0.55)   0.5 to 1.  How often a leader is assumed to get the direction they want along
 *                       their chosen axis (a leader can play high or low to win or lose).  0.5 = coin toss.
 * renounce_control (0.52)  The same, used instead of lead_control when follow_rule = may_renounce
 *                       (a leader can no longer force a follower to win, so he controls less).
 *                       [UNUSED here: this engine only has must-follow.]
 * endgame_weight (0.0)  0 or more.  Blends in the "if the hand ended now" value (in range or not) as
 *                       the hand runs down, min(1, endgame_weight * fraction_of_hand_played).
 *                       Larger = more short-sighted about the last tricks.
 * void_exploit (true)   Use shown voids: treat a public void as certain, lead into it when it pays,
 *                       and see the lock a shown void gives the next leader.  false = play as if
 *                       voids were never shown.
 * escape_bonus (10.0)   Extra weight on an escape that happens on this very trick (taken at once by
 *                       the Whale, avoided at almost any price by Ahab).
 * keep_weight (0.02)    Scale of the card-retention cost (breaks ties between equal outcomes).
 * void_penalty (0.03)   Extra cost for playing the last card of a suit when void_rule = none
 *                       (a void hands the opponent a forced result).
 * hand_win_prior (0.4)  Assumed chance Ahab wins each later hand, for the game-situation value.
 *                       [UNUSED here: a game is one hand.]
 * gust_chance (0.2)     When gust is on: assumed chance that a later trick is a gust.
 *                       [UNUSED here: no gust variant.]
 * noise (0.0)           Random jitter added to every score (0 = fully deterministic; uses the rng).
 */
export const GREEDY_PARAMS = {
  lead_weight: 0.7,
  lead_control: 0.55,
  renounce_control: 0.52,
  endgame_weight: 0.0,
  void_exploit: true,
  escape_bonus: 10.0,
  keep_weight: 0.02,
  void_penalty: 0.03,
  hand_win_prior: 0.4,
  gust_chance: 0.2,
  noise: 0.0,
};

const AHAB = 0; // internal role index (the Python AHAB = 0, WHALE = 1)
const WHALE = 1;
const SUIT_INDEX = { N: 0, E: 1, S: 2, W: 3 };
const DX = [0, 1, 0, -1]; // by suit index N, E, S, W: x grows East, y grows South
const DY = [-1, 0, 1, 0];
const STILL = -1; // "no step" (calm void trick)
const ESCAPED = -1; // a cell value meaning "the Whale escapes on this trick"

// ---------- small helpers shared with lookahead.js ----------

const CARDS = new Map();
/** 'N7' -> { id: 'N7', suit: 0, rank: 7 } (one shared object per id). */
export function cardObj(id) {
  let c = CARDS.get(id);
  if (c === undefined) {
    c = { id, suit: SUIT_INDEX[id[0]], rank: Number(id.slice(1)) };
    CARDS.set(id, c);
  }
  return c;
}

export const roleIndex = (role) => (role === 'ahab' ? AHAB : WHALE);

/** Number of set bits of a 32-bit integer. */
export function popcount(x) {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

// Binomial coefficients as doubles (exact up to 2^53, i.e. well past the 36-card deck).
const COMB = [];
for (let n = 0; n <= 80; n++) {
  COMB.push(new Array(n + 1));
  COMB[n][0] = COMB[n][n] = 1;
  for (let k = 1; k < n; k++) COMB[n][k] = COMB[n - 1][k - 1] + COMB[n - 1][k];
}
const comb = (n, k) => (k < 0 || k > n ? 0 : COMB[n][k]);

/** Chance that a random `drawn`-card hand from `pool` cards holds none of `banned` given cards. */
function pAvoid(pool, banned, drawn) {
  if (drawn <= 0 || banned <= 0) return 1.0;
  if (pool - banned < drawn) return 0.0;
  return comb(pool - banned, drawn) / comb(pool, drawn);
}

// ---------- the model (position values), cached per rule set ----------

const MODELS = new Map();

/** The shared model for a resolved rules object (view.rules). Caches hold pure values only. */
export function greedyModelFor(rules) {
  const key = [rules.GRID_SIZE, rules.HARPOON_RADIUS, rules.MAX_RANK, rules.HAND_SIZE, rules.VOID_RULE, rules.ESCAPE_CHECK, rules.LEAD_RESTRICTION].join('|');
  let m = MODELS.get(key);
  if (m === undefined) {
    m = createGreedyModel(rules);
    MODELS.set(key, m);
  }
  return m;
}

/**
 * Builds the position model and the two decision functions for one rule set.
 * Cells are integers y * GRID_SIZE + x; roles are 0 (Ahab) and 1 (Whale); cards are cardObj()s.
 */
export function createGreedyModel(rules, params = GREEDY_PARAMS) {
  const P = { ...GREEDY_PARAMS, ...params };
  const N = rules.GRID_SIZE;
  const CELLS = N * N;
  const CENTRE = Math.floor(N / 2);
  const H = rules.HAND_SIZE;
  const MAX_RANK = rules.MAX_RANK;
  const voidRule = rules.VOID_RULE; // 'drift' | 'none' | 'calm'
  const immediate = rules.ESCAPE_CHECK === 'immediate';
  const restriction = rules.LEAD_RESTRICTION; // 'none' | 'not_previous' | 'not_own_previous'
  const ctl = P.lead_control;

  // Geometry tables.
  const rim = new Uint8Array(CELLS);
  const inRange = new Uint8Array(CELLS);
  const centreDist = new Uint8Array(CELLS);
  const stepTo = new Int32Array(CELLS * 4); // the cell one step along suit d (the same cell if blocked)
  const stepBlocked = new Uint8Array(CELLS * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const cell = y * N + x;
      rim[cell] = x === 0 || y === 0 || x === N - 1 || y === N - 1 ? 1 : 0;
      const d = Math.max(Math.abs(x - CENTRE), Math.abs(y - CENTRE));
      centreDist[cell] = d;
      inRange[cell] = d <= rules.HARPOON_RADIUS ? 1 : 0;
      for (let s = 0; s < 4; s++) {
        const nx = x + DX[s];
        const ny = y + DY[s];
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) { stepTo[cell * 4 + s] = cell; stepBlocked[cell * 4 + s] = 1; } else stepTo[cell * 4 + s] = ny * N + nx;
      }
    }
  }

  /** Is the Whale's escape declared on a trick that leaves the whale on `cell`? */
  function settle(cell, onRim, tlAfter) {
    if (immediate) return onRim;
    if (!rim[cell]) return false;
    return tlAfter <= 0; // hand_end
  }

  /** The cell after one step along suit `dir` (STILL: stay), or ESCAPED if that trick is an escape. */
  function go(cell, dir, tlAfter) {
    let to = cell;
    let onRim = false;
    if (dir !== STILL) {
      to = stepTo[cell * 4 + dir];
      onRim = !stepBlocked[cell * 4 + dir] && rim[to] === 1;
    }
    return settle(to, onRim, tlAfter) ? ESCAPED : to;
  }

  /** Ahab's game value if the hand ended with the whale on `cell` (open sea = 0). One hand, outside range = Whale wins. */
  function terminal(cell) {
    if (rim[cell]) return 0.0;
    return inRange[cell] ? 1.0 : 0.0;
  }

  const uCache = new Float64Array((H + 1) * CELLS).fill(NaN);
  const pairCache = new Float64Array((H + 1) * CELLS * 4).fill(NaN); // x+, x-, y+, y- (E, W, S, N)

  /** Ahab's utility with `tl` tricks still to play and nobody yet known to lead the next. */
  function u(cell, tl) {
    if (immediate && rim[cell]) return 0.0;
    if (tl <= 0) return terminal(cell);
    const k = tl * CELLS + cell;
    let v = uCache[k];
    if (v === v) return v;
    v = 0.5 * (axisBest(cell, tl, AHAB) + axisBest(cell, tl, WHALE));
    uCache[k] = v;
    return v;
  }

  /** Ahab's utility of one step along suit `dir` (an escape on it is worth 0). */
  function moveValue(cell, dir, tlAfter) {
    const c = go(cell, dir, tlAfter);
    return c === ESCAPED ? 0.0 : u(c, tlAfter);
  }

  /** Fills and returns the base index in pairCache for the four step values from (cell, tl). */
  function pairs(cell, tl) {
    const base = (tl * CELLS + cell) * 4;
    if (pairCache[base] !== pairCache[base]) {
      pairCache[base] = moveValue(cell, 1, tl - 1); // East
      pairCache[base + 1] = moveValue(cell, 3, tl - 1); // West
      pairCache[base + 2] = moveValue(cell, 2, tl - 1); // South
      pairCache[base + 3] = moveValue(cell, 0, tl - 1); // North
    }
    return base;
  }

  /**
   * Ahab's utility when `leader` picks the best axis; they get their preferred direction with
   * chance lead_control (0.5 = a coin toss).
   */
  function axisBest(cell, tl, leader) {
    const b = pairs(cell, tl);
    let best = 0;
    for (let a = 0; a < 2; a++) {
      const p = pairCache[b + 2 * a];
      const m = pairCache[b + 2 * a + 1];
      const hi = p >= m ? p : m;
      const lo = p >= m ? m : p;
      const v = leader === AHAB ? ctl * hi + (1 - ctl) * lo : ctl * lo + (1 - ctl) * hi;
      if (a === 0 || (leader === AHAB ? v > best : v < best)) best = v;
    }
    return best;
  }

  /** The suit `leader` may not lead next, given the trick just played as (ledSuit, its leader); -1 = none. */
  function barred(ledSuit, trickLeader, leader) {
    if (ledSuit < 0 || restriction === 'none') return -1;
    if (restriction === 'not_previous') return ledSuit;
    return leader === trickLeader ? ledSuit : -1; // not_own_previous
  }

  const ledCache = new Map();

  /**
   * Ahab's utility when `leader` is about to lead with `tl` tricks left; the follower's shown voids
   * (a bitmask) give the leader forced options. (ledSuit, ledLeader) = the trick just played, for
   * the lead restriction (ledSuit -1 = none).
   */
  function nextLed(cell, tl, leader, followerMask, ledSuit, ledLeader) {
    if (!(followerMask && P.void_exploit)) return axisBest(cell, tl, leader);
    const bar = barred(ledSuit, ledLeader, leader);
    const key = (((cell * (H + 1) + tl) * 2 + leader) * 16 + followerMask) * 5 + (bar + 1);
    let best = ledCache.get(key);
    if (best === undefined) {
      best = axisBest(cell, tl, leader);
      const tlAfter = tl - 1;
      // Ahab's utility of each result the leader can force by leading a suit the follower has shown
      // void (the leader's hand is not known, so he is assumed to hold such a suit). Suits the lead
      // restriction bars on that trick are left out.
      for (let suit = 0; suit < 4; suit++) {
        if (!((followerMask >> suit) & 1) || suit === bar) continue;
        let f;
        if (voidRule === 'none') {
          f = moveValue(cell, suit, tlAfter);
        } else if (voidRule === 'calm') {
          f = moveValue(cell, STILL, tlAfter);
        } else { // drift: the void follower steers with a suit of his choice
          let lo = Infinity;
          let hi = -Infinity;
          for (let t = 0; t < 4; t++) {
            if (t === suit) continue;
            const v = moveValue(cell, t, tlAfter);
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
          f = leader === AHAB ? lo : hi;
        }
        best = leader === AHAB ? Math.max(best, f) : Math.min(best, f);
        if (voidRule === 'calm') break; // every void suit gives the same result
      }
      ledCache.set(key, best);
    }
    return best;
  }

  /**
   * Utility from `role`'s point of view of a trick that left the whale on `cell` (ESCAPED = escape)
   * and gave the next lead to `nxt`. m0/m1 = void bitmasks by role.
   */
  function outcome(cell, tlAfter, nxt, m0, m1, role, ledSuit, ledLeader) {
    let a;
    if (cell === ESCAPED) {
      a = -P.escape_bonus;
    } else {
      a = u(cell, tlAfter);
      if (tlAfter > 0) {
        const lw = P.lead_weight;
        if (lw) {
          const nl = nextLed(cell, tlAfter, nxt, nxt === 0 ? m1 : m0, ledSuit, ledLeader);
          a = (1 - lw) * a + lw * nl;
        }
        const ew = P.endgame_weight;
        if (ew) {
          const s = Math.min(1.0, ew * (1 - tlAfter / H));
          if (s > 0) a = (1 - s) * a + s * terminal(cell);
        }
      }
    }
    return role === AHAB ? a : 1.0 - a;
  }

  /** Cost of spending `card` (what it could do for us later). pWin = chance it wins now. */
  function keepCost(card, unk, counts, pWin) {
    const kw = P.keep_weight;
    const um = unk[card.suit];
    let certainty;
    if (um) {
      const q = popcount(um & ((1 << card.rank) - 1)) / popcount(um);
      certainty = Math.abs(2 * q - 1);
    } else certainty = 0.5;
    const k = counts[card.suit];
    let cost = kw * (pWin * card.rank / MAX_RANK + (1 - pWin) * certainty + 0.5 / k);
    if (k === 1 && voidRule === 'none') cost += P.void_penalty;
    return cost;
  }

  const jitter = (rng) => (P.noise && rng ? rngNext(rng) * P.noise : 0.0);

  // A decision context ("ctx"):
  //   me (role 0/1), legal (cardObjs), cell, tricksLeft (including this one), m0/m1 (void bitmasks by
  //   role, bit = suit), oppHandSize, unk (4 bitmasks of unknown ranks, bit r = rank r), counts (own
  //   cards per suit), rng; following: lead (cardObj) and leader (role).

  /** Follow: score each legal card by the trick it makes. Returns a cardObj. */
  function chooseFollow(ctx) {
    const me = ctx.me;
    const lead = ctx.lead;
    const leader = ctx.leader;
    const tlAfter = ctx.tricksLeft - 1;
    const exploit = P.void_exploit;
    const bm0 = exploit ? ctx.m0 : 0;
    const bm1 = exploit ? ctx.m1 : 0;
    let best = null;
    let bestScore = 0;
    for (const card of ctx.legal) {
      const isVoid = card.suit !== lead.suit;
      let leaderWins;
      let dir;
      if (isVoid) {
        leaderWins = true;
        dir = voidRule === 'drift' ? card.suit : voidRule === 'calm' ? STILL : lead.suit;
      } else {
        leaderWins = card.rank < lead.rank;
        dir = leaderWins ? lead.suit : (lead.suit + 2) % 4;
      }
      const cell = go(ctx.cell, dir, tlAfter);
      const winner = leaderWins ? leader : me;
      let m0 = bm0;
      let m1 = bm1;
      if (isVoid) { if (me === 0) m0 |= 1 << lead.suit; else m1 |= 1 << lead.suit; }
      const value = outcome(cell, tlAfter, winner, m0, m1, me, lead.suit, leader);
      const cost = keepCost(card, ctx.unk, ctx.counts, leaderWins ? 0.0 : 1.0);
      const score = value - cost + jitter(ctx.rng);
      // ties: lower rank, then lower suit
      if (best === null || score > bestScore || (score === bestScore && (card.rank < best.rank || (card.rank === best.rank && card.suit < best.suit)))) {
        best = card;
        bestScore = score;
      }
    }
    return best;
  }

  /** Leader's utility when the follower plays off-suit in `suit` (a forced void). */
  function voidResult(ctx, suit, eligCount, pool, poolT, drawn, m0, m1, tlAfter, ledSuit) {
    const me = ctx.me;
    if (voidRule === 'calm') return outcome(go(ctx.cell, STILL, tlAfter), tlAfter, me, m0, m1, me, ledSuit, me);
    if (voidRule !== 'drift') return outcome(go(ctx.cell, suit, tlAfter), tlAfter, me, m0, m1, me, ledSuit, me);
    // drift: the void opponent steers with the suit they discard; assume they pick the best one they hold
    const opts = [];
    for (let t = 0; t < 4; t++) {
      if (t === suit) continue;
      const uu = outcome(go(ctx.cell, t, tlAfter), tlAfter, me, m0, m1, me, ledSuit, me);
      opts.push([uu, 1.0 - pAvoid(poolT, eligCount[t], drawn)]);
    }
    opts.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    let total = 0.0;
    let left = 1.0;
    for (const [uu, pHas] of opts) {
      total += left * pHas * uu;
      left *= 1.0 - pHas;
    }
    if (left > 0) total += left * opts[opts.length - 1][0];
    return total;
  }

  /** Lead: estimate each legal lead from the unknown cards. Returns a cardObj. */
  function chooseLead(ctx) {
    const me = ctx.me;
    const opp = 1 - me;
    const tlAfter = ctx.tricksLeft - 1;
    const exploit = P.void_exploit;
    const m0 = exploit ? ctx.m0 : 0;
    const m1 = exploit ? ctx.m1 : 0;
    const oppMask = opp === 0 ? m0 : m1;
    const elig = [0, 0, 0, 0];
    const eligCount = [0, 0, 0, 0];
    let pool = 0;
    for (let s = 0; s < 4; s++) {
      if (!((oppMask >> s) & 1)) { elig[s] = ctx.unk[s]; eligCount[s] = popcount(elig[s]); pool += eligCount[s]; }
    }
    const drawn = Math.min(ctx.oppHandSize, pool);
    const pos = ctx.cell;
    let best = null;
    let bestScore = 0;
    for (const card of ctx.legal) {
      const suit = card.suit;
      const rank = card.rank;
      const neg = (suit + 2) % 4;
      const knownVoid = ((oppMask >> suit) & 1) === 1;
      let pVoid;
      let pOl;
      let pOh;
      let pMx;
      if (knownVoid) {
        pVoid = 1.0; pOl = 0.0; pOh = 0.0; pMx = 0.0;
      } else {
        const lows = popcount(elig[suit] & ((1 << rank) - 1));
        const highs = eligCount[suit] - popcount(elig[suit] & ((1 << (rank + 1)) - 1));
        const pNone = pAvoid(pool, lows + highs, drawn);
        const pNoHigh = pAvoid(pool, highs, drawn);
        const pNoLow = pAvoid(pool, lows, drawn);
        pVoid = pNone;
        pOl = Math.max(0.0, pNoHigh - pNone);
        pOh = Math.max(0.0, pNoLow - pNone);
        pMx = Math.max(0.0, 1.0 - pNoHigh - pNoLow + pNone);
      }
      // Leader wins by rank / follower wins by rank.
      let uLw = null;
      let uFw = null;
      if (pOl + pMx > 0) uLw = outcome(go(pos, suit, tlAfter), tlAfter, me, m0, m1, me, suit, me);
      if (pOh + pMx > 0) uFw = outcome(go(pos, neg, tlAfter), tlAfter, opp, m0, m1, me, suit, me);
      let uVoid = 0.0;
      if (pVoid > 0) {
        let v0 = m0;
        let v1 = m1;
        if (opp === 0) v0 |= 1 << suit; else v1 |= 1 << suit;
        const poolT = pool - eligCount[suit];
        uVoid = voidResult(ctx, suit, eligCount, pool, poolT, drawn, v0, v1, tlAfter, suit);
      }
      let value = pVoid * uVoid;
      if (pOl) value += pOl * uLw;
      if (pOh) value += pOh * uFw;
      if (pMx) value += pMx * Math.min(uLw, uFw);
      const pWin = pVoid + pOl + 0.5 * pMx;
      const score = value - keepCost(card, ctx.unk, ctx.counts, pWin) + jitter(ctx.rng);
      if (best === null || score > bestScore || (score === bestScore && (rank < best.rank || (rank === best.rank && suit < best.suit)))) {
        best = card;
        bestScore = score;
      }
    }
    return best;
  }

  return {
    params: P, rules, cells: CELLS, centre: CENTRE, handSize: H,
    u, terminal, chooseFollow, chooseLead, go, STILL, ESCAPED,
    isRim: (cell) => rim[cell] === 1,
    centreDistance: (cell) => centreDist[cell],
    stepCell: (cell, dir) => stepTo[cell * 4 + dir],
  };
}

// ---------- from a view to a decision context ----------

/** Builds the decision context for a view (see createGreedyModel). */
export function contextFromView(view, rng) {
  const N = view.rules.GRID_SIZE;
  const me = roleIndex(view.role);
  const voids = shownVoids(view); // by seat
  const masks = [0, 0];
  for (let seat = 0; seat < 2; seat++) {
    let m = 0;
    for (const s of voids[seat]) m |= 1 << SUIT_INDEX[s];
    masks[roleIndex(view.roles[seat])] = m;
  }
  const unk = [0, 0, 0, 0];
  for (const id of unknownCards(view)) { const c = cardObj(id); unk[c.suit] |= 1 << c.rank; }
  const counts = [0, 0, 0, 0];
  for (const id of view.hand) counts[cardObj(id).suit]++;
  return {
    me,
    legal: legalActionsFromView(view).map((a) => cardObj(a.card)),
    cell: view.whale.y * N + view.whale.x,
    tricksLeft: view.rules.HAND_SIZE - view.trickNo,
    m0: masks[0],
    m1: masks[1],
    oppHandSize: view.oppHandSize,
    unk,
    counts,
    rng,
    lead: view.lead === null ? null : cardObj(view.lead),
    leader: roleIndex(view.roles[view.leader]),
  };
}

export const greedyBot = {
  id: 'medium',
  label: 'Medium',
  chooseAction(view, rng) {
    const ctx = contextFromView(view, rng);
    if (ctx.legal.length === 0) throw new Error('greedy bot: no legal action (not this seat\'s turn?)');
    const model = greedyModelFor(view.rules);
    const card = ctx.lead === null ? model.chooseLead(ctx) : model.chooseFollow(ctx);
    return { type: 'play', card: card.id };
  },
};
