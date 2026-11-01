// smoke.mjs - Easy v Easy: 1000 games and 200 tournaments terminate, zero refused bot
// proposals, the state JSON round-trips at every step (play continues on the copy), and
// the same seed gives an identical game.
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure.

import {
  createGame, createTournament, applyAction, startNextGame, getValidActions, getActionBlockReason,
  viewFor, legalActionsFromView, toActOf, makeRng, deriveSeed,
} from '../src/engine/index.js';
import { getBot } from '../src/bots/index.js';
import { suite } from './lib.mjs';

const { check, done } = suite('smoke');
const MAX_ACTIONS_PER_GAME = 100; // a game is exactly 24 actions; anything near this is a livelock

/** Plays the current game of `state` to its end with bots; returns { state, refusals, actions, events, ok }. */
function playOut(state, levels, botRngs) {
  let refusals = 0;
  let actions = 0;
  let roundTripOk = true;
  let viewOk = true;
  const events = [];
  while (toActOf(state) !== null && actions < MAX_ACTIONS_PER_GAME) {
    const seat = toActOf(state);
    const view = viewFor(state, seat);
    if (JSON.stringify(legalActionsFromView(view)) !== JSON.stringify(getValidActions(state))) viewOk = false;
    const action = getBot(levels[seat]).chooseAction(view, botRngs[seat]);
    if (getActionBlockReason(state, action) !== null) { refusals++; break; }
    events.push(...applyAction(state, action));
    actions++;
    const text = JSON.stringify(state);
    const copy = JSON.parse(text);
    if (JSON.stringify(copy) !== text) roundTripOk = false;
    state = copy; // continue on the round-tripped copy
  }
  return { state, refusals, actions, events, roundTripOk, viewOk };
}

// ---------- 1000 games ----------
{
  let refusals = 0; let unfinished = 0; let badRoundTrip = 0; let badView = 0; let ahab = 0; let firstLeaderWins = 0;
  for (let i = 0; i < 1000; i++) {
    const seed = deriveSeed('smoke', i);
    const roles = i % 2 ? ['ahab', 'whale'] : ['whale', 'ahab'];
    const r = playOut(createGame({ seed, roles }), ['easy', 'easy'], [makeRng(deriveSeed(seed, 'bot', 0)), makeRng(deriveSeed(seed, 'bot', 1))]);
    refusals += r.refusals;
    badRoundTrip += !r.roundTripOk;
    badView += !r.viewOk;
    const g = r.state;
    if (g.phase !== 'over' || r.actions !== 24 || g.trickNo !== 12) unfinished++;
    else {
      ahab += g.result.winnerRole === 'ahab';
      firstLeaderWins += g.result.winnerSeat === g.firstLeader;
    }
  }
  check('1000 games all finish in exactly 24 actions', unfinished === 0, `${unfinished} unfinished`);
  check('zero refused bot proposals (games)', refusals === 0, `${refusals}`);
  check('state JSON round-trips at every step (games)', badRoundTrip === 0, `${badRoundTrip} games`);
  check('legalActionsFromView equals getValidActions at every step', badView === 0, `${badView} games`);
  console.log(`  1000 random games: Ahab won ${ahab} (${(ahab / 10).toFixed(1)}%); first leader won ${firstLeaderWins}`);
  check('random-v-random Ahab rate is plausible (sim reports ~51.5%)', ahab > 420 && ahab < 610, `${ahab}`);
}

// ---------- 200 tournaments ----------
{
  let refusals = 0; let bad = 0; let badRoundTrip = 0; const lengths = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 200; i++) {
    const seed = deriveSeed('tsmoke', i);
    let t = createTournament({ seed, roles: i % 2 ? ['ahab', 'whale'] : ['whale', 'ahab'] });
    const rngs = [makeRng(deriveSeed(seed, 'bot', 0)), makeRng(deriveSeed(seed, 'bot', 1))];
    let guard = 0;
    while (t.phase !== 'over' && guard++ < 10) {
      if (t.phase === 'between') startNextGame(t);
      const r = playOut(t, ['easy', 'easy'], rngs);
      refusals += r.refusals;
      badRoundTrip += !r.roundTripOk;
      t = r.state;
    }
    if (t.phase !== 'over' || t.history.length > 5 || Math.max(...t.wins) !== 3) bad++;
    else lengths[t.history.length]++;
  }
  check('200 tournaments end with a seat on 3 wins within 5 games', bad === 0, `${bad} bad`);
  check('zero refused bot proposals (tournaments)', refusals === 0, `${refusals}`);
  check('state JSON round-trips at every step (tournaments)', badRoundTrip === 0);
  console.log(`  200 tournaments: lengths 3/4/5 games = ${lengths[3]}/${lengths[4]}/${lengths[5]}`);
}

// ---------- determinism ----------
{
  const run = (seed) => {
    const r = playOut(createGame({ seed }), ['easy', 'easy'], [makeRng(deriveSeed(seed, 'bot', 0)), makeRng(deriveSeed(seed, 'bot', 1))]);
    return JSON.stringify([r.state, r.events]);
  };
  check('same seed -> identical game (state and events)', run('det-1') === run('det-1'));
  check('different seed -> different game', run('det-1') !== run('det-2'));
  const runT = (seed) => {
    let t = createTournament({ seed });
    const rngs = [makeRng(1), makeRng(2)];
    while (t.phase !== 'over') { if (t.phase === 'between') startNextGame(t); t = playOut(t, ['easy', 'easy'], rngs).state; }
    return JSON.stringify(t);
  };
  check('same seed -> identical tournament', runT('det-t') === runT('det-t'));
}

done();
