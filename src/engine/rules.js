// rules.js - constants and the VARIANTS table. Data only, plus resolveVariants().
//
// Rule numbers (R1.1 ... R11) cited throughout the engine and its tests refer to the numbered rule
// list this engine was written from; the printed rule book in rules/ states the same rules.
//
// Every rule constant is a row of VARIANTS. A game stores its resolved values at
// `state.rules` (plain JSON, frozen at createGame), and logic reads `state.rules.X`,
// never this table. DEFAULT_RULES is an exported OBJECT (not bare numbers) so a
// simulator probe can change a default at runtime and reach every reader.
//
// A value that is declared (the Python sim knows it) but not implemented here makes
// resolveVariants throw, so nothing silently plays the default (rule list §10).

/** The four winds in canonical order (R1.1). Index order matches the sim's Suit enum. */
export const SUITS = ['N', 'E', 'S', 'W'];

export const SUIT_NAMES = { N: 'North', E: 'East', S: 'South', W: 'West' };

/** One step of the whale per wind, as [dx, dy]; x grows East, y grows South (R1.4, R1.5). */
export const VECTORS = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };

/** The opposite wind: two places round (R1.5). */
export const OPPOSITE = { N: 'S', E: 'W', S: 'N', W: 'E' };

export const ROLES = ['ahab', 'whale'];
export const ROLE_NAMES = { ahab: 'Ahab', whale: 'the Whale' };

/**
 * @typedef {object} VariantDef
 * @property {string} name          constant name (rule list §10)
 * @property {'integer'|'enum'|'boolean'} type
 * @property {Array} [values]       every value the sim knows (enum/boolean)
 * @property {Array} [implemented]  the values this engine plays; others throw
 * @property {number} [min]
 * @property {number} [max]
 * @property {*} default            rule book v4 value
 * @property {string} rule          rule numbers
 * @property {string} description
 */

/** @type {VariantDef[]} */
export const VARIANTS = [
  { name: 'GRID_SIZE', type: 'integer', min: 5, max: 15, default: 7, rule: 'R1.3',
    description: 'The sea chart is N x N (odd).' },
  { name: 'HARPOON_RADIUS', type: 'integer', min: 0, max: 6, default: 2, rule: 'R1.6',
    description: 'Harpoon range = cells within this Chebyshev distance of the centre.' },
  { name: 'MAX_RANK', type: 'integer', min: 1, max: 20, default: 9, rule: 'R1.1',
    description: 'Each wind runs 1..MAX_RANK.' },
  { name: 'HAND_SIZE', type: 'integer', min: 1, max: 40, default: 12, rule: 'R2.2, R3.5',
    description: 'Cards dealt to each player = tricks in the game.' },
  { name: 'HANDS_PER_GAME', type: 'integer', min: 1, max: 1, default: 1, rule: 'R2.3',
    description: 'Hands per game. Only 1 (rule book v4) is implemented.' },
  { name: 'VOID_RULE', type: 'enum', values: ['drift', 'none', 'calm', 'calm_pass'],
    implemented: ['drift', 'none', 'calm'], default: 'drift', rule: 'R4.1, R4.2',
    description: 'Follower void: drift (leader wins, whale moves by the discarded suit), none (leader wins, led direction), calm (leader wins, no move).' },
  { name: 'ESCAPE_CHECK', type: 'enum', values: ['hand_end', 'immediate', 'next_trick'],
    implemented: ['hand_end', 'immediate'], default: 'hand_end', rule: 'R4.4, R5.1, R5.3',
    description: 'hand_end: only the cell after the last trick counts. immediate: reaching open sea wins at once for the Whale.' },
  { name: 'LEAD_RESTRICTION', type: 'enum', values: ['none', 'not_previous', 'not_own_previous'],
    implemented: ['none', 'not_previous', 'not_own_previous'], default: 'none', rule: 'R3.1',
    description: 'Wind ban on leads. Exception: a hand of only the barred wind may lead it.' },
  { name: 'FOLLOW_RULE', type: 'enum', values: ['must', 'may_renounce'], implemented: ['must'],
    default: 'must', rule: 'R3.2', description: 'Must follow suit if able.' },
  { name: 'DISTANCE_METRIC', type: 'enum', values: ['chebyshev', 'manhattan'], implemented: ['chebyshev'],
    default: 'chebyshev', rule: 'R1.8', description: 'Square chart (Chebyshev distance).' },
  { name: 'GUST', type: 'boolean', values: [false, true], implemented: [false], default: false,
    rule: '§10', description: 'Optional margin rule; off in rule book v4.' },
  { name: 'FIRST_LEADER', type: 'enum', values: ['random', 'ahab', 'whale'],
    implemented: ['random', 'ahab', 'whale'], default: 'random', rule: 'R2.4',
    description: 'First leader of a standalone game.' },
  // Tournament (R7, §10)
  { name: 'TOURNAMENT_WINS_NEEDED', type: 'integer', min: 1, max: 9, default: 3, rule: 'R7.1',
    description: 'Game wins needed to win the tournament.' },
  { name: 'TOURNAMENT_MAX_GAMES', type: 'integer', min: 1, max: 17, default: 5, rule: 'R7.1',
    description: 'Must equal 2 x wins needed - 1 (no game can be drawn).' },
  { name: 'ROLES_SWAP_EACH_GAME', type: 'boolean', values: [true, false], implemented: [true, false],
    default: true, rule: 'R7.2', description: 'Seats swap roles every game.' },
  { name: 'FIRST_LEADER_GAME_1', type: 'enum', values: ['random'], implemented: ['random'],
    default: 'random', rule: 'R7.3', description: 'Tournament game 1 first leader.' },
  { name: 'FIRST_LEADER_AFTER', type: 'enum', values: ['other_seat'], implemented: ['other_seat'],
    default: 'other_seat', rule: 'R7.3',
    description: 'Games 2+: the seat that did not lead first in the previous game.' },
];

/** Rule book v4 values by name. Mutable on purpose (runtime probes); see header. */
export const DEFAULT_RULES = Object.fromEntries(VARIANTS.map((v) => [v.name, v.default]));

/**
 * Merges overrides onto DEFAULT_RULES and validates the result.
 * Throws on an unknown name, a wrongly typed value, an unimplemented value, or an
 * impossible combination.
 * @param {object} [overrides]
 * @returns {object} plain JSON rules object
 */
export function resolveVariants(overrides = {}) {
  const byName = new Map(VARIANTS.map((v) => [v.name, v]));
  for (const key of Object.keys(overrides || {})) {
    if (!byName.has(key)) {
      throw new Error(`Unknown rule "${key}". Known rules: ${VARIANTS.map((v) => v.name).join(', ')}`);
    }
  }
  const rules = { ...DEFAULT_RULES, ...(overrides || {}) };
  for (const def of VARIANTS) {
    const value = rules[def.name];
    if (def.type === 'integer') {
      if (!Number.isInteger(value)) throw new Error(`${def.name} must be an integer, got ${JSON.stringify(value)}`);
      if (value < def.min || value > def.max) {
        throw new Error(`${def.name} must be between ${def.min} and ${def.max}, got ${value}`);
      }
    } else {
      if (!def.values.includes(value)) {
        throw new Error(`${def.name} must be one of ${def.values.join(', ')}, got ${JSON.stringify(value)}`);
      }
      if (!def.implemented.includes(value)) {
        throw new Error(`${def.name} = ${JSON.stringify(value)} is not implemented in the web engine`);
      }
    }
  }
  const c = Math.floor(rules.GRID_SIZE / 2);
  if (rules.GRID_SIZE % 2 === 0) throw new Error(`GRID_SIZE must be odd, got ${rules.GRID_SIZE}`);
  if (rules.HARPOON_RADIUS >= c) {
    throw new Error(`HARPOON_RADIUS ${rules.HARPOON_RADIUS} reaches open sea on a ${rules.GRID_SIZE}x${rules.GRID_SIZE} chart (max ${c - 1})`);
  }
  if (2 * rules.HAND_SIZE > 4 * rules.MAX_RANK) {
    throw new Error(`HAND_SIZE ${rules.HAND_SIZE} is too big: 2 x ${rules.HAND_SIZE} cards dealt but the deck has ${4 * rules.MAX_RANK}`);
  }
  if (rules.TOURNAMENT_MAX_GAMES !== 2 * rules.TOURNAMENT_WINS_NEEDED - 1) {
    throw new Error(`TOURNAMENT_MAX_GAMES must be 2 x TOURNAMENT_WINS_NEEDED - 1 (${2 * rules.TOURNAMENT_WINS_NEEDED - 1}), got ${rules.TOURNAMENT_MAX_GAMES}`);
  }
  return rules;
}
