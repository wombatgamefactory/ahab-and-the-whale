// index.js - the bot registry, by level name.
//
// A bot is { id, label, chooseAction(view, rng) -> action }.
//   - `view` is viewFor(state, seat): never the full state (rule R8.6).
//   - `rng` is the bot's own RNG object; the driver derives it (deriveSeed(seed, 'bot', seat)).
//   - It must return one of legalActionsFromView(view). It may keep no memory between
//     calls except caches that do not change its answers.
//
// Levels: 'easy' (random.js), 'medium' (greedy.js), 'hard' (lookahead.js).

import { randomBot } from './random.js';
import { greedyBot } from './greedy.js';
import { lookaheadBot } from './lookahead.js';

const REGISTRY = new Map();

export function registerBot(bot) {
  if (!bot || typeof bot.id !== 'string' || typeof bot.chooseAction !== 'function') {
    throw new Error('A bot needs an id and a chooseAction(view, rng) function');
  }
  REGISTRY.set(bot.id, bot);
}

export function getBot(level) {
  const bot = REGISTRY.get(level);
  if (!bot) throw new Error(`Unknown bot level "${level}". Known: ${[...REGISTRY.keys()].join(', ')}`);
  return bot;
}

export function botLevels() {
  return [...REGISTRY.values()].map((b) => ({ id: b.id, label: b.label }));
}

registerBot(randomBot);
registerBot(greedyBot);
registerBot(lookaheadBot);
