// text.js - the readable sentences of the UI. Pure: data in, strings out, so Node can test it.
//
// Nothing here decides a rule. It only words what the engine already decided: a completed
// trick record ({ leader, follower, lead, follow, followed, winner, dirSuit, reversed, blocked })
// from game.tricks.

import { SUIT_NAMES, OPPOSITE, cardName, cardSuit } from '../engine/index.js';

export const ROLE_LABEL = { ahab: 'Ahab', whale: 'Whale' };

/** The wind the whale actually travelled (or was pushed) along, or null if it was not pushed. */
export function moveDir(trick) {
  if (!trick || !trick.dirSuit) return null;
  return trick.reversed ? OPPOSITE[trick.dirSuit] : trick.dirSuit;
}

/** "the whale moves East" and its variants (opposite, drift, blocked at the edge). */
export function moveClause(trick) {
  const dir = moveDir(trick);
  if (!dir) return 'the whale does not move';
  const name = SUIT_NAMES[dir];
  if (trick.blocked) return `the whale is pushed ${name} but is at the edge, so it stays put`;
  if (!trick.followed) return `the whale drifts ${name}`;
  return trick.reversed ? `the whale moves ${name}, the opposite of the led wind` : `the whale moves ${name}`;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * One trick as a sentence, by role:
 * "Whale led East 9, Ahab followed East 4: the leader wins, the whale moves East."
 * @param {object} trick  a completed trick record
 * @param {string[]} roles  roles by seat
 */
export function trickSentence(trick, roles) {
  const L = ROLE_LABEL[roles[trick.leader]];
  const F = ROLE_LABEL[roles[trick.follower]];
  const move = moveClause(trick);
  if (trick.followed) {
    const who = trick.winner === trick.leader ? 'the leader' : 'the follower';
    return `${L} led ${cardName(trick.lead)}, ${F} followed ${cardName(trick.follow)}: ${who} wins, ${move}.`;
  }
  const wind = SUIT_NAMES[cardSuit(trick.lead)];
  return `${L} led ${cardName(trick.lead)}, ${F} had no ${wind} and played ${cardName(trick.follow)}: ${L} wins, ${move}.`;
}

/** A short form for the trick area: "Leader wins - the whale moves East". */
export function trickHeadline(trick) {
  const dir = moveDir(trick);
  const who = trick.followed ? (trick.winner === trick.leader ? 'Leader wins' : 'Follower wins') : 'Drift: leader wins';
  if (!dir) return who;
  const name = SUIT_NAMES[dir];
  if (trick.blocked) return `${who}, whale pushed ${name} but stays (edge)`;
  return `${who}, the whale ${trick.followed ? 'moves' : 'drifts'} ${name}`;
}

/** The phrase for "if you play this card" when following; `t` is the trick the engine would record. */
export function followPreviewText(t, followCard) {
  const name = cardName(followCard);
  const dir = moveDir(t);
  const dirName = dir ? SUIT_NAMES[dir] : '';
  if (!t.followed) {
    if (t.blocked) return `${name}: you cannot follow, so the leader wins. Your wind would push the whale ${dirName}, but it is at the edge and stays put.`;
    return `${name}: you cannot follow, so the leader wins and the whale drifts ${dirName}, the wind of your card.`;
  }
  if (t.blocked) return `${name}: ${t.winner === t.leader ? 'the leader wins' : 'you win'}. The whale would be pushed ${dirName} but is at the edge, so it stays put.`;
  if (t.winner === t.leader) return `${name}: the leader wins, so the whale moves ${dirName}.`;
  return `${name}: you win, so the whale moves ${dirName}, the opposite of the led wind.`;
}

/** The phrase for "if you lead this card"; `win`/`lose` are the engine's outcome cells for the whale. */
export function leadPreviewText(card, whale, winCell, loseCell) {
  const suit = cardSuit(card);
  const fwd = SUIT_NAMES[suit];
  const back = SUIT_NAMES[OPPOSITE[suit]];
  const same = (a, b) => a.x === b.x && a.y === b.y;
  const winTxt = same(winCell, whale) ? `${fwd} (stays: edge)` : fwd;
  const loseTxt = same(loseCell, whale) ? `${back} (stays: edge)` : back;
  return `Lead ${cardName(card)}: if ${fwd} is followed, the higher card wins. You win: the whale goes ${winTxt}. They win: ${loseTxt}. If they hold no ${fwd}, their discard steers instead.`;
}
