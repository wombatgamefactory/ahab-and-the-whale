// random.js - Easy bot: a uniformly random legal card.
//
// Bot interface: chooseAction(view, rng) -> action. `view` is viewFor() output only;
// `rng` is the bot's own stream (rng.js). Pure: no clock, no global randomness, no I/O.

import { legalActionsFromView, rngPick } from '../engine/index.js';

export const randomBot = {
  id: 'easy',
  label: 'Easy',
  chooseAction(view, rng) {
    return rngPick(rng, legalActionsFromView(view));
  },
};
