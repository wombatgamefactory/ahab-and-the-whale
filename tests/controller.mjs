// controller.mjs - drives src/ui/controller.js in Node with scripted "human" choices:
// a full human-v-Easy game, a full human-v-Easy tournament, a hotseat game with the
// pass-the-device rule, refusals, and the bot failure cap.
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure.

import { createController, MAX_BOT_FAILURES } from '../src/ui/controller.js';
import { registerBot } from '../src/bots/index.js';
import { makeRng, rngPick } from '../src/engine/index.js';
import { suite } from './lib.mjs';

const { check, done } = suite('controller');

/** Scripted human: picks a random legal card, but first tries an illegal one when there is one. */
function humanTurn(ctl, rng, stats) {
  const legal = ctl.legalActions().map((a) => a.card);
  const hand = ctl.game().hands[ctl.toAct()];
  const illegal = hand.find((c) => !legal.includes(c));
  if (illegal) {
    const res = ctl.play({ type: 'play', card: illegal });
    if (!res.ok && res.error) stats.refusalMessages++;
    else stats.badAccept++;
  }
  const res = ctl.play({ type: 'play', card: rngPick(rng, legal) });
  if (!res.ok) stats.badRefuse++;
}

// ---------- human v Easy, single game ----------
{
  const ctl = createController({ seats: [{ type: 'human' }, { type: 'easy' }], roleChoices: ['random', 'random'], mode: 'single', seed: 11 });
  const rng = makeRng('h1');
  const stats = { refusalMessages: 0, badAccept: 0, badRefuse: 0 };
  let changes = 0;
  ctl.subscribe(() => changes++);
  let guard = 0;
  while (!ctl.isFinished() && guard++ < 200) {
    ctl.runBots();
    if (ctl.isHumanTurn()) {
      check('single: the human seat is shown its own hand', ctl.shownSeat() === 0 && !ctl.needsHandoff());
      humanTurn(ctl, rng, stats);
    }
  }
  const g = ctl.game();
  check('single: human v Easy game finishes', ctl.isFinished() && g.phase === 'over' && g.trickNo === 12);
  check('single: illegal clicks are refused with a message, legal ones accepted', stats.badAccept === 0 && stats.badRefuse === 0);
  check('single: subscribers are notified', changes >= 24);
  check('single: the log has a game-over line', ctl.log.some((l) => l.event.type === 'game-over'));
  check('single: zero bot refusals', ctl.botRefusals === 0);
  check('single: no next game in single mode', !ctl.canStartNextGame());
}

// ---------- human v Easy, tournament ----------
{
  const ctl = createController({ seats: [{ type: 'easy' }, { type: 'human' }], roleChoices: ['ahab', 'random'], mode: 'tournament', seed: 'tour', names: ['Easy bot', 'You'] });
  const rng = makeRng('h2');
  const stats = { refusalMessages: 0, badAccept: 0, badRefuse: 0 };
  let guard = 0;
  let gamesStarted = 1;
  while (!ctl.isFinished() && guard++ < 2000) {
    ctl.runBots();
    if (ctl.isHumanTurn()) humanTurn(ctl, rng, stats);
    else if (ctl.canStartNextGame()) { ctl.startNextGame(); gamesStarted++; }
  }
  const t = ctl.state;
  check('tournament: finishes with a seat on 3 wins', ctl.isFinished() && Math.max(...t.wins) === 3 && t.winnerSeat !== null);
  check('tournament: 3 to 5 games played', t.history.length >= 3 && t.history.length <= 5 && gamesStarted === t.history.length);
  check('tournament: game 1 roles come from setup (seat 0 chose Ahab)', t.history[0].roles[0] === 'ahab');
  check('tournament: refusals and acceptances correct', stats.badAccept === 0 && stats.badRefuse === 0);
  check('tournament: the log announces the winner', ctl.log.some((l) => l.event.type === 'tournament-over' && /(You win|Easy bot wins) the tournament \d-\d\./.test(l.text)));
  check('tournament: the controller state is plain JSON', JSON.stringify(JSON.parse(JSON.stringify(t))) === JSON.stringify(t));
}

// ---------- hotseat ----------
{
  const ctl = createController({ seats: [{ type: 'human' }, { type: 'human' }], roleChoices: ['whale', 'ahab'], mode: 'single', seed: 5 });
  const rng = makeRng('h3');
  let handoffs = 0; let leaked = false;
  while (!ctl.isFinished()) {
    if (ctl.needsHandoff()) {
      handoffs++;
      if (ctl.shownSeat() === ctl.toAct()) leaked = true;
      ctl.reveal(ctl.toAct());
    }
    if (ctl.shownSeat() !== ctl.toAct()) { leaked = true; break; }
    ctl.play(rngPick(rng, ctl.legalActions()));
  }
  check('hotseat: game finishes', ctl.isFinished());
  check('hotseat: a handoff is required whenever the acting seat changes', handoffs >= 2 && !leaked);
  check('hotseat: the first turn needs a handoff', (() => { const c = createController({ seats: [{ type: 'human' }, { type: 'human' }], seed: 1 }); return c.needsHandoff() && c.shownSeat() === null; })());
}

// ---------- bot failure cap ----------
{
  registerBot({ id: 'broken-test-bot', label: 'Broken', chooseAction: () => ({ type: 'play', card: 'XX' }) });
  const ctl = createController({ seats: [{ type: 'broken-test-bot' }, { type: 'easy' }], seed: 3 });
  ctl.runBots();
  check('failure cap: a bot that never proposes a legal card cannot hang the game', ctl.isFinished());
  check('failure cap: refusals are counted', ctl.botRefusals >= MAX_BOT_FAILURES);
}

// ---------- setup errors ----------
{
  let threw = false;
  try { createController({ seats: [{ type: 'human' }, { type: 'easy' }], roleChoices: ['ahab', 'ahab'], seed: 1 }); } catch { threw = true; }
  check('setup: both seats on the same fixed role is refused', threw);
  threw = false;
  try { createController({ seats: [{ type: 'human' }, { type: 'nope' }], seed: 1 }); } catch { threw = true; }
  check('setup: an unknown bot level is refused', threw);
}

done();
