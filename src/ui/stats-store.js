// stats-store.js - local play statistics. Results stay in the browser (localStorage); nothing
// here is ever sent anywhere. No DOM. Every storage access is inside try/catch, so the game
// works unchanged when storage is blocked, full or throwing: the store then just forgets.
//
// One key, `ahab-stats-v1`, holds { v: 1, games: [...], tournaments: [...] }, newest last,
// each list capped (oldest dropped).
//
// Game record (schema 1), compact:
//   v, date (ISO), mode ('single'|'tournament'), tid (tournament id or null), gameNo,
//   seats: [{ type, role }, { type, role }]   by seat; type human|easy|medium|hard
//   winnerRole, winnerSeat, winnerType, reason, whale {x,y} (final cell),
//   path: [[x,y] x12] whale cell after each trick, cards: [['N7', seat] x24] in play order,
//   firstLeaderSeat, firstLeaderRole, tricks, seconds
// Tournament record: v, date, tid, seats: [type, type], wins [a,b], gamesPlayed, winnerSeat,
//   winnerType

export const STORE_KEY = 'ahab-stats-v1';
export const STORE_VERSION = 1;
export const MAX_GAMES = 2000;
export const MAX_TOURNAMENTS = 500;

const empty = () => ({ v: STORE_VERSION, games: [], tournaments: [] });

function defaultStorage() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

/** getStorage: () => Storage-like (getItem/setItem/removeItem); may throw or return null. */
export function createStatsStore(getStorage = defaultStorage) {
  function load() {
    try {
      const s = getStorage();
      if (!s) return empty();
      const raw = s.getItem(STORE_KEY);
      if (!raw) return empty();
      const data = JSON.parse(raw);
      if (!data || data.v !== STORE_VERSION) return empty();
      return {
        v: STORE_VERSION,
        games: Array.isArray(data.games) ? data.games : [],
        tournaments: Array.isArray(data.tournaments) ? data.tournaments : [],
      };
    } catch { return empty(); }
  }

  function save(data) {
    for (const keep of [MAX_GAMES, 800, 200]) {
      try {
        const s = getStorage();
        if (!s) return false;
        s.setItem(STORE_KEY, JSON.stringify({ ...data, games: data.games.slice(-keep) }));
        return true;
      } catch { /* quota or blocked: retry smaller, then give up */ }
    }
    return false;
  }

  return {
    load,
    addGame(rec) {
      const data = load();
      data.games.push(rec);
      if (data.games.length > MAX_GAMES) data.games = data.games.slice(-MAX_GAMES);
      return save(data);
    },
    addTournament(rec) {
      const data = load();
      data.tournaments.push(rec);
      if (data.tournaments.length > MAX_TOURNAMENTS) data.tournaments = data.tournaments.slice(-MAX_TOURNAMENTS);
      return save(data);
    },
    clear() {
      try { const s = getStorage(); if (s) s.removeItem(STORE_KEY); return true; } catch { return false; }
    },
  };
}

// ---------- recording ----------

/**
 * Turns the session hooks into records. `now` is injectable for tests. The recorder keeps
 * only start times; the record itself is built from the finished game state (info.game).
 */
export function createRecorder(store, now = () => Date.now()) {
  let gameStartedAt = null;
  return {
    gameStart() { gameStartedAt = now(); },
    gameEnd(info) {
      const g = info.game;
      const res = info.result;
      if (!g || !res) return null;
      const seats = info.seats.map((type, i) => ({ type, role: g.roles[i] }));
      const rec = {
        v: STORE_VERSION,
        date: new Date(now()).toISOString(),
        mode: info.mode,
        tid: info.mode === 'tournament' ? `t${info.seed}` : null,
        gameNo: info.mode === 'tournament' ? info.gameNo : null,
        seats,
        winnerRole: res.winnerRole,
        winnerSeat: res.winnerSeat,
        winnerType: seats[res.winnerSeat].type,
        reason: res.reason,
        whale: { x: res.whale.x, y: res.whale.y },
        path: g.tricks.map((t) => [t.to.x, t.to.y]),
        cards: g.tricks.flatMap((t) => [[t.lead, t.leader], [t.follow, t.follower]]),
        firstLeaderSeat: g.firstLeader,
        firstLeaderRole: g.roles[g.firstLeader],
        tricks: g.tricks.length,
        seconds: gameStartedAt === null ? 0 : Math.max(0, Math.round((now() - gameStartedAt) / 1000)),
      };
      store.addGame(rec);
      return rec;
    },
    tournamentEnd(info) {
      const rec = {
        v: STORE_VERSION,
        date: new Date(now()).toISOString(),
        tid: `t${info.seed}`,
        seats: [...info.seats],
        wins: [...info.wins],
        gamesPlayed: info.gamesPlayed,
        winnerSeat: info.winnerSeat,
        winnerType: info.seats[info.winnerSeat],
      };
      store.addTournament(rec);
      return rec;
    },
  };
}

// ---------- export ----------

export const CSV_COLUMNS = [
  'date', 'mode', 'tournament_id', 'game_no',
  'seat1_type', 'seat1_role', 'seat2_type', 'seat2_role',
  'winner_role', 'winner_seat', 'winner_type', 'end_reason',
  'first_leader_seat', 'first_leader_role',
  'final_whale_x', 'final_whale_y', 'tricks', 'duration_seconds',
  'whale_path', 'cards', 'card_players',
];

export function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Seats are shown 1-based and 2-based in the CSV (Seat 1 / Seat 2, as on screen). */
export function gameToRow(r) {
  return [
    r.date, r.mode, r.tid, r.gameNo,
    r.seats[0].type, r.seats[0].role, r.seats[1].type, r.seats[1].role,
    r.winnerRole, r.winnerSeat + 1, r.winnerType, r.reason,
    r.firstLeaderSeat + 1, r.firstLeaderRole,
    r.whale.x, r.whale.y, r.tricks, r.seconds,
    r.path.map(([x, y]) => `${x}:${y}`).join(' '),
    r.cards.map(([c]) => c).join(' '),
    r.cards.map(([, s]) => s + 1).join(' '),
  ];
}

/** One header row plus one row per game; CRLF-free (LF) so it is safe to paste into URLs and tools. */
export function toCsv(games) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const g of games) lines.push(gameToRow(g).map(csvCell).join(','));
  return `${lines.join('\n')}\n`;
}

export function toJson(data) {
  return JSON.stringify({ exported: new Date().toISOString(), schema: STORE_VERSION, ...data }, null, 2);
}

/** `ahab-stats-2026-11-01.csv`, local date. */
export function exportFilename(ext, d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `ahab-stats-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.${ext}`;
}

// ---------- summary ----------


/** Pure aggregation for the stats screen. */
export function summarise(games, tournaments = [], gridSize = 7) {
  const total = games.length;
  let ahabWins = 0;
  const matchups = new Map(); // "ahabType|whaleType" -> { ahabType, whaleType, n, ahabWins }
  const lead = { ahab: { n: 0, won: 0 }, whale: { n: 0, won: 0 } }; // by the role that led trick 1
  const heat = Array.from({ length: gridSize }, () => new Array(gridSize).fill(0));
  for (const g of games) {
    const ahabSeat = g.seats.findIndex((s) => s.role === 'ahab');
    const ahabType = g.seats[ahabSeat].type;
    const whaleType = g.seats[1 - ahabSeat].type;
    const aWon = g.winnerRole === 'ahab';
    if (aWon) ahabWins++;
    const key = `${ahabType}|${whaleType}`;
    if (!matchups.has(key)) matchups.set(key, { ahabType, whaleType, n: 0, ahabWins: 0 });
    const m = matchups.get(key);
    m.n++;
    if (aWon) m.ahabWins++;
    const fl = g.firstLeaderRole;
    lead[fl].n++;
    if (g.winnerRole === fl) lead[fl].won++;
    if (g.whale && heat[g.whale.y] && heat[g.whale.y][g.whale.x] !== undefined) heat[g.whale.y][g.whale.x]++;
  }
  const tWins = {};
  for (const t of tournaments) tWins[t.winnerType] = (tWins[t.winnerType] || 0) + 1;
  return {
    total,
    ahabWins,
    whaleWins: total - ahabWins,
    matchups: [...matchups.values()].sort((a, b) => b.n - a.n),
    lead,
    leadOverall: { n: lead.ahab.n + lead.whale.n, won: lead.ahab.won + lead.whale.won },
    heat,
    heatMax: Math.max(0, ...heat.flat()),
    tournaments: tournaments.length,
    tournamentWinners: tWins,
  };
}

export const statsStore = createStatsStore();
