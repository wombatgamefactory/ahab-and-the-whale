// actions.js - applyAction (returns events) and startNextGame.
//
// applyAction(state, action) mutates `state` (a game or a tournament) and RETURNS the
// events it produced; nothing is logged into the state. It throws, before changing
// anything, if getActionBlockReason refuses the action.
//
// The only action is { type: 'play', card: 'N7' }, played by the seat in toAct.
//
// A completed trick is recorded in game.tricks as:
//   { n, leader, follower, lead, follow, followed, winner, dirSuit, reversed,
//     blocked, from, to }
//   n         1-based trick number
//   followed  the follower played the led wind (false = drift / void trick)
//   winner    seat that won the trick (and leads next, R3.4)
//   dirSuit   wind whose direction the whale was pushed (before reversal), null if no push (calm variant)
//   reversed  the follower won a followed trick, so the opposite direction was used (R4.1)
//   blocked   the step would have left the chart, so the whale stayed (R4.3)
//   from, to  whale cell before and after the trick

import { cardSuit, cardRank } from './cards.js';
import { stepWhale, isOpenSea } from './board.js';
import { getActionBlockReason, currentGame } from './legality.js';
import { gameResult } from './scoring.js';
import { createGame } from './state.js';
import { deriveSeed } from './rng.js';

/**
 * Applies one action. Returns the events it produced (game-started, card-played, trick-won, game-over, ...;
 * describe.js turns them into log lines).
 * @param {object} state  game or tournament
 * @param {{type:'play', card:string}} action
 * @param {{silent?: boolean}} [opts]  silent: skip building events (search/sim speed)
 */
export function applyAction(state, action, opts = {}) {
  const reason = getActionBlockReason(state, action);
  if (reason !== null) throw new Error(reason);
  const events = opts.silent ? null : [];
  const g = currentGame(state);
  playCard(g, action.card, events);
  if (state.kind === 'tournament' && g.phase === 'over') recordTournamentGame(state, events);
  return events || [];
}

function playCard(g, card, events) {
  const seat = g.toAct;
  g.hands[seat] = g.hands[seat].filter((c) => c !== card);
  if (events) events.push({ type: 'card-played', seat, role: g.roles[seat], card, asLeader: g.phase === 'lead', trickNo: g.trickNo + 1 });

  if (g.phase === 'lead') {
    // R3.1: the leader's card sets the led wind; the follower acts next.
    g.lead = card;
    g.phase = 'follow';
    g.toAct = 1 - seat;
    return;
  }
  resolveTrick(g, card, events);
}

function resolveTrick(g, follow, events) {
  const rules = g.rules;
  const leader = g.leader;
  const follower = 1 - leader;
  const lead = g.lead;
  const ledSuit = cardSuit(lead);
  const followed = cardSuit(follow) === ledSuit;

  let winner;
  let dirSuit;
  let reversed = false;
  if (followed) {
    // R3.3 / R4.1: higher rank wins; the follower winning reverses the led direction.
    reversed = cardRank(follow) > cardRank(lead);
    winner = reversed ? follower : leader;
    dirSuit = ledSuit;
  } else {
    // R3.3: a void follower loses whatever was played.
    winner = leader;
    if (rules.VOID_RULE === 'drift') dirSuit = cardSuit(follow); // R4.1, R4.2, R4.6: discarded wind, never reversed
    else if (rules.VOID_RULE === 'none') dirSuit = ledSuit; // variant: led direction
    else dirSuit = null; // calm variant: no move
  }

  const from = { x: g.whale.x, y: g.whale.y };
  let to = from;
  let blocked = false;
  if (dirSuit !== null) {
    const step = stepWhale(from, dirSuit, reversed, rules); // R4.3 edge rule inside
    to = step.to;
    blocked = step.blocked;
  }
  g.whale = { x: to.x, y: to.y };

  const n = g.trickNo + 1;
  g.tricks.push({ n, leader, follower, lead, follow, followed, winner, dirSuit, reversed, blocked, from, to: { x: to.x, y: to.y } });
  g.trickNo = n;
  g.lead = null;
  g.leader = winner; // R3.4: the winner leads next
  g.phase = 'lead';
  g.toAct = winner;

  if (events) {
    events.push({ type: 'trick-won', trickNo: n, winner, winnerRole: g.roles[winner], followed, lead, follow });
    events.push({ type: 'whale-moved', trickNo: n, from, to: { x: to.x, y: to.y }, dirSuit, reversed, blocked, moved: from.x !== to.x || from.y !== to.y });
  }

  // R5.3: never ends early under hand_end. The immediate-escape variant ends on reaching open sea.
  const escaped = rules.ESCAPE_CHECK === 'immediate' && isOpenSea(g.whale, rules);
  const lastTrick = n >= rules.HAND_SIZE; // R3.5, R2.3
  if (escaped || lastTrick) {
    g.phase = 'over';
    g.toAct = null;
    g.result = gameResult(g, escaped); // R5.1
    if (events) events.push({ type: 'game-over', ...g.result });
  }
}

function recordTournamentGame(t, events) {
  const g = t.game;
  const r = g.result;
  t.history.push({ gameNo: t.gameNo, roles: [...g.roles], firstLeader: g.firstLeader, winnerSeat: r.winnerSeat, winnerRole: r.winnerRole, whale: { ...r.whale }, reason: r.reason });
  t.wins[r.winnerSeat] += 1; // R7.5: score per seat
  if (t.wins[r.winnerSeat] >= t.rules.TOURNAMENT_WINS_NEEDED) {
    t.phase = 'over'; // R7.5: ends as soon as a seat reaches the target
    t.winnerSeat = r.winnerSeat;
  } else {
    t.phase = 'between';
  }
  if (events) {
    events.push({ type: 'tournament-game-recorded', gameNo: t.gameNo, winnerSeat: r.winnerSeat, wins: [...t.wins] });
    if (t.phase === 'over') events.push({ type: 'tournament-over', winnerSeat: t.winnerSeat, wins: [...t.wins] });
  }
}

/**
 * Deals the next tournament game. Not an action (no player chooses it): the driver calls it
 * when it is ready to leave the previous game's result screen. Throws unless phase is 'between'.
 * Returns events: [{ type: 'game-started', gameNo, roles, firstLeader }].
 */
export function startNextGame(t) {
  if (t.kind !== 'tournament') throw new Error('startNextGame needs a tournament');
  if (t.phase !== 'between') throw new Error(`Cannot start the next game while the tournament is ${t.phase}`);
  if (t.gameNo >= t.rules.TOURNAMENT_MAX_GAMES) throw new Error(`Tournament already played ${t.gameNo} games`);
  const prev = t.game;
  // R7.2: roles swap every game. R7.3: the seat that did not lead first last game leads first.
  const roles = t.rules.ROLES_SWAP_EACH_GAME ? [prev.roles[1], prev.roles[0]] : [...prev.roles];
  const firstLeader = 1 - prev.firstLeader;
  t.gameNo += 1;
  // R7.4: fresh shuffle and deal; whale back to the centre.
  t.game = createGame({ seed: deriveSeed(t.seed, 'game', t.gameNo), roles, rules: t.rules, firstLeader });
  t.phase = 'playing';
  return [{ type: 'game-started', gameNo: t.gameNo, roles: [...roles], firstLeader }];
}
