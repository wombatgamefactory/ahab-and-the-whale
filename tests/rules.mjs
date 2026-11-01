// rules.mjs - one check (or a few) per numbered rule (R1.1 ... R11) the engine implements.
// Semantics: PERMANENTLY GREEN. A red line is a regression. Exit 1 on any failure.

import {
  fullDeck, cardName, isOpenSea, inHarpoonRange, startCell, createGame, createTournament,
  resolveRoles, getValidActions, getPlayBlockReason, applyAction, startNextGame, viewFor,
  legalActionsFromView, shownVoids, unknownCards, determinise, resolveVariants, DEFAULT_RULES,
  makeRng, rngPick, sortCards, toActOf,
} from '../src/engine/index.js';
import { suite, scenario, play, roundTrip } from './lib.mjs';

const { check, done } = suite('rules');
const R = DEFAULT_RULES;
const cell = (x, y) => ({ x, y });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; } };

function playRandomGame(state, seed) {
  const rng = makeRng(seed);
  while (toActOf(state) !== null) applyAction(state, rngPick(rng, getValidActions(state)));
  return state;
}

// ---------- One check of the printed rule-book values (§9, §10) ----------
check('§10 defaults are rule book v3', same(
  [R.GRID_SIZE, R.HARPOON_RADIUS, R.MAX_RANK, R.HAND_SIZE, R.HANDS_PER_GAME, R.VOID_RULE, R.ESCAPE_CHECK, R.LEAD_RESTRICTION, R.FOLLOW_RULE, R.FIRST_LEADER, R.TOURNAMENT_WINS_NEEDED, R.TOURNAMENT_MAX_GAMES, R.ROLES_SWAP_EACH_GAME],
  [7, 2, 9, 12, 1, 'drift', 'hand_end', 'none', 'must', 'random', 3, 5, true]));

// ---------- R1 components and chart ----------
{
  const deck = fullDeck(R.MAX_RANK);
  check('R1.1 36 distinct cards, 4 winds x 1..9', deck.length === 36 && new Set(deck).size === 36 && ['N', 'E', 'S', 'W'].every((s) => [1, 2, 3, 4, 5, 6, 7, 8, 9].every((r) => deck.includes(`${s}${r}`))));
  check('R1.1 / §11.3 ace is shown as 1', cardName('N1') === 'North 1');
  const rules = resolveVariants();
  let open = 0; let range = 0; let both = 0; let neither = 0;
  for (let x = 0; x < 7; x++) for (let y = 0; y < 7; y++) {
    const o = isOpenSea(cell(x, y), rules); const h = inHarpoonRange(cell(x, y), rules);
    open += o; range += h; both += o && h; neither += !o && !h;
  }
  check('R1.3 / R1.6 open sea is the 24-cell outer ring', open === 24);
  check('R1.6 harpoon range is the inner 25 cells', range === 25);
  check('R1.6 every cell is exactly one of the two', both === 0 && neither === 0);
  check('R1.7 the whale starts on the centre (3,3)', same(startCell(rules), cell(3, 3)) && same(createGame({ seed: 5 }).whale, cell(3, 3)));
}

// R1.4 / R1.5 directions: leader wins a followed trick -> whale moves the led way.
for (const [suit, dx, dy] of [['N', 0, -1], ['E', 1, 0], ['S', 0, 1], ['W', -1, 0]]) {
  const g = scenario({ hands: [[`${suit}9`], [`${suit}1`]], leader: 0 });
  play(g, `${suit}9`, `${suit}1`);
  check(`R1.4/R1.5 ${suit} moves the whale (${dx},${dy})`, same(g.whale, cell(3 + dx, 3 + dy)), JSON.stringify(g.whale));
}

// ---------- R2 setup ----------
{
  const g = createGame({ seed: 'deal' });
  const all = [...g.hands[0], ...g.hands[1], ...g.unused];
  check('R2.2 12 cards each and 12 unused, the whole deck once', g.hands[0].length === 12 && g.hands[1].length === 12 && g.unused.length === 12 && new Set(all).size === 36);
  check('R2.3 one hand of 12 tricks: the game ends after trick 12', (() => { const s = playRandomGame(createGame({ seed: 9 }), 9); return s.phase === 'over' && s.trickNo === 12 && s.tricks.length === 12; })());
  let seat0 = 0;
  for (let i = 0; i < 400; i++) seat0 += createGame({ seed: `fl${i}` }).firstLeader === 0;
  check('R2.4 the first leader is random (both seats, roughly 50/50)', seat0 > 150 && seat0 < 250, `seat 0 led ${seat0}/400`);
  check('R2.5 hands are sorted by wind then rank', same(g.hands[0], sortCards(g.hands[0])));
  check('R2.2 a different seed deals differently; the same seed deals the same', !same(createGame({ seed: 1 }).hands, createGame({ seed: 2 }).hands) && same(createGame({ seed: 1 }).hands, createGame({ seed: 1 }).hands));
}

// ---------- R3 leading, following, winning ----------
{
  const g = scenario({ hands: [['N2', 'E5', 'S1'], ['N3', 'N7', 'W4']], leader: 0 });
  check('R3.1 the leader may lead any card', getValidActions(g).length === 3);
  play(g, 'E5');
  const v = getValidActions(g).map((a) => a.card);
  check('R3.2 a void follower may play any card', same(v, ['N3', 'N7', 'W4']));
}
{
  const g = scenario({ hands: [['N2', 'E5', 'S1'], ['N3', 'N7', 'W4']], leader: 0 });
  play(g, 'N2');
  check('R3.2 a follower holding the led wind must follow', same(getValidActions(g).map((a) => a.card), ['N3', 'N7']));
  check('R3.2 the block reason names the wind and the cards', getPlayBlockReason(g, 1, 'W4') === 'You must follow North: you hold North 3 and North 7.', getPlayBlockReason(g, 1, 'W4'));
  check('R3.2 applyAction refuses a renounce', throws(() => applyAction(g, { type: 'play', card: 'W4' }), /must follow North/));
  check('R3.2 a refused action changes nothing', g.hands[1].length === 3 && g.phase === 'follow');
  check('legality: playing out of turn is refused with a reason', /not your turn/.test(getPlayBlockReason(g, 0, 'E5')));
  check('legality: a card not held is refused', /do not hold/.test(getPlayBlockReason(g, 1, 'S9')));
}
{
  const g = scenario({ hands: [['N2', 'E1'], ['N7', 'E2']], leader: 0 });
  const ev = play(g, 'N2', 'N7');
  check('R3.3 a followed trick: the higher rank wins (follower)', g.tricks[0].winner === 1 && ev.some((e) => e.type === 'trick-won' && e.winner === 1));
  check('R3.4 the trick winner leads next', g.leader === 1 && g.toAct === 1 && g.phase === 'lead');
}
{
  const g = scenario({ hands: [['N2', 'E1'], ['S9', 'E2']], leader: 0 });
  play(g, 'N2', 'S9');
  check('R3.3 a drift trick: the leader wins whatever was played', g.tricks[0].winner === 0 && !g.tricks[0].followed);
  check('R3.4 after a drift trick the leader leads again', g.toAct === 0);
}
{
  const s = playRandomGame(createGame({ seed: 'r35' }), 'r35b');
  check('R3.5 every dealt card is played; no cards drawn', s.hands[0].length === 0 && s.hands[1].length === 0 && s.tricks.length === 12 && s.unused.length === 12);
  const played = s.tricks.flatMap((t) => [t.lead, t.follow]);
  check('R3.5 24 distinct cards were played', new Set(played).size === 24);
}

// ---------- R4 whale movement ----------
{
  let g = scenario({ hands: [['E8'], ['E3']], leader: 0 });
  play(g, 'E8', 'E3');
  check('R4.1 followed, leader higher: led direction', same(g.whale, cell(4, 3)) && !g.tricks[0].reversed);
  g = scenario({ hands: [['E3'], ['E8']], leader: 0 });
  play(g, 'E3', 'E8');
  check('R4.1 followed, follower higher: opposite of the led direction', same(g.whale, cell(2, 3)) && g.tricks[0].reversed && g.tricks[0].winner === 1);
  g = scenario({ hands: [['E3'], ['S1']], leader: 0 });
  play(g, 'E3', 'S1');
  check('R4.1 drift: the discarded wind\'s direction (South), led wind ignored', same(g.whale, cell(3, 4)));
  g = scenario({ hands: [['E3'], ['W9']], leader: 0 });
  play(g, 'E3', 'W9');
  check('R4.2 drift by the opposite wind moves opposite to the led direction', same(g.whale, cell(2, 3)) && g.tricks[0].winner === 0);
  const g1 = scenario({ hands: [['E3'], ['N1']], leader: 0 });
  const g9 = scenario({ hands: [['E3'], ['N9']], leader: 0 });
  play(g1, 'E3', 'N1'); play(g9, 'E3', 'N9');
  check('R4.2 the discarded card\'s rank is irrelevant', same(g1.whale, g9.whale) && same(g1.whale, cell(3, 2)));
  check('R4.6 a drift step is never reversed', g9.tricks[0].reversed === false && g9.tricks[0].dirSuit === 'N');
}
{
  const g = scenario({ hands: [['N9', 'E1'], ['N1', 'E2']], leader: 0, whale: cell(3, 0) });
  const ev = play(g, 'N9', 'N1');
  check('R4.3 a step off the chart is blocked: the whale stays', same(g.whale, cell(3, 0)) && g.tricks[0].blocked && ev.some((e) => e.type === 'whale-moved' && e.blocked));
  check('R4.5 a blocked trick is still a played trick; the winner leads', g.trickNo === 1 && g.toAct === 0 && g.hands[0].length === 1);
  const g2 = scenario({ hands: [['W5'], ['N2']], leader: 0, whale: cell(0, 0) });
  play(g2, 'W5', 'N2');
  check('R4.3 drift off the chart is blocked too', same(g2.whale, cell(0, 0)) && g2.tricks[0].blocked);
}
{
  // R4.4 / R5.3: reach open sea mid-game, keep playing, come back; only the end counts.
  const g = scenario({ hands: [['N9', 'S9', 'E1'], ['N1', 'S1', 'E2']], leader: 0, whale: cell(3, 1) });
  play(g, 'N9', 'N1');
  check('R4.4 the whale may sit on the open sea mid-game', same(g.whale, cell(3, 0)) && isOpenSea(g.whale, g.rules));
  check('R5.3 the game does not end early on open sea', g.phase === 'lead' && g.result === null);
  play(g, 'S9', 'S1');
  play(g, 'E1', 'E2');
  check('R4.4 / R5.1 pulled back into range, Ahab wins on the final cell', g.phase === 'over' && g.result.winnerRole === 'ahab' && same(g.whale, cell(2, 1)));
}

// ---------- R5 end and winner ----------
{
  const g = scenario({ hands: [['E9'], ['E1']], leader: 0, whale: cell(5, 3) });
  const ev = play(g, 'E9', 'E1');
  check('R5.1 final cell on open sea: the Whale wins', g.result.winnerRole === 'whale' && g.result.reason === 'open-sea' && g.result.winnerSeat === 1);
  check('R5.1 a game-over event carries the result', ev.some((e) => e.type === 'game-over' && e.winnerRole === 'whale'));
  check('R5.1 when over, nobody acts and no actions are offered', g.toAct === null && getValidActions(g).length === 0);
  const h = scenario({ hands: [['E9'], ['E1']], leader: 0, whale: cell(4, 3), roles: ['whale', 'ahab'] });
  play(h, 'E9', 'E1');
  check('R5.1 final cell in harpoon range: Ahab wins (seat 1 is Ahab here)', h.result.winnerRole === 'ahab' && h.result.winnerSeat === 1 && h.result.reason === 'harpoon-range');
  let ok = true;
  for (let i = 0; i < 200; i++) { const s = playRandomGame(createGame({ seed: `r52-${i}` }), i); ok = ok && (s.result.winnerRole === 'ahab' || s.result.winnerRole === 'whale') && s.result.winnerSeat === s.roles.indexOf(s.result.winnerRole); }
  check('R5.2 no draws; the winner seat matches the winner role (200 games)', ok);
}

// ---------- R6 roles and seats ----------
{
  const rng = makeRng(3);
  check('R6.2 fixed + random: the random seat takes the other role', same(resolveRoles('ahab', 'random', rng), ['ahab', 'whale']) && same(resolveRoles('random', 'ahab', rng), ['whale', 'ahab']));
  check('R6.2 fixed + fixed', same(resolveRoles('whale', 'ahab', rng), ['whale', 'ahab']));
  check('R6.2 both the same fixed role is refused', throws(() => resolveRoles('whale', 'whale', rng)));
  const seen = new Set();
  for (let i = 0; i < 50; i++) seen.add(resolveRoles('random', 'random', rng).join());
  check('R6.2 random + random gives both assignments', seen.size === 2);
  const g = createGame({ seed: 1, roles: ['whale', 'ahab'] });
  check('R6.3 roles are by seat and separate from seat identity', g.roles[0] === 'whale' && viewFor(g, 0).role === 'whale' && viewFor(g, 1).role === 'ahab');
}

// ---------- R7 tournament ----------
{
  let allOk = true; let maxGames = 0; let sawFive = false; let sawThree = false;
  for (let i = 0; i < 100; i++) {
    const t = createTournament({ seed: `t${i}`, roles: ['ahab', 'whale'] });
    const roleLog = []; const leadLog = []; const deals = [];
    while (t.phase !== 'over') {
      if (t.phase === 'between') startNextGame(t);
      roleLog.push([...t.game.roles]); leadLog.push(t.game.firstLeader); deals.push(JSON.stringify(t.game.hands));
      allOk = allOk && same(t.game.whale, cell(3, 3)) && t.game.trickNo === 0;
      playRandomGame(t, `t${i}-${t.gameNo}`); // toActOf/getValidActions/applyAction accept the tournament
    }
    const n = t.history.length;
    maxGames = Math.max(maxGames, n); sawFive ||= n === 5; sawThree ||= n === 3;
    for (let k = 1; k < n; k++) {
      allOk = allOk && roleLog[k][0] === roleLog[k - 1][1] && roleLog[k][1] === roleLog[k - 1][0]; // R7.2
      allOk = allOk && leadLog[k] === 1 - leadLog[k - 1]; // R7.3
    }
    allOk = allOk && same(roleLog[0], ['ahab', 'whale']); // R7.2 game 1 from setup
    allOk = allOk && new Set(deals).size === deals.length; // R7.4
    const wins = [0, 0]; for (const h of t.history) wins[h.winnerSeat]++;
    allOk = allOk && same(wins, t.wins) && Math.max(...wins) === 3 && Math.min(...wins) < 3 && t.winnerSeat === wins.indexOf(3); // R7.5
    allOk = allOk && throws(() => startNextGame(t)) && getValidActions(t).length === 0;
  }
  check('R7.1-R7.5 100 tournaments: swaps, alternating leaders, fresh deals, per-seat wins, end at 3', allOk);
  check('R7.1 never more than 5 games, and 3- and 5-game tournaments both occur', maxGames <= 5 && sawFive && sawThree);
  let leaders = 0;
  for (let i = 0; i < 200; i++) leaders += createTournament({ seed: `fl${i}` }).game.firstLeader;
  check('R7.3 game 1 first leader is random', leaders > 70 && leaders < 130, `${leaders}/200`);
}
{
  // R7.5: tracked per seat, not per role: seat 0 wins as Ahab then as the Whale.
  const t = createTournament({ seed: 'seat', roles: ['ahab', 'whale'] });
  playRandomGame(t, 'x');
  const w1 = t.history[0].winnerSeat;
  check('R7.5 a game win is credited to the seat', t.wins[w1] === 1 && t.wins[1 - w1] === 0);
  check('R7.x next game is not an action: none offered between games', t.phase === 'between' && getValidActions(t).length === 0 && /start the next game/.test(getPlayBlockReason(t, 0, 'N1')));
  // R7.6: restartable at a game boundary: a saved tournament resumes identically.
  const saved = roundTrip(t);
  startNextGame(t); startNextGame(saved);
  check('R7.6 a tournament saved between games resumes identically', same(t, saved));
}

// ---------- R8 information ----------
{
  const g = createGame({ seed: 'info' });
  playRandomGame(g, 'info'); // play to the end, then replay part-way for a mid-game view
  const h = createGame({ seed: 'info' });
  const rng = makeRng('info');
  for (let i = 0; i < 9; i++) applyAction(h, rngPick(rng, getValidActions(h)));
  for (const seat of [0, 1]) {
    const v = viewFor(h, seat);
    const text = JSON.stringify(v);
    const hidden = [...h.hands[1 - seat], ...h.unused];
    check(`R8.2 seat ${seat}'s view holds no opponent-hand or unused card`, hidden.every((c) => !text.includes(`"${c}"`)), hidden.filter((c) => text.includes(`"${c}"`)).join());
    check(`R8.1 seat ${seat}'s view has its hand, the chart, the leader, the trick count and every played trick`, same(v.hand, h.hands[seat]) && same(v.whale, h.whale) && v.leader === h.leader && v.trickNo === h.trickNo && same(v.tricks, h.tricks) && v.lead === h.lead);
    check(`R8.6 legal actions from the view equal the engine's (seat ${seat})`, same(legalActionsFromView(v), seat === h.toAct ? getValidActions(h) : []));
    check(`R8.2 unknownCards = opponent hand + unused (seat ${seat})`, same(unknownCards(v), sortCards(hidden)));
  }
  check('R8.1 view JSON round-trips', same(roundTrip(viewFor(h, 0)), viewFor(h, 0)));
}
{
  const g = scenario({ hands: [['E3', 'N1'], ['S1', 'W2']], leader: 0 });
  const ev = play(g, 'E3', 'S1');
  check('R8.3 no void is announced (no event names a void)', ev.every((e) => !/void/i.test(e.type)));
  check('R8.3 shown voids are derived from played cards', same(shownVoids(viewFor(g, 0)), [[], ['E']]));
  const d = determinise(viewFor(g, 0), makeRng(1));
  check('R8.3 determinise never deals a shown-void wind to the opponent', d.hands[1].every((c) => c[0] !== 'E') && d.hands[1].length === 1 && same(d.hands[0], g.hands[0]));
}

// ---------- §10 variants ----------
{
  check('§10 unknown rule names are rejected', throws(() => resolveVariants({ GRID: 9 }), /Unknown rule/));
  check('§10 declared but unimplemented values throw', throws(() => createGame({ seed: 1, rules: { VOID_RULE: 'calm_pass' } }), /not implemented/) && throws(() => resolveVariants({ ESCAPE_CHECK: 'next_trick' }), /not implemented/));
  check('§10 values are type-checked', throws(() => resolveVariants({ GRID_SIZE: '7' })) && throws(() => resolveVariants({ GRID_SIZE: 8 })) && throws(() => resolveVariants({ HARPOON_RADIUS: 3 })));
  let g = scenario({ hands: [['E3'], ['S1']], leader: 0, rules: { VOID_RULE: 'none' } });
  play(g, 'E3', 'S1');
  check('§10 VOID_RULE none: a void moves the whale the led way', same(g.whale, cell(4, 3)));
  g = scenario({ hands: [['E3'], ['S1']], leader: 0, rules: { VOID_RULE: 'calm' } });
  play(g, 'E3', 'S1');
  check('§10 VOID_RULE calm: a void does not move the whale', same(g.whale, cell(3, 3)) && g.tricks[0].dirSuit === null);
  g = scenario({ hands: [['N9', 'N2', 'E1'], ['N1', 'E5', 'S3']], leader: 0, rules: { LEAD_RESTRICTION: 'not_previous' } });
  play(g, 'N9', 'N1');
  check('§10 LEAD_RESTRICTION not_previous bars the previous wind', same(getValidActions(g).map((a) => a.card), ['E1']) && /may not lead North/.test(getPlayBlockReason(g, 0, 'N2')));
  g = scenario({ hands: [['N9', 'N2'], ['N1', 'E5']], leader: 0, rules: { LEAD_RESTRICTION: 'not_previous' } });
  play(g, 'N9', 'N1');
  check('§10 wind ban exception: a hand of only the barred wind may lead it', same(getValidActions(g).map((a) => a.card), ['N2']));
  g = scenario({ hands: [['E9', 'E1'], ['E2', 'E3']], leader: 0, whale: cell(5, 3), rules: { ESCAPE_CHECK: 'immediate' } });
  play(g, 'E9', 'E2');
  check('§10 ESCAPE_CHECK immediate: reaching open sea ends the game at once', g.phase === 'over' && g.result.reason === 'escape' && g.trickNo === 1);
  g = createGame({ seed: 4, rules: { FIRST_LEADER: 'whale' }, roles: ['ahab', 'whale'] });
  check('§10 FIRST_LEADER whale', g.firstLeader === 1);
  g = createGame({ seed: 4, rules: { GRID_SIZE: 9, HARPOON_RADIUS: 3 } });
  check('§10 GRID_SIZE 9 starts the whale on (4,4)', same(g.whale, cell(4, 4)));
}

done();
