// lib.mjs - a tiny check harness shared by the suites (no framework).

import { createGame, applyAction } from '../src/engine/index.js';

export function suite(name) {
  let pass = 0;
  const failures = [];
  function check(label, cond, detail = '') {
    if (cond) pass++;
    else failures.push(`${label}${detail ? ` -- ${detail}` : ''}`);
  }
  function done() {
    for (const f of failures) console.log(`  FAIL ${f}`);
    console.log(`${name}: ${pass} passed, ${failures.length} failed`);
    if (failures.length) process.exitCode = 1;
    return failures.length === 0;
  }
  return { check, done };
}

/** A hand-built game: fixed hands by seat, a forced first leader, optional whale cell. */
export function scenario({ hands, leader = 0, whale = null, rules = {}, roles = ['ahab', 'whale'] }) {
  const g = createGame({ seed: 1, roles, rules: { HAND_SIZE: hands[0].length, ...rules }, firstLeader: leader, deal: { hands } });
  if (whale) g.whale = { ...whale };
  return g;
}

/** Plays cards in order (each by whoever is to act) and returns all events. */
export function play(state, ...cards) {
  let events = [];
  for (const card of cards) events = events.concat(applyAction(state, { type: 'play', card }));
  return events;
}

export const roundTrip = (x) => JSON.parse(JSON.stringify(x));
