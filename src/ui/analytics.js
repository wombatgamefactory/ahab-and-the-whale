/**
 * Google Analytics events: usage only. Game RESULTS stay in the browser (stats-store.js).
 * Nothing sent from here says who won, which role won, or where the whale ended; there are no
 * such parameters, and track() drops any parameter that is not on the ALLOWED_PARAMS list, so a
 * future edit cannot leak one by accident.
 *
 *   game_start, game_end, game_abandoned      one game (a tournament game counts as a game)
 *   tournament_start, tournament_end          a first-to-3 series
 *   stats_viewed, stats_exported (format)     the local stats screen
 *   rules_opened (where: dialog | pdf)
 *
 * Every call is a no-op when gtag is missing (ad blocker, banner refusal, tests), and a failure
 * here never reaches the game.
 */

export const GAME_NAME = 'ahab-and-the-whale';

export const ALLOWED_PARAMS = [
  'game_name', 'mode', 'human_players', 'bot_players', 'bot_levels', 'tricks',
  'duration_seconds', 'game_number', 'games_played', 'format', 'where',
];

export const EVENT_NAMES = [
  'game_start', 'game_end', 'game_abandoned', 'tournament_start', 'tournament_end',
  'stats_viewed', 'stats_exported', 'rules_opened',
];

let game = null; // { startedAt, ended, base, tricks, gameNumber }
let tournament = null; // { startedAt, ended }
let clock = () => Date.now();

/** Tests only. */
export function _setClock(fn) { clock = fn; }
export function _reset() { game = null; tournament = null; }

function track(name, params) {
  try {
    if (typeof window === 'undefined' || typeof window.gtag !== 'function') return;
    const clean = {};
    for (const k of ALLOWED_PARAMS) {
      if (params && params[k] !== undefined && params[k] !== null) clean[k] = params[k];
    }
    window.gtag('event', name, clean);
  } catch {
    // Deliberately silent: analytics is allowed to fail.
  }
}

function seatCounts(seats) {
  const humans = seats.filter((t) => t === 'human').length;
  const levels = seats.filter((t) => t !== 'human').sort();
  return { human_players: humans, bot_players: levels.length, bot_levels: levels.length ? levels.join(',') : 'none' };
}

const baseOf = (info) => ({ game_name: GAME_NAME, mode: info.mode, ...seatCounts(info.seats) });
const secondsSince = (t) => Math.max(0, Math.round((clock() - t) / 1000));

export function trackTournamentStart(info) {
  try {
    tournament = { startedAt: clock(), ended: false };
    track('tournament_start', baseOf(info));
  } catch { /* silent */ }
}

export function trackGameStart(info) {
  try {
    const base = baseOf(info);
    if (info.mode === 'tournament') base.game_number = info.gameNo;
    game = { startedAt: clock(), ended: false, base, tricks: 0 };
    track('game_start', base);
  } catch { /* silent */ }
}

/** Counts completed tricks, so an abandoned game can say how far it got. */
export function trackCardPlayed(info) {
  try { if (game && info.trickDone) game.tricks += 1; } catch { /* silent */ }
}

export function trackGameEnd() {
  try {
    if (!game || game.ended) return;
    game.ended = true;
    track('game_end', { ...game.base, tricks: game.tricks, duration_seconds: secondsSince(game.startedAt) });
  } catch { /* silent */ }
}

export function trackTournamentEnd(info) {
  try {
    if (tournament) tournament.ended = true;
    track('tournament_end', {
      ...baseOf(info),
      games_played: info.gamesPlayed,
      duration_seconds: tournament ? secondsSince(tournament.startedAt) : 0,
    });
  } catch { /* silent */ }
}

export function trackStatsViewed() { track('stats_viewed', { game_name: GAME_NAME }); }
export function trackStatsExported(format) { track('stats_exported', { game_name: GAME_NAME, format }); }
export function trackRulesOpened(where) { track('rules_opened', { game_name: GAME_NAME, where }); }

/**
 * A game that is still running when the player leaves it: either by going back to the setup
 * screen (main.js calls trackGameAbandoned) or because the page goes away (pagehide). Fires at
 * most once per game, with the same parameters as game_end.
 */
export function trackGameAbandoned({ beacon = false } = {}) {
  try {
    if (!game || game.ended) return;
    game.ended = true;
    const params = pick({ ...game.base, tricks: game.tricks, duration_seconds: secondsSince(game.startedAt) });
    if (beacon) params.transport_type = 'beacon'; // lets the hit survive a closing page
    if (typeof window !== 'undefined' && typeof window.gtag === 'function') window.gtag('event', 'game_abandoned', params);
  } catch { /* silent */ }
}

/** pagehide (not beforeunload) because it also fires on mobile and in the back/forward cache. */
export function installAbandonTracking() {
  try {
    window.addEventListener('pagehide', () => trackGameAbandoned({ beacon: true }));
  } catch { /* silent */ }
}

function pick(params) {
  const clean = {};
  for (const k of ALLOWED_PARAMS) if (params[k] !== undefined && params[k] !== null) clean[k] = params[k];
  return clean;
}
