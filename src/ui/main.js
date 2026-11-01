// main.js - the browser UI: landing/setup page, game screen, bot pacing, pass-and-play cover,
// end panels, dialogs. All game flow lives in controller.js; the sentences are in text.js, the
// markup in components.js / landing.js, the art in assets.js, bot decisions in bot-driver.js.
//
// ---------------------------------------------------------------------------------------
// HOOKS (stats, analytics). Each one below is called at the right moment with one info
// object (see sessionInfo()); the call sites are the only place game events leave this file.
//
//   onGameStart(info)       a game has been dealt: a new single game, a new tournament's
//                           game 1, or a tournament's next game (info.gameNo)
//   onCardPlayed(info)      every card played, human or bot; info.events are the engine
//                           events, info.trickDone is true when that card finished a trick
//   onGameEnd(info)         a game finished (single game, or each tournament game);
//                           info.result is the engine's game-over event (winnerSeat,
//                           winnerRole, whale, reason)
//   onTournamentStart(info) a first-to-3 tournament was started (called before onGameStart)
//   onTournamentEnd(info)   a seat reached 3 wins; info.wins, info.winnerSeat
//   onStatsOpened()         the Stats button was pressed (the local stats screen opened)
//   onRulesOpened(source)   the Rules dialog opened ('dialog') or the rule book PDF link was
//                           followed ('pdf')
// ---------------------------------------------------------------------------------------

import { createController } from './controller.js';
import { botLevels } from '../bots/index.js';
import { getPlayBlockReason } from '../engine/index.js';
import { loadManifest, installImageFallback } from './assets.js';
import { createBotDecider } from './bot-driver.js';
import { previewCard } from './preview.js';
import { trickSentence, moveDir } from './text.js';
import {
  esc, boardHtml, ghostsHtml, legendHtml, seatPanelHtml, scoreboardHtml, trickHtml, logHtml,
  handHtml, handoffHtml, gameEndHtml, tournamentEndHtml, endBarHtml, statusHtml,
} from './components.js';
import {
  landingHtml, howToPlayHtml, syncSetupForm, readSetup, defaultNames, DEFAULT_SETUP,
} from './landing.js';
import { statsStore, createRecorder, toCsv, toJson, exportFilename } from './stats-store.js';
import { statsHtml, statsButtonsHtml, download } from './stats-view.js';
import * as analytics from './analytics.js';
import { installBugReporter, logAction, logEvent } from './bug-report.js';

// ---------- hooks: local stats, analytics, bug-report action log ----------
// Each one is wrapped so that a failure in stats or analytics can never reach the game.
const recorder = createRecorder(statsStore);
const guard = (fn) => (arg) => { try { fn(arg); } catch (err) { try { logEvent('error', `hook failed: ${err && err.message}`); } catch { /* silent */ } } };

export const onGameStart = guard((info) => { recorder.gameStart(info); analytics.trackGameStart(info); });
export const onCardPlayed = guard((info) => {
  analytics.trackCardPlayed(info);
  for (const ev of info.events) {
    if (ev.type === 'card-played') logAction({ seat: ev.seat, seatType: info.seats[ev.seat], role: ev.role, card: ev.card, asLeader: ev.asLeader, trickNo: ev.trickNo, game: info.gameNo });
  }
});
export const onGameEnd = guard((info) => { recorder.gameEnd(info); analytics.trackGameEnd(info); });
export const onTournamentStart = guard((info) => analytics.trackTournamentStart(info));
export const onTournamentEnd = guard((info) => { recorder.tournamentEnd(info); analytics.trackTournamentEnd(info); });
export const onStatsOpened = guard(() => analytics.trackStatsViewed());
export const onRulesOpened = guard((source) => analytics.trackRulesOpened(source));

// ---------- state ----------
const params = new URLSearchParams(location.search);
const BOT_DELAY_MS = params.has('botdelay') ? Math.max(0, Math.min(5000, Number(params.get('botdelay')) || 0)) : 800;
let seedCounter = params.has('seed') ? Number(params.get('seed')) || 1 : null;

const app = document.getElementById('app');
const dialogRoot = document.getElementById('dialog-root');
const live = document.getElementById('live');
const coarse = typeof matchMedia === 'function' && matchMedia('(hover: none)').matches;

let ctl = null; // the running session's controller, or null on the landing page
let sid = 0; // session counter
let lastSetup = DEFAULT_SETUP;
let setupMessage = '';
let pump = null; // { stamp, sid, cancelled }: the bot turn being played
let processedEvents = null;
let announcedTrick = 0;
const decider = createBotDecider();

const ui = {
  selected: null, // touch screens: the card tapped once (preview shown, tap again to play)
  preview: null, // the card whose preview is on show
  note: '', // refusal text under the hand
  endClosed: false, // "Look at the board" closed the end panel
  wantHandFocus: false, // a keyboard player just played: give focus back to the hand on their next turn
  dialog: null, // 'rules' | 'stats' | null
  opener: null,
};
const shown = { sid: -1, gameNo: -1, trickNo: -1, whale: null }; // what the board last drew

// ---------- sessions ----------
function freshSeed() {
  if (seedCounter !== null) return seedCounter++;
  return Math.floor(Math.random() * 2147483646) + 1;
}

function uniqueNames(names) {
  return names[0] === names[1] ? [`${names[0]} 1`, `${names[1]} 2`] : names;
}

function sessionInfo() {
  const g = ctl.game();
  return {
    mode: ctl.mode,
    seed: ctl.seed,
    seats: ctl.seats.map((s) => s.type),
    names: [...ctl.names],
    roles: [...g.roles],
    gameNo: ctl.mode === 'tournament' ? ctl.state.gameNo : 1,
    wins: ctl.mode === 'tournament' ? [...ctl.state.wins] : null,
    gamesPlayed: ctl.mode === 'tournament' ? ctl.state.history.length : 1,
    game: g, // the live game state: read-only for the hooks (stats build their record from it)
  };
}

function endSession() {
  if (ctl) analytics.trackGameAbandoned(); // leaving a running game (Setup / Quit); a no-op if it had ended
  if (pump) pump.cancelled = true;
  pump = null;
  decider.cancelAll();
  ctl = null;
}

function startSession(setup) {
  endSession();
  const levels = botLevels();
  try {
    const next = createController({
      seats: setup.types.map((type) => ({ type })),
      roleChoices: setup.roles,
      mode: setup.mode,
      seed: freshSeed(),
      names: uniqueNames(defaultNames(setup, levels)),
    });
    ctl = next;
  } catch (err) {
    ctl = null;
    setupMessage = err.message;
    renderLanding(setup);
    return false;
  }
  lastSetup = setup;
  setupMessage = '';
  sid += 1;
  Object.assign(ui, { selected: null, preview: null, note: '', endClosed: false, wantHandFocus: false });
  Object.assign(shown, { sid: -1, gameNo: -1, trickNo: -1, whale: null });
  announcedTrick = 0;
  processedEvents = ctl.lastEvents;
  ctl.subscribe(onChange);
  if (ctl.mode === 'tournament') onTournamentStart(sessionInfo());
  onGameStart(sessionInfo());
  render();
  return true;
}

function onChange() {
  if (ctl.lastEvents !== processedEvents) {
    processedEvents = ctl.lastEvents;
    ui.note = '';
    ui.selected = null;
    ui.preview = null;
    fireHooks(processedEvents);
  }
  render();
}

function fireHooks(events) {
  const info = sessionInfo();
  for (const ev of events) {
    if (ev.type === 'game-started') {
      ui.endClosed = false;
      onGameStart({ ...info, gameNo: ev.gameNo, roles: ev.roles });
    }
  }
  if (events.some((e) => e.type === 'card-played')) {
    onCardPlayed({ ...info, events, trickDone: events.some((e) => e.type === 'trick-won') });
  }
  const over = events.find((e) => e.type === 'game-over');
  if (over) onGameEnd({ ...info, result: over });
  const tover = events.find((e) => e.type === 'tournament-over');
  if (tover) onTournamentEnd({ ...info, winnerSeat: tover.winnerSeat, wins: tover.wins });
}

// ---------- landing ----------
function renderLanding(setup = lastSetup) {
  endSession();
  document.body.dataset.screen = 'landing';
  app.innerHTML = landingHtml(botLevels(), setup, setupMessage);
  const form = document.getElementById('setup-form');
  if (form) syncSetupForm(form);
  window.scrollTo(0, 0);
}

// ---------- game screen ----------
function buildVm() {
  const g = ctl.game();
  const shownSeat = ctl.shownSeat();
  const reasons = new Map();
  if (shownSeat !== null) for (const c of g.hands[shownSeat]) reasons.set(c, getPlayBlockReason(ctl.state, shownSeat, c));
  const me = shownSeat !== null ? shownSeat : 0;
  return {
    ctl, g, ui, reasons, levels: botLevels(), shown: shownSeat, me, opp: 1 - me,
    myTurn: shownSeat !== null && g.phase !== 'over' && ctl.toAct() === shownSeat,
  };
}

function topbarHtml() {
  return '<div class="topbar"><button type="button" class="linkbtn" data-action="quit">&larr; Setup</button>'
    + '<span class="topbar__title">Ahab and the Whale</span>'
    + '<button type="button" class="linkbtn" data-action="open-rules">Rules</button></div>';
}

function gameHtml(vm) {
  const { g, ctl: c, shown: sh } = vm;
  const t = c.mode === 'tournament';
  const over = g.phase === 'over';
  const animate = shown.sid === sid && shown.gameNo === gameNo() && g.trickNo > shown.trickNo && shown.whale;
  const last = g.tricks[g.tricks.length - 1];
  const board = boardHtml(g, {
    from: animate ? shown.whale : null,
    bump: animate && last && last.blocked ? moveDir(last) : null,
  });
  const handBlock = sh === null ? '' : `<div class="handbox">
      <p class="handbox__title">${esc(c.seats.filter((s) => s.type === 'human').length === 2 ? `${c.names[sh]}'s hand` : 'Your hand')} <span>sorted by suit</span></p>
      <div class="hand-wrap">${handHtml(vm)}</div>
      <p class="preview" id="preview" aria-live="polite"></p>
      <p class="note" id="note" role="status">${esc(ui.note)}</p>
    </div>`;
  let overlay = '';
  if (over && !ui.endClosed) overlay = t && c.state.phase === 'over' ? tournamentEndHtml(vm) : gameEndHtml(vm);
  return `${topbarHtml()}
    <div class="game${over && ui.endClosed ? ' game--ended' : ''}">
      ${over && ui.endClosed ? endBarHtml(vm) : ''}
      <div class="col col--board">
        <div class="g-board">${board}${legendHtml()}</div>
        <div class="g-me">${seatPanelHtml(vm, vm.me, { showBacks: sh === null })}${handBlock}</div>
      </div>
      <div class="col col--side">
        <div class="g-status">${statusHtml(vm)}</div>
        ${t ? `<div class="g-score">${scoreboardHtml(vm)}</div>` : ''}
        <div class="g-opp">${seatPanelHtml(vm, vm.opp, { showBacks: true })}</div>
        <div class="g-trick">${trickHtml(vm)}</div>
        <div class="g-log">${logHtml(vm)}</div>
      </div>
    </div>${overlay}`;
}

function gameNo() {
  return ctl.mode === 'tournament' ? ctl.state.gameNo : 1;
}

function render() {
  if (!ctl) return;
  document.body.dataset.screen = 'game';
  const g = ctl.game();
  const hadHandFocus = !!(document.activeElement && document.activeElement.closest && document.activeElement.closest('.hand'));
  const hadOverlay = !!app.querySelector('.end, .cover');

  if (ctl.needsHandoff() && g.phase !== 'over') {
    // Pass-and-play: hands, board and log stay out of the DOM until the next player confirms.
    app.innerHTML = handoffHtml(buildVm());
    focusOverlay(hadOverlay);
    return;
  }

  const vm = buildVm();
  app.innerHTML = gameHtml(vm);
  syncWhale(g);
  refreshPreview(vm);
  announce(vm);
  focusOverlay(hadOverlay);
  // Keyboard users keep their place in the hand: a card played from the keyboard leaves focus
  // nowhere, so it is handed back to the first playable card once it is their turn again. Not on
  // touch screens (a refocus would look like a first tap), and not after a mouse click.
  if (hadHandFocus && keyboardUser) ui.wantHandFocus = true;
  if ((hadHandFocus || ui.wantHandFocus) && vm.myTurn && !coarse) {
    const first = app.querySelector('.hand .card.is-legal');
    if (first) first.focus({ preventScroll: true });
    ui.wantHandFocus = false;
  }
  pumpBots();
}

function focusOverlay(hadOverlay) {
  if (hadOverlay) return;
  const btn = app.querySelector('.end .btn--primary, .cover .btn--primary');
  if (btn) btn.focus({ preventScroll: false });
}

/** Moves the token from where it was last drawn to where the engine says it is (CSS transition). */
function syncWhale(g) {
  const tok = app.querySelector('.board:not(.board--mini) .whale');
  if (tok) {
    const { x, y } = g.whale;
    if (tok.dataset.fx !== String(x) || tok.dataset.fy !== String(y)) {
      void tok.offsetWidth; // commit the starting position so the change animates
      tok.style.transform = `translate(${x * 100}%,${y * 100}%)`;
    }
  }
  Object.assign(shown, { sid, gameNo: gameNo(), trickNo: g.trickNo, whale: { x: g.whale.x, y: g.whale.y } });
}

function announce(vm) {
  const { g } = vm;
  if (g.tricks.length > announcedTrick) {
    announcedTrick = g.tricks.length;
    live.textContent = trickSentence(g.tricks[g.tricks.length - 1], g.roles);
  }
}

// ---------- preview (hover / focus) ----------
const PREVIEW_HINT = coarse ? 'Tap a card to see where it would send the whale. Tap it again to play it.' : 'Hover or focus a card to see where it would send the whale.';

/** Fills the ghost layer and the preview line without re-rendering the screen. */
function refreshPreview(vm = ctl && buildVm()) {
  if (!ctl || !vm) return;
  const text = app.querySelector('#preview');
  const layer = app.querySelector('.board:not(.board--mini) .ghosts');
  if (!layer || !text) return;
  const card = vm.myTurn ? (ui.preview || ui.selected) : null;
  const p = card && vm.g.hands[vm.shown].includes(card) && vm.reasons.get(card) === null ? previewCard(vm.g, card) : null;
  layer.innerHTML = p ? ghostsHtml(p.ghosts, vm.g.rules.GRID_SIZE) : '';
  text.textContent = p ? p.text : (vm.myTurn ? PREVIEW_HINT : '');
  text.classList.toggle('preview--on', !!p);
  app.querySelectorAll('.hand .card.is-selected').forEach((el) => el.classList.remove('is-selected'));
  if (p && coarse) {
    const el = app.querySelector(`.hand .card[data-card="${card}"]`);
    if (el) el.classList.add('is-selected');
  }
}

function setPreview(card) {
  ui.preview = card;
  refreshPreview();
}

// ---------- playing ----------
function handleCard(card) {
  if (!ctl) return;
  const seat = ctl.shownSeat();
  if (seat === null) return;
  const g = ctl.game();
  if (g.phase === 'over' || ctl.toAct() !== seat) {
    ui.note = getPlayBlockReason(ctl.state, seat, card);
    logEvent('refused-click', `${card}: ${ui.note}`);
    return render();
  }
  const reason = getPlayBlockReason(ctl.state, seat, card);
  if (reason) { ui.selected = null; ui.preview = null; ui.note = reason; logEvent('refused-click', `${card}: ${reason}`); return render(); }
  if (coarse && ui.selected !== card) { // first tap on a touch screen previews
    ui.selected = card;
    ui.note = '';
    return refreshPreview();
  }
  const res = ctl.play({ type: 'play', card });
  if (!res.ok) { ui.note = res.error; logEvent('refused-play', `${card}: ${res.error}`); render(); }
}

// ---------- bots ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pumpBots() {
  if (!ctl || !ctl.isBotTurn()) return;
  let task = ctl.botTask();
  if (pump && pump.sid === sid && pump.stamp === task.stamp && !pump.cancelled) return;
  if (pump) pump.cancelled = true;
  const me = ctl;
  const p = { stamp: task.stamp, sid, cancelled: false };
  pump = p;
  (async () => {
    let pace = sleep(BOT_DELAY_MS); // ~0.8 s per bot card, counted from the start of its turn
    for (let attempt = 0; attempt < 6; attempt++) {
      const result = await decider.decide(task);
      document.body.dataset.botMode = decider.mode;
      await pace;
      pace = Promise.resolve();
      if (p.cancelled || ctl !== me) return;
      const out = me.applyBotResult(task, result);
      if (out === 'stale') return;
      if (out) return; // applied: onChange re-rendered and asked for the next turn
      task = me.botTask(); // refused: ask again (the failure cap guarantees this ends)
      if (!task) return;
    }
  })();
}

// ---------- dialogs ----------
function hasStats() {
  try { const d = statsStore.load(); return d.games.length > 0 || d.tournaments.length > 0; } catch { return false; }
}

function statsBody() {
  try { return statsHtml(statsStore.load()); } catch { return '<p class="st__empty">The stats could not be shown.</p>'; }
}

function exportStats(format) {
  const data = statsStore.load();
  const ok = format === 'csv'
    ? download(exportFilename('csv'), toCsv(data.games), 'text/csv;charset=utf-8')
    : download(exportFilename('json'), toJson(data), 'application/json');
  if (ok) analytics.trackStatsExported(format);
}

function renderDialog() {
  if (!ui.dialog) {
    dialogRoot.innerHTML = '';
    app.inert = false;
    if (ui.opener && ui.opener.isConnected) ui.opener.focus();
    ui.opener = null;
    return;
  }
  const rules = ui.dialog === 'rules';
  dialogRoot.innerHTML = `<div class="overlay overlay--dialog" data-overlay="dialog"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
    <button type="button" class="dialog__close" data-action="close-dialog" aria-label="Close">&times;</button>
    <h2 id="dlg-title">${rules ? 'How to play' : 'Stats'}</h2>
    ${rules ? howToPlayHtml() : statsBody()}
    <div class="dialog__buttons">${rules ? '' : statsButtonsHtml(hasStats())}<button type="button" class="btn btn--primary" data-action="close-dialog">Close</button></div>
  </div></div>`;
  app.inert = true;
  const close = dialogRoot.querySelector('.dialog__close');
  if (close) close.focus();
}

function openDialog(kind, opener) {
  ui.dialog = kind;
  ui.opener = opener || null;
  renderDialog();
  if (kind === 'rules') onRulesOpened('dialog'); else onStatsOpened();
}

function closeDialog() {
  ui.dialog = null;
  renderDialog();
}

// ---------- events ----------
document.addEventListener('click', (e) => {
  const overlay = e.target.closest && e.target.closest('[data-overlay="dialog"]');
  if (overlay && e.target === overlay) return closeDialog();
  const el = e.target.closest && e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  switch (action) {
    case 'play': handleCard(el.dataset.card); break;
    case 'reveal': if (ctl) ctl.reveal(Number(el.dataset.seat)); break;
    case 'next-game': if (ctl && ctl.canStartNextGame()) ctl.startNextGame(); break;
    case 'again': startSession(lastSetup); break;
    case 'new': setupMessage = ''; renderLanding(lastSetup); break;
    case 'quit':
      if (ctl && ctl.game().phase !== 'over' && ctl.game().trickNo > 0 && !window.confirm('Leave this game and go back to setup? The game in progress will be lost.')) break;
      setupMessage = '';
      renderLanding(lastSetup);
      break;
    case 'review': ui.endClosed = true; render(); break;
    case 'open-rules': openDialog('rules', el); break;
    case 'open-stats': openDialog('stats', el); break;
    case 'close-dialog': closeDialog(); break;
    case 'export-csv': exportStats('csv'); break;
    case 'export-json': exportStats('json'); break;
    case 'clear-stats':
      if (window.confirm('Delete all saved results from this browser? This cannot be undone.')) { statsStore.clear(); renderDialog(); }
      break;
    case 'rulebook': onRulesOpened('pdf'); break; // the link itself opens the PDF
    default: break;
  }
});

app.addEventListener('submit', (e) => {
  if (e.target.id !== 'setup-form') return;
  e.preventDefault();
  setupMessage = '';
  startSession(readSetup(e.target));
});

app.addEventListener('change', (e) => {
  const form = e.target.closest && e.target.closest('#setup-form');
  if (form) { syncSetupForm(form); lastSetup = readSetup(form); }
});

// Preview: pointer hover (mouse/pen only; touch uses tap-to-select) and keyboard focus.
app.addEventListener('pointerover', (e) => {
  if (e.pointerType === 'touch') return;
  const card = e.target.closest && e.target.closest('.hand .card[data-card]');
  if (card && card.dataset.card !== ui.preview) setPreview(card.dataset.card);
});
app.addEventListener('pointerout', (e) => {
  if (e.pointerType === 'touch') return;
  const card = e.target.closest && e.target.closest('.hand .card[data-card]');
  if (!card) return;
  const to = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.hand .card[data-card]');
  if (!to) setPreview(null);
});
app.addEventListener('focusin', (e) => {
  const card = e.target.closest && e.target.closest('.hand .card[data-card]');
  if (!card) ui.wantHandFocus = false; // focus went somewhere else on purpose
  if (card) setPreview(card.dataset.card);
});
app.addEventListener('focusout', (e) => {
  const card = e.target.closest && e.target.closest('.hand .card[data-card]');
  const to = e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.hand .card[data-card]');
  if (card && !to) setPreview(null);
});

// True while the last input was the keyboard (so a re-render may hand focus back to the hand).
let keyboardUser = false;
document.addEventListener('pointerdown', () => { keyboardUser = false; ui.wantHandFocus = false; }, true);
document.addEventListener('keydown', (e) => {
  keyboardUser = true;
  if (e.key === 'Escape' && ui.dialog) return closeDialog();
  // Arrow keys move along the hand.
  const card = e.target.closest && e.target.closest('.hand .card[data-card]');
  if (card && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
    const all = [...app.querySelectorAll('.hand .card[data-card]')];
    const i = all.indexOf(card);
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : Math.max(0, Math.min(all.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)));
    if (all[j]) { e.preventDefault(); all[j].focus(); }
    return;
  }
  // Keep Tab inside whichever modal is open.
  if (e.key === 'Tab') {
    const modal = dialogRoot.querySelector('.dialog') || app.querySelector('.end, .cover');
    if (!modal) return;
    const f = [...modal.querySelectorAll('button, a[href], input, select')].filter((x) => !x.disabled);
    if (!f.length) return;
    const first = f[0];
    const lastEl = f[f.length - 1];
    if (!modal.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); first.focus(); }
  }
});

// ---------- start ----------
installImageFallback();
analytics.installAbandonTracking();
installBugReporter(() => ({ ctl, screen: document.body.dataset.screen || null }));
loadManifest().then(() => {
  document.body.dataset.ready = '1';
  renderLanding(DEFAULT_SETUP);
});
