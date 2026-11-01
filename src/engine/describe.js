// describe.js - plain-English text for actions and events (log lines, button labels).
//
// Pure: takes data, returns strings. `names` is an optional per-seat label array the UI
// supplies (e.g. ['You', 'Easy bot']); roles are always named from the engine's data.

import { ROLE_NAMES, SUIT_NAMES } from './rules.js';
import { cardName } from './cards.js';

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function roleName(role) {
  return ROLE_NAMES[role];
}

function who(seat, role, names) {
  const r = ROLE_NAMES[role];
  return names && names[seat] ? `${names[seat]} (${r})` : cap(r);
}

/** 'wins' -> 'win' when the subject is "You" (the UI may name the human seat "You"). */
function verb(subject, v) {
  return /^You\b/.test(subject) ? v.replace(/s$/, '') : v;
}

function seatName(seat, names) {
  return names && names[seat] ? names[seat] : `Seat ${seat + 1}`;
}

export function describeAction(action) {
  return action.type === 'play' ? `Play ${cardName(action.card)}` : JSON.stringify(action);
}

export function describeCell(cell) {
  return `(${cell.x}, ${cell.y})`;
}

/**
 * One log line per event, or null for events not worth a line.
 * @param {object} ev
 * @param {string[]} roles  roles by seat (game.roles at the time of the event)
 * @param {string[]} [names]
 */
export function describeEvent(ev, roles, names) {
  switch (ev.type) {
    case 'card-played': {
      const s = who(ev.seat, ev.role, names);
      return `Trick ${ev.trickNo}: ${s} ${verb(s, ev.asLeader ? 'leads' : 'plays')} ${cardName(ev.card)}.`;
    }
    case 'trick-won': {
      const s = who(ev.winner, ev.winnerRole, names);
      return `${s} ${verb(s, 'wins')} trick ${ev.trickNo}${ev.followed ? '' : ' (the follower could not follow)'}.`;
    }
    case 'whale-moved': {
      if (ev.dirSuit === null) return 'The whale does not move.';
      const dir = ev.reversed ? { N: 'South', E: 'West', S: 'North', W: 'East' }[ev.dirSuit] : SUIT_NAMES[ev.dirSuit];
      if (ev.blocked) return `The whale is pushed ${dir} but is at the edge, so it stays at ${describeCell(ev.to)}.`;
      return `The whale moves ${dir} to ${describeCell(ev.to)}.`;
    }
    case 'game-over': {
      const r = ev.winnerRole === 'ahab' ? 'Ahab wins: the whale ends in harpoon range.' : (ev.reason === 'escape' ? 'The Whale escapes to the open sea and wins.' : 'The Whale wins: it ends on the open sea.');
      return names && names[ev.winnerSeat] ? `${r} (${names[ev.winnerSeat]})` : r;
    }
    case 'tournament-game-recorded':
      return `Game ${ev.gameNo} goes to ${seatName(ev.winnerSeat, names)}. Score ${ev.wins[0]}-${ev.wins[1]}.`;
    case 'tournament-over': {
      const s = seatName(ev.winnerSeat, names);
      return `${s} ${verb(s, 'wins')} the tournament ${ev.wins[ev.winnerSeat]}-${ev.wins[1 - ev.winnerSeat]}.`;
    }
    case 'game-started': {
      const s = who(ev.firstLeader, ev.roles[ev.firstLeader], names);
      return `Game ${ev.gameNo}: ${who(0, ev.roles[0], names)} and ${who(1, ev.roles[1], names)}; ${s} ${verb(s, 'leads')} first.`;
    }
    default:
      return null;
  }
}
