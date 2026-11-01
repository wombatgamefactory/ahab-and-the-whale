// ui-node.mjs - Node-level checks of the UI's pure parts: trick sentences, move previews,
// and the controller's worker-facing API (botTask / applyBotResult).
// Semantics: PERMANENTLY GREEN. Exit 1 on any failure. Run: node tests/ui-node.mjs

import { suite, scenario, play } from './lib.mjs';
import { createController } from '../src/ui/controller.js';
import { trickSentence, moveDir } from '../src/ui/text.js';
import { previewCard } from '../src/ui/preview.js';
import { getBot, botLevels } from '../src/bots/index.js';
import { applyAction, getValidActions, makeRng, rngPick, currentGame } from '../src/engine/index.js';

const { check, done } = suite('ui-node');

// ---------- sentences ----------
{
  // Whale (seat 0) leads E9, Ahab (seat 1) follows E4: leader wins, whale moves East.
  const g = scenario({ hands: [['E9', 'N1'], ['E4', 'S2']], leader: 0, roles: ['whale', 'ahab'] });
  play(g, 'E9', 'E4');
  const s = trickSentence(g.tricks[0], g.roles);
  check('sentence: leader wins', s === 'Whale led East 9, Ahab followed East 4: the leader wins, the whale moves East.', s);
}
{
  const g = scenario({ hands: [['N2', 'E1'], ['N5', 'S2']], leader: 0, roles: ['whale', 'ahab'] });
  play(g, 'N2', 'N5');
  const s = trickSentence(g.tricks[0], g.roles);
  check('sentence: follower wins reverses', /the follower wins, the whale moves South, the opposite of the led wind\.$/.test(s), s);
}
{
  const g = scenario({ hands: [['W6', 'E1'], ['S3', 'S2']], leader: 0, roles: ['ahab', 'whale'] });
  play(g, 'W6', 'S3');
  const s = trickSentence(g.tricks[0], g.roles);
  check('sentence: drift names the follower discard wind', s === 'Ahab led West 6, Whale had no West and played South 3: Ahab wins, the whale drifts South.', s);
  check('moveDir: drift uses the discarded wind', moveDir(g.tricks[0]) === 'S');
}
{
  const g = scenario({ hands: [['E6', 'E1'], ['E2', 'E3']], leader: 0, whale: { x: 6, y: 3 }, roles: ['ahab', 'whale'] });
  play(g, 'E6', 'E2');
  const s = trickSentence(g.tricks[0], g.roles);
  check('sentence: blocked step says it stays put', /pushed East but is at the edge, so it stays put\.$/.test(s), s);
}

// ---------- previews ----------
{
  // Follower preview equals what the engine then does, and never mutates the game.
  let followChecks = 0; let leadChecks = 0; let mutated = false; let mismatch = 0; let leadMismatch = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const ctl = createController({ seats: [{ type: 'easy' }, { type: 'easy' }], seed });
    const game = currentGame(ctl.state);
    const rng = makeRng(`p${seed}`);
    while (game.phase !== 'over') {
      const before = JSON.stringify(game);
      for (const { card } of getValidActions(ctl.state)) {
        const p = previewCard(game, card);
        if (JSON.stringify(game) !== before) mutated = true;
        // what actually happens if that card is played (on a copy)
        const copy = JSON.parse(before);
        applyAction(copy, { type: 'play', card });
        if (game.phase === 'follow') {
          followChecks++;
          const t = copy.tricks[copy.tricks.length - 1];
          const ghost = p.ghosts[0];
          const dir = moveDir(t);
          const ok = dir ? (ghost && ghost.cell.x === t.to.x && ghost.cell.y === t.to.y && ghost.dir === dir) : p.ghosts.length === 0;
          if (!ok) mismatch++;
        } else {
          leadChecks++;
          // lead preview: for every legal reply the real outcome (if the reply follows suit) is one of the two ghosts
          for (const reply of copy.hands[1 - game.toAct].filter((c) => c[0] === card[0])) {
            const c2 = JSON.parse(JSON.stringify(copy));
            applyAction(c2, { type: 'play', card: reply });
            const t = c2.tricks[c2.tricks.length - 1];
            if (!p.ghosts.some((gh) => gh.cell.x === t.to.x && gh.cell.y === t.to.y)) leadMismatch++;
          }
        }
      }
      applyAction(ctl.state, rngPick(rng, getValidActions(ctl.state)));
    }
  }
  check('preview: follower preview matches the engine result for every legal card', followChecks > 500 && mismatch === 0, `${followChecks} checks, ${mismatch} mismatches`);
  check('preview: leader preview ghosts cover every followed-suit outcome', leadChecks > 500 && leadMismatch === 0, `${leadChecks} checks, ${leadMismatch} mismatches`);
  check('preview: never mutates the game', !mutated);
}
{
  const g2 = scenario({ hands: [['N2', 'E1'], ['N5', 'S2']], leader: 0 });
  play(g2, 'N2');
  check('preview: following with an illegal card gives null', previewCard(g2, 'S2') === null);
}

// ---------- controller bot task API ----------
{
  // A whole game decided "elsewhere" through botTask/applyBotResult equals runBots().
  for (const level of botLevels().map((l) => l.id)) {
    const a = createController({ seats: [{ type: level }, { type: 'easy' }], seed: 77 });
    a.runBots();
    const b = createController({ seats: [{ type: level }, { type: 'easy' }], seed: 77 });
    let guard = 0;
    while (b.isBotTurn() && guard++ < 100) {
      const task = b.botTask();
      const rng = { s: task.rng.s };
      const action = getBot(task.level).chooseAction(JSON.parse(JSON.stringify(task.view)), rng);
      const out = b.applyBotResult(task, { action, rng });
      if (!Array.isArray(out)) break;
    }
    check(`task api (${level}): same game as runBots`, JSON.stringify(a.state) === JSON.stringify(b.state) && b.isFinished());
  }
  const c = createController({ seats: [{ type: 'easy' }, { type: 'easy' }], seed: 5 });
  const t1 = c.botTask();
  c.stepBot();
  check('task api: a late answer for an old position is stale', c.applyBotResult(t1, { action: { type: 'play', card: 'N1' }, rng: t1.rng }) === 'stale');
  const d = createController({ seats: [{ type: 'easy' }, { type: 'easy' }], seed: 6 });
  let applied = false; let tries = 0;
  while (!applied && tries++ < 5) {
    const task = d.botTask();
    const out = d.applyBotResult(task, null);
    applied = Array.isArray(out);
  }
  check('task api: three failed answers in a row play the first legal card', applied && tries === 3 && d.botRefusals === 3, `tries ${tries}`);
  const h = createController({ seats: [{ type: 'human' }, { type: 'easy' }], roleChoices: ['ahab', 'whale'], seed: 3 });
  check('task api: a human turn has no bot task', h.isHumanTurn() ? h.botTask() === null : true);
}

done();
