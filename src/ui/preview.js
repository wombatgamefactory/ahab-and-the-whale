// preview.js - "where would the whale go if I played this card?" Pure, runs in Node.
//
// Never re-derives a rule. As the FOLLOWER the answer is certain, so the engine plays the
// card on a clone of the game and the resulting trick record is read back. As the LEADER the
// answer depends on the opponent's reply, so the engine's own geometry (outcomeCells) gives
// the two followed-suit outcomes (leader wins / follower wins) and the text says that a drift
// reply is decided by the opponent's discard.

import { applyAction, outcomeCells, cardSuit, OPPOSITE } from '../engine/index.js';
import { moveDir, followPreviewText, leadPreviewText } from './text.js';

const clone = (x) => JSON.parse(JSON.stringify(x));

/**
 * @param {object} game  the current game state (ctl.game()); the viewer must be the seat to act
 * @param {string} card  a card id the seat holds
 * @returns {null | { kind: 'follow'|'lead', text: string, ghosts: {cell, dir, tone, stays}[] }}
 *   ghosts: tone 'sure' (certain), 'win' / 'lose' (leader's two possible outcomes);
 *   stays: the step is blocked at the edge, so the ghost sits on the whale's own cell.
 */
export function previewCard(game, card) {
  if (!game || game.phase === 'over') return null;
  if (game.phase === 'follow') {
    const copy = clone(game);
    try {
      applyAction(copy, { type: 'play', card }, {});
    } catch {
      return null; // an illegal card has no preview
    }
    const t = copy.tricks[copy.tricks.length - 1];
    const dir = moveDir(t);
    return {
      kind: 'follow',
      text: followPreviewText(t, card),
      ghosts: dir ? [{ cell: t.to, dir, tone: 'sure', stays: t.blocked }] : [],
    };
  }
  const suit = cardSuit(card);
  const cells = outcomeCells(game.whale, suit, game.rules);
  const same = (a) => a.x === game.whale.x && a.y === game.whale.y;
  return {
    kind: 'lead',
    text: leadPreviewText(card, game.whale, cells.leaderWins, cells.followerWins),
    ghosts: [
      { cell: cells.leaderWins, dir: suit, tone: 'win', stays: same(cells.leaderWins) },
      { cell: cells.followerWins, dir: OPPOSITE[suit], tone: 'lose', stays: same(cells.followerWins) },
    ],
  };
}
