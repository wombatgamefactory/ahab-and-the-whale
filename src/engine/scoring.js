// scoring.js - the game result and the tournament result.
//
// A game has no score (R5.2): the whale's cell after the last trick decides it (R5.1).

import { isOpenSea, inHarpoonRange } from './board.js';

/**
 * The result of a finished game.
 * reason: 'open-sea' (R5.1, Whale wins), 'harpoon-range' (R5.1, Ahab wins),
 *         'escape' (ESCAPE_CHECK immediate variant: reached open sea mid-game),
 *         'outside-range' (only possible when HARPOON_RADIUS leaves a gap between
 *         harpoon range and open sea; the Whale wins, as in the sim's defaults).
 * @param {object} game  a game state
 * @param {boolean} escaped  the game ended early by an immediate escape
 * @returns {{ winnerRole: string, winnerSeat: number, whale: {x:number,y:number}, reason: string, tricksPlayed: number }}
 */
export function gameResult(game, escaped = false) {
  let winnerRole;
  let reason;
  if (escaped) {
    winnerRole = 'whale';
    reason = 'escape';
  } else if (isOpenSea(game.whale, game.rules)) {
    winnerRole = 'whale';
    reason = 'open-sea';
  } else if (inHarpoonRange(game.whale, game.rules)) {
    winnerRole = 'ahab';
    reason = 'harpoon-range';
  } else {
    winnerRole = 'whale';
    reason = 'outside-range';
  }
  return {
    winnerRole,
    winnerSeat: game.roles.indexOf(winnerRole),
    whale: { x: game.whale.x, y: game.whale.y },
    reason,
    tricksPlayed: game.trickNo,
  };
}

/**
 * The tournament standing: { wins, winnerSeat (null until decided), gamesPlayed, over }.
 */
export function tournamentResult(t) {
  return {
    wins: [...t.wins],
    winnerSeat: t.winnerSeat,
    gamesPlayed: t.history.length,
    over: t.phase === 'over',
  };
}
