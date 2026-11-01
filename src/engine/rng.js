// rng.js - the seeded random number generator (mulberry32).
//
// An RNG is a plain JSON object `{ s: <int32> }`; every function advances it in place.
// Nothing in src/engine or src/bots may use any other source of randomness.
//
// Streams, never mixed:
//   - the GAME stream lives at `state.rng` (deal and random first leader);
//   - a TOURNAMENT keeps its own stream for game 1's first leader, and derives each
//     game's seed from (tournament seed, game number) with deriveSeed;
//   - each BOT gets its own stream from the driver (deriveSeed(seed, 'bot', seat)),
//     so a bot's choices never change the shuffles.

/** Turns any seed (integer or string) into a well-mixed int32. */
export function hashSeed(seed) {
  let h = 0x9e3779b9 | 0;
  const text = typeof seed === 'string' ? seed : `#${Number(seed)}`;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x85ebca6b);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) | 0;
}

/** A new RNG from a seed (finite number or string). Same seed, same stream. */
export function makeRng(seed) {
  if (seed === null || seed === undefined || (typeof seed === 'number' && !Number.isFinite(seed))) {
    throw new Error('makeRng needs a seed: a finite number or a string');
  }
  return { s: hashSeed(seed) };
}

/** A child seed string from a parent seed and labels, e.g. deriveSeed(42, 'game', 2). */
export function deriveSeed(seed, ...parts) {
  return [String(seed), ...parts.map(String)].join(':');
}

export function cloneRng(rng) {
  return { s: rng.s };
}

/** Next float in [0, 1). */
export function rngNext(rng) {
  let t = (rng.s = (rng.s + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Next integer in [0, n). */
export function rngInt(rng, n) {
  return Math.floor(rngNext(rng) * n);
}

/** A uniformly chosen element of a non-empty array. */
export function rngPick(rng, array) {
  if (!array.length) throw new Error('rngPick on an empty array');
  return array[rngInt(rng, array.length)];
}

/** Fisher-Yates shuffle IN PLACE; returns the array. */
export function shuffle(rng, array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = rngInt(rng, i + 1);
    const tmp = array[i];
    array[i] = array[j];
    array[j] = tmp;
  }
  return array;
}

/** Splits off an independent RNG (advances the parent by one number). */
export function forkRng(rng) {
  return { s: hashSeed(`fork:${(rngNext(rng) * 4294967296) >>> 0}`) };
}
