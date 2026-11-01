// legality.js - getValidActions and plain-English block reasons.
//
// ONE implementation of "which cards may this seat play": legalCards(). It reads only
// public facts plus the actor's own hand, so getValidActions (full state) and
// legalActionsFromView (a bot's view, view.js) both call it and cannot disagree.
// applyAction refuses through getPlayBlockReason, which asks the same function.

import { SUIT_NAMES, ROLE_NAMES } from './rules.js';
import { cardSuit, cardName, listCardNames } from './cards.js';

/** The game state inside a game or a tournament. */
export function currentGame(state) {
  return state.kind === 'tournament' ? state.game : state;
}

/** The seat that must act now, or null (game over, or tournament between games / over). */
export function toActOf(state) {
  if (state.kind === 'tournament' && state.phase !== 'playing') return null;
  return currentGame(state).toAct;
}

/** The wind `seat` may not lead now under LEAD_RESTRICTION, ignoring the all-barred exception (R3.1, §10). */
export function barredSuit(rules, tricks, seat) {
  if (rules.LEAD_RESTRICTION === 'none' || tricks.length === 0) return null;
  const prev = tricks[tricks.length - 1];
  if (rules.LEAD_RESTRICTION === 'not_previous') return cardSuit(prev.lead);
  return prev.leader === seat ? cardSuit(prev.lead) : null; // not_own_previous
}

/**
 * The cards `seat` may play.
 * @param {string[]} hand    the seat's hand
 * @param {string|null} lead the card led this trick, or null if `seat` is leading
 * @param {object} rules
 * @param {object[]} tricks  completed tricks this game (only the last one is read)
 * @param {number} seat
 */
export function legalCards(hand, lead, rules, tricks, seat) {
  if (lead === null) {
    // R3.1: any card; a wind ban (variant) bars one wind unless the hand is all that wind.
    const barred = barredSuit(rules, tricks, seat);
    if (barred === null) return [...hand];
    const allowed = hand.filter((c) => cardSuit(c) !== barred);
    return allowed.length ? allowed : [...hand];
  }
  // R3.2: must follow the led wind if able; otherwise any card (drift).
  const same = hand.filter((c) => cardSuit(c) === cardSuit(lead));
  return same.length ? same : [...hand];
}

/** Every legal action for the seat to act: [{ type: 'play', card }]. Empty when nobody may act. */
export function getValidActions(state) {
  const seat = toActOf(state);
  if (seat === null) return [];
  const g = currentGame(state);
  return legalCards(g.hands[seat], g.lead, g.rules, g.tricks, seat).map((card) => ({ type: 'play', card }));
}

/**
 * Why `seat` may not play `card` now, as a sentence addressed to that player, or null if legal.
 * Checks in rule-book order.
 */
export function getPlayBlockReason(state, seat, card) {
  if (state.kind === 'tournament') {
    if (state.phase === 'over') return 'The tournament is over.';
    if (state.phase === 'between') return 'This game is over; start the next game first.';
  }
  const g = currentGame(state);
  if (g.phase === 'over') return 'The game is over.';
  if (seat !== g.toAct) {
    const role = ROLE_NAMES[g.roles[g.toAct]];
    return `It is not your turn: ${role} ${g.phase === 'lead' ? 'leads' : 'follows'} now.`;
  }
  const hand = g.hands[seat];
  if (!hand.includes(card)) return `You do not hold ${typeof card === 'string' ? card : JSON.stringify(card)}.`;
  const legal = legalCards(hand, g.lead, g.rules, g.tricks, seat);
  if (legal.includes(card)) return null;
  if (g.lead !== null) {
    const wind = SUIT_NAMES[cardSuit(g.lead)];
    return `You must follow ${wind}: you hold ${listCardNames(legal)}.`;
  }
  const barred = barredSuit(g.rules, g.tricks, seat);
  return `You may not lead ${SUIT_NAMES[barred]} twice in a row (wind ban), so ${cardName(card)} cannot be led.`;
}

/** Why an action object is refused, or null. */
export function getActionBlockReason(state, action) {
  if (!action || action.type !== 'play') return `Unknown action ${JSON.stringify(action)}; the only action is { type: 'play', card }.`;
  const seat = toActOf(state);
  if (seat === null) return getPlayBlockReason(state, -1, action.card);
  return getPlayBlockReason(state, seat, action.card);
}
