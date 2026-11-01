// index.js - the engine's public API. Import from here, not from the files behind it.

export { SUITS, SUIT_NAMES, VECTORS, OPPOSITE, ROLES, ROLE_NAMES, VARIANTS, DEFAULT_RULES, resolveVariants } from './rules.js';
export { makeRng, deriveSeed, hashSeed, cloneRng, rngNext, rngInt, rngPick, shuffle, forkRng } from './rng.js';
export { cardSuit, cardRank, makeCard, isCard, fullDeck, compareCards, sortCards, cardName, listCardNames } from './cards.js';
export { centre, startCell, centreDistance, isOpenSea, inHarpoonRange, isOffChart, stepWhale, outcomeCells } from './board.js';
export { createGame, createTournament, resolveRoles } from './state.js';
export { currentGame, toActOf, barredSuit, legalCards, getValidActions, getPlayBlockReason, getActionBlockReason } from './legality.js';
export { applyAction, startNextGame } from './actions.js';
export { gameResult, tournamentResult } from './scoring.js';
export { viewFor, legalActionsFromView, shownVoids, playedCards, unknownCards, determinise } from './view.js';
export { roleName, describeAction, describeCell, describeEvent } from './describe.js';
