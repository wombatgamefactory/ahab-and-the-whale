// controller.js - game flow and the bot driver, with no DOM.
//
// The UI layer (main.js now, the bespoke UI later) owns rendering and timing; this module
// owns everything else: creating the game or tournament from the setup choices, applying
// human and bot actions, the bot failure cap, the event log, tournament progression and
// the pass-the-device rule for two humans. It runs unchanged in Node (tests/controller.mjs).

import {
  createGame, createTournament, resolveRoles, applyAction, startNextGame, getValidActions,
  getPlayBlockReason, toActOf, currentGame, viewFor, legalActionsFromView, describeEvent,
  makeRng, deriveSeed, getActionBlockReason,
} from '../engine/index.js';
import { getBot } from '../bots/index.js';

/** Bot proposals refused in a row before the driver plays the first legal card instead. */
export const MAX_BOT_FAILURES = 3;

/**
 * @param {object} cfg
 * @param {{type: string}[]} cfg.seats      per seat: 'human' or a bot level ('easy', ...)
 * @param {string[]} [cfg.roleChoices]      per seat: 'ahab' | 'whale' | 'random' (R6.2)
 * @param {'single'|'tournament'} [cfg.mode]
 * @param {number|string} cfg.seed          the UI picks it (e.g. from the clock); required
 * @param {string[]} [cfg.names]            per-seat labels for the log
 * @param {object} [cfg.rules]              rule overrides (the web UI passes none, R6.5)
 */
export function createController(cfg) {
  const seats = cfg.seats.map((s) => ({ type: s.type }));
  for (const s of seats) if (s.type !== 'human') getBot(s.type); // throws on an unknown level
  const mode = cfg.mode || 'single';
  if (cfg.seed === undefined || cfg.seed === null) throw new Error('createController needs a seed');
  const seed = cfg.seed;
  const roles = resolveRoles(...(cfg.roleChoices || ['random', 'random']), makeRng(deriveSeed(seed, 'roles')));
  const names = cfg.names || seats.map((s, i) => (s.type === 'human' ? `Seat ${i + 1}` : `${getBot(s.type).label} bot`));
  const state = mode === 'tournament'
    ? createTournament({ seed, roles, rules: cfg.rules })
    : createGame({ seed, roles, rules: cfg.rules });
  const botRngs = [0, 1].map((seat) => makeRng(deriveSeed(seed, 'bot', seat)));
  const log = []; // { text, event }
  const listeners = new Set();
  let revealedSeat = null; // hotseat: whose hand is on show
  let lastEvents = [];
  let botRefusals = 0; // total refused bot proposals (should stay 0)
  let workerFailures = 0; // consecutive refused answers through applyBotResult()

  function emit(events) {
    lastEvents = events;
    const roles = currentGame(state).roles;
    for (const ev of events) {
      const text = describeEvent(ev, roles, names);
      if (text) log.push({ text, event: ev });
    }
    for (const fn of listeners) fn(api);
  }

  const bothHuman = seats[0].type === 'human' && seats[1].type === 'human';

  const api = {
    mode,
    seed,
    seats,
    names,
    get state() { return state; },
    get log() { return log; },
    get lastEvents() { return lastEvents; },
    get botRefusals() { return botRefusals; },
    game() { return currentGame(state); },
    toAct() { return toActOf(state); },
    isBotTurn() {
      const s = toActOf(state);
      return s !== null && seats[s].type !== 'human';
    },
    isHumanTurn() {
      const s = toActOf(state);
      return s !== null && seats[s].type === 'human';
    },
    /** Legal actions for the seat to act (whoever it is). */
    legalActions() { return getValidActions(state); },
    blockReason(card) {
      const s = toActOf(state);
      return getPlayBlockReason(state, s === null ? -1 : s, card);
    },
    view(seat) { return viewFor(state, seat); },
    isGameOver() { return currentGame(state).phase === 'over'; },
    /** True when nothing more can happen: a finished single game or a finished tournament. */
    isFinished() {
      return state.phase === 'over'; // the game's phase, or the tournament's
    },
    canStartNextGame() { return mode === 'tournament' && state.phase === 'between'; },

    /** A human action. Returns { ok: true, events } or { ok: false, error } (never throws for a refusal). */
    play(action) {
      if (!api.isHumanTurn()) return { ok: false, error: 'It is not a human player\'s turn.' };
      const reason = getActionBlockReason(state, action);
      if (reason) return { ok: false, error: reason };
      const events = applyAction(state, action);
      emit(events);
      return { ok: true, events };
    },

    /** Plays one bot action if a bot is to act. Returns the events, or null if no bot was to act. */
    stepBot() {
      if (!api.isBotTurn()) return null;
      const seat = toActOf(state);
      const bot = getBot(seats[seat].type);
      for (let attempt = 0; attempt < MAX_BOT_FAILURES; attempt++) {
        let action = null;
        try {
          action = bot.chooseAction(viewFor(state, seat), botRngs[seat]);
        } catch (e) {
          action = null;
        }
        if (action && getActionBlockReason(state, action) === null) {
          const events = applyAction(state, action);
          emit(events);
          return events;
        }
        botRefusals += 1;
      }
      // Failure cap tripped: play the first legal card so the game can never hang.
      const fallback = legalActionsFromView(viewFor(state, seat))[0];
      const events = applyAction(state, fallback);
      emit(events);
      return events;
    },

    /**
     * For a bot that thinks somewhere else (a Web Worker): everything it needs, as plain JSON.
     * `stamp` names the decision, so a late answer for an old position can be recognised.
     * Returns null if no bot is to act. Pair it with applyBotResult().
     */
    botTask() {
      if (!api.isBotTurn()) return null;
      const seat = toActOf(state);
      const g = currentGame(state);
      return {
        seat,
        level: seats[seat].type,
        view: viewFor(state, seat),
        rng: { s: botRngs[seat].s },
        stamp: `${state.kind === 'tournament' ? state.gameNo : 0}:${g.trickNo}:${g.phase}:${seat}`,
      };
    },

    /**
     * Applies an answer to a botTask(): result = { action, rng } or null if the bot failed.
     * Same failure cap as stepBot(): after MAX_BOT_FAILURES refusals in a row the first legal
     * card is played. Returns the events, 'stale' if the position has moved on, or null if the
     * answer was refused (the caller asks again; the cap guarantees that ends).
     */
    applyBotResult(task, result) {
      const now = api.botTask();
      if (!now || now.stamp !== task.stamp) return 'stale';
      const seat = task.seat;
      if (result && result.rng && Number.isInteger(result.rng.s)) botRngs[seat].s = result.rng.s;
      const action = result && result.action;
      if (action && getActionBlockReason(state, action) === null) {
        workerFailures = 0;
        const events = applyAction(state, action);
        emit(events);
        return events;
      }
      botRefusals += 1;
      workerFailures += 1;
      if (workerFailures >= MAX_BOT_FAILURES) {
        workerFailures = 0;
        const fallback = legalActionsFromView(viewFor(state, seat))[0];
        const events = applyAction(state, fallback);
        emit(events);
        return events;
      }
      return null;
    },

    /** Plays bot turns until a human must act or the game ends (for tests and instant play). */
    runBots(limit = 1000) {
      let n = 0;
      while (api.isBotTurn() && n < limit) { api.stepBot(); n++; }
      return n;
    },

    startNextGame() {
      const events = startNextGame(state);
      revealedSeat = null;
      emit(events);
      return events;
    },

    /** Hotseat (two humans): true when the hand must be hidden until the next player confirms. */
    needsHandoff() {
      if (!bothHuman) return false;
      const s = toActOf(state);
      return s !== null && s !== revealedSeat;
    },
    reveal(seat) {
      revealedSeat = seat;
      for (const fn of listeners) fn(api);
    },
    /** The seat whose hand the screen may show now (null = show none). */
    shownSeat() {
      if (!bothHuman) return seats[0].type === 'human' ? 0 : (seats[1].type === 'human' ? 1 : null);
      return revealedSeat;
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return api;
}
