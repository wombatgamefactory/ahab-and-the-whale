// cards.js - card ids, the deck, sorting and display names.
//
// A card id is a string: suit letter (N, E, S, W) then rank, e.g. 'N7', 'W1', 'E9'.
// The same format as the Python sim's Card.__str__. Ace is shown as 1 (rule list §11.3).

import { SUITS, SUIT_NAMES } from './rules.js';

export function cardSuit(card) {
  return card[0];
}

export function cardRank(card) {
  return Number(card.slice(1));
}

export function makeCard(suit, rank) {
  return `${suit}${rank}`;
}

/** True if `card` is a well-formed id for a deck with ranks 1..maxRank. */
export function isCard(card, maxRank = 9) {
  if (typeof card !== 'string' || !/^[NESW][1-9][0-9]?$/.test(card)) return false;
  const r = cardRank(card);
  return r >= 1 && r <= maxRank;
}

/** The whole deck ordered by suit (N, E, S, W) then rank (R1.1). */
export function fullDeck(maxRank = 9) {
  const deck = [];
  for (const s of SUITS) for (let r = 1; r <= maxRank; r++) deck.push(makeCard(s, r));
  return deck;
}

/** Sort key: suit order then rank (R2.5 display order; also the sim's sort order). */
export function compareCards(a, b) {
  const ds = SUITS.indexOf(cardSuit(a)) - SUITS.indexOf(cardSuit(b));
  return ds !== 0 ? ds : cardRank(a) - cardRank(b);
}

export function sortCards(cards) {
  return [...cards].sort(compareCards);
}

/** 'N7' -> 'North 7'. */
export function cardName(card) {
  return `${SUIT_NAMES[cardSuit(card)]} ${cardRank(card)}`;
}

/** ['N3', 'N7'] -> 'North 3 and North 7'; three or more use commas. */
export function listCardNames(cards) {
  const names = cards.map(cardName);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
