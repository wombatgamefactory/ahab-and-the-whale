// bot-worker.js - runs bot decisions off the main thread (module worker).
//
// In:  { id, level, view, rng }   (plain JSON, from controller.botTask())
// Out: { id, action, rng }        the chosen action and the bot's advanced RNG state
//   or { id, error }              the bot threw; the driver treats that as a failed answer
//
// The registry import pulls in every registered level, so Medium and Hard need no change here.

import { getBot } from '../bots/index.js';

self.onmessage = (e) => {
  const { id, level, view, rng } = e.data;
  try {
    const r = { s: rng.s };
    const action = getBot(level).chooseAction(view, r);
    self.postMessage({ id, action, rng: r });
  } catch (err) {
    self.postMessage({ id, error: String((err && err.message) || err) });
  }
};
