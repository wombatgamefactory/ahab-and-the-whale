// board.js - sea chart geometry and the whale's one-step move.
//
// A cell is { x, y }, each 0..GRID_SIZE-1; x grows East, y grows South (R1.4).
// Every function takes the resolved `rules` object (state.rules or view.rules).

import { VECTORS, OPPOSITE } from './rules.js';

export function centre(rules) {
  return Math.floor(rules.GRID_SIZE / 2);
}

export function startCell(rules) {
  const c = centre(rules);
  return { x: c, y: c }; // R1.7
}

/** Chebyshev distance from the centre (R1.8). */
export function centreDistance(cell, rules) {
  const c = centre(rules);
  return Math.max(Math.abs(cell.x - c), Math.abs(cell.y - c));
}

/** Open sea = the outer ring (R1.6). */
export function isOpenSea(cell, rules) {
  const last = rules.GRID_SIZE - 1;
  return cell.x === 0 || cell.y === 0 || cell.x === last || cell.y === last;
}

/** Harpoon range = within HARPOON_RADIUS of the centre (R1.6). */
export function inHarpoonRange(cell, rules) {
  return centreDistance(cell, rules) <= rules.HARPOON_RADIUS;
}

export function isOffChart(cell, rules) {
  const last = rules.GRID_SIZE - 1;
  return cell.x < 0 || cell.y < 0 || cell.x > last || cell.y > last;
}

/**
 * One whale step from `cell` in the direction of wind `suit`, reversed if `reverse`
 * (R4.1). A step off the chart is blocked: the whale stays (R4.3).
 * @returns {{ to: {x:number,y:number}, blocked: boolean, dir: string }}
 */
export function stepWhale(cell, suit, reverse, rules) {
  const dir = reverse ? OPPOSITE[suit] : suit;
  const [dx, dy] = VECTORS[dir];
  const next = { x: cell.x + dx, y: cell.y + dy };
  if (isOffChart(next, rules)) return { to: { x: cell.x, y: cell.y }, blocked: true, dir };
  return { to: next, blocked: false, dir };
}

/**
 * Where a followed-suit trick on `ledSuit` would put the whale:
 * { leaderWins, followerWins } (the led direction, then its opposite).
 */
export function outcomeCells(cell, ledSuit, rules) {
  return {
    leaderWins: stepWhale(cell, ledSuit, false, rules).to,
    followerWins: stepWhale(cell, ledSuit, true, rules).to,
  };
}
