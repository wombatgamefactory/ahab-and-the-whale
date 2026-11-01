// components.js - HTML builders for the game screen. Pure string functions: state in, markup out.
//
// main.js owns state, timing and events; nothing here touches the DOM or the clock. All art
// goes through assets.js. Look lives in style.css (class names here, geometry as inline style).

import { cardSuit, cardRank, cardName, SUIT_NAMES, ROLE_NAMES, isOpenSea } from '../engine/index.js';
import { img, GLYPH_ID, ARROW_ID, FACE_ID } from './assets.js';
import { ROLE_LABEL, trickSentence, trickHeadline, moveDir } from './text.js';

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const GOAL = {
  ahab: 'wants the whale inside harpoon range after trick 12',
  whale: 'wants the whale out on the open sea after trick 12',
};

// ---------- small pieces ----------

/** "Human" / "Easy" / ... as a badge. `levels` is botLevels(). */
export function typeBadge(type, levels) {
  if (type === 'human') return '<span class="badge badge--human">Human</span>';
  const lvl = levels.find((l) => l.id === type);
  return `<span class="badge badge--bot badge--${esc(type)}">${esc(lvl ? lvl.label : type)}</span>`;
}

export function roleImg(role, cls = 'role-img') {
  return img(role === 'ahab' ? 'role-ahab' : 'role-whale', { alt: ROLE_LABEL[role], cls });
}

export function windGlyph(suit, cls = 'glyph') {
  return img(GLYPH_ID[suit], { alt: SUIT_NAMES[suit], cls, label: SUIT_NAMES[suit][0] });
}

export function arrowImg(suit, cls = 'arrow') {
  return img(ARROW_ID[suit], { alt: SUIT_NAMES[suit], cls, label: SUIT_NAMES[suit][0] });
}

/**
 * A card face: suit art, the rank as HTML text in the suit colour (ace shows as 1) and the
 * wind glyph, top-left and mirrored bottom-right.
 * opts: tag 'button' | 'div'; cls extra classes; attrs raw attribute string.
 */
export function cardHtml(card, { tag = 'div', cls = '', attrs = '', label = '' } = {}) {
  const suit = cardSuit(card);
  const rank = cardRank(card);
  const aria = label || cardName(card);
  const role = tag === 'button' ? '' : ' role="img"';
  return `<${tag} class="card suit-${suit} ${cls}" ${attrs}${role} aria-label="${esc(aria)}">`
    + img(FACE_ID[suit], { alt: '', cls: 'card__face', label: SUIT_NAMES[suit] })
    + `<span class="card__corner" aria-hidden="true"><span class="card__num">${rank}</span>${windGlyph(suit, 'card__glyph')}</span>`
    + `<span class="card__corner card__corner--br" aria-hidden="true"><span class="card__num">${rank}</span>${windGlyph(suit, 'card__glyph')}</span>`
    + `</${tag}>`;
}

export function cardBack(cls = '') {
  return img('card-back', { alt: '', cls: `card-back ${cls}`, label: 'card' });
}

export function emptySlot(text) {
  return `<div class="card card--empty" aria-hidden="true"><span>${esc(text)}</span></div>`;
}

// ---------- board ----------

/**
 * The sea chart: the board image with a CSS grid laid over its 7x7 cells (17.45% inset,
 * cells 9.3% wide), the whale token, and an empty layer for preview ghosts.
 * opts: from = cell the token is drawn at first (the UI then moves it to `whale`), bump = dir
 * suit to nudge toward when the last step was blocked, mini = static small board.
 */
export function boardHtml(g, { from = null, bump = null, mini = false } = {}) {
  const n = g.rules.GRID_SIZE;
  const start = from || g.whale;
  const open = isOpenSea(g.whale, g.rules);
  const where = open ? 'on the open sea' : 'in harpoon range';
  const aria = `Sea chart, ${n} by ${n}. The whale is in column ${g.whale.x + 1}, row ${g.whale.y + 1} from the top left, ${where}.`;
  let cells = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      cells += `<span class="cell ${isOpenSea({ x, y }, g.rules) ? 'cell--open' : 'cell--range'}"></span>`;
    }
  }
  const bumpVars = bump ? { N: '0,-1', E: '1,0', S: '0,1', W: '-1,0' }[bump].split(',') : null;
  return `<div class="board${mini ? ' board--mini' : ''}" role="group" aria-label="${esc(aria)}" style="--n:${n}">`
    + img('board-7x7', { alt: '', cls: 'board__img', label: 'Sea chart' })
    + `<div class="board__grid" aria-hidden="true">${cells}`
    + '<div class="ghosts"></div>'
    + `<div class="whale${open ? ' whale--open' : ''}" data-x="${g.whale.x}" data-y="${g.whale.y}" data-fx="${start.x}" data-fy="${start.y}" style="transform:translate(${start.x * 100}%,${start.y * 100}%)">`
    + `<div class="whale__inner${bumpVars ? ' whale__inner--bump' : ''}"${bumpVars ? ` style="--bx:${bumpVars[0]};--by:${bumpVars[1]}"` : ''}>`
    + img('whale-token', { alt: 'The whale', cls: 'whale__img', label: 'Whale' })
    + '</div></div></div></div>';
}

/** Ghost markers for a preview (see preview.js): where the whale would go. */
export function ghostsHtml(ghosts, n) {
  return ghosts.map((gh) => {
    const label = gh.stays ? 'stays at the edge' : (gh.tone === 'lose' ? 'if they win' : gh.tone === 'win' ? 'if you win' : 'lands here');
    return `<span class="ghost ghost--${gh.tone}${gh.stays ? ' ghost--stays' : ''}" title="${esc(`${SUIT_NAMES[gh.dir]}, ${label}`)}" style="transform:translate(${gh.cell.x * 100}%,${gh.cell.y * 100}%)">`
      + `<span class="ghost__dot">${arrowImg(gh.dir, 'ghost__arrow')}</span></span>`;
  }).join('');
}

export function legendHtml() {
  return '<p class="legend"><span class="legend__item"><i class="swatch swatch--open"></i> Open sea: the Whale wins</span>'
    + '<span class="legend__item"><i class="swatch swatch--range"></i> Harpoon range: Ahab wins</span></p>';
}

// ---------- seats ----------

function seatStatus(vm, seat) {
  const { g, ctl } = vm;
  if (g.phase === 'over') return '';
  if (ctl.toAct() !== seat) return 'Waiting';
  const bot = ctl.seats[seat].type !== 'human';
  const verb = g.phase === 'lead' ? 'Leading' : `Following ${SUIT_NAMES[cardSuit(g.lead)]}`;
  return bot ? `<span class="thinking">${verb}<i></i><i></i><i></i></span>` : `<strong>${verb}</strong>`;
}

export function seatPanelHtml(vm, seat, { showBacks }) {
  const { g, ctl, levels } = vm;
  const role = g.roles[seat];
  const turn = g.phase !== 'over' && ctl.toAct() === seat;
  const n = g.hands[seat].length;
  const backs = showBacks
    ? `<div class="seat__backs" role="img" aria-label="${n} cards in hand" title="${n} cards in hand">${`<span class="seat__back">${cardBack()}</span>`.repeat(n)}<span class="seat__count">&times;${n}</span></div>`
    : '';
  return `<div class="seat seat--${role}${turn ? ' is-turn' : ''}">`
    + roleImg(role, 'seat__role-img')
    + '<div class="seat__body">'
    + `<div class="seat__name"><strong>${esc(ctl.names[seat])}</strong> ${typeBadge(ctl.seats[seat].type, levels)}</div>`
    + `<div class="seat__role"><b>${esc(ROLE_NAMES[role].replace(/^the /, ''))}</b> <span>${esc(GOAL[role])}</span></div>`
    + '</div>'
    + `<div class="seat__side">${backs}<div class="seat__status">${seatStatus(vm, seat)}</div></div>`
    + '</div>';
}

// ---------- scoreboard (tournament) ----------

export function scoreboardHtml(vm) {
  const { ctl, g, levels } = vm;
  const t = ctl.state;
  const need = t.rules.TOURNAMENT_WINS_NEEDED;
  const max = t.rules.TOURNAMENT_MAX_GAMES;
  const row = (seat) => {
    let pips = '';
    for (let i = 0; i < need; i++) pips += `<i class="pip${i < t.wins[seat] ? ' pip--won' : ''}"></i>`;
    return `<li class="score__seat score__seat--${g.roles[seat]}">`
      + roleImg(g.roles[seat], 'score__role')
      + `<span class="score__who"><strong>${esc(ctl.names[seat])}</strong> ${typeBadge(ctl.seats[seat].type, levels)}`
      + `<small>${esc(ROLE_LABEL[g.roles[seat]])} this game</small></span>`
      + `<span class="score__wins" aria-label="${t.wins[seat]} games won of ${need}">${pips}<b>${t.wins[seat]}</b></span></li>`;
  };
  return `<div class="score" aria-label="Tournament score"><p class="score__title">Game ${t.gameNo} of up to ${max} <span>First to ${need} wins</span></p><ul>${row(0)}${row(1)}</ul></div>`;
}

// ---------- trick area and log ----------

export function trickHtml(vm) {
  const { g, ctl } = vm;
  const roleOf = (seat) => ROLE_LABEL[g.roles[seat]];
  const slot = (seat, card, label) => `<div class="trick__slot">`
    + `<span class="trick__label">${esc(label)}${seat !== null ? ` &middot; ${esc(roleOf(seat))}` : ''}</span>`
    + (card ? cardHtml(card, { cls: 'card--trick' }) : emptySlot('?'))
    + '</div>';

  if (g.lead) {
    const f = 1 - g.leader;
    return `<div class="trick" aria-live="polite"><div class="trick__cards">${slot(g.leader, g.lead, 'Led')}${slot(f, null, 'Follow')}</div>`
      + `<p class="trick__line">${esc(roleOf(g.leader))} led <b>${esc(SUIT_NAMES[cardSuit(g.lead)])}</b>. ${esc(roleOf(f))} must follow ${esc(SUIT_NAMES[cardSuit(g.lead)])} if able; if not, the leader wins and the follower's discard steers.</p></div>`;
  }
  const last = g.tricks[g.tricks.length - 1];
  if (!last) {
    const first = g.toAct !== null ? roleOf(g.toAct) : roleOf(g.leader);
    return `<div class="trick trick--empty"><div class="trick__cards">${slot(null, null, 'Led')}${slot(null, null, 'Follow')}</div>`
      + `<p class="trick__line">No cards played yet. ${esc(first)} leads the first trick.</p></div>`;
  }
  const dir = moveDir(last);
  return `<div class="trick trick--done" aria-live="polite"><div class="trick__cards">${slot(last.leader, last.lead, `Trick ${last.n} led`)}${slot(last.follower, last.follow, last.followed ? 'Followed' : 'Discard')}`
    + (dir ? `<div class="trick__move" title="${esc(SUIT_NAMES[dir])}">${arrowImg(dir, 'trick__arrow')}<span>${esc(SUIT_NAMES[dir])}${last.blocked ? ' (blocked)' : ''}</span></div>` : '')
    + `</div><p class="trick__line"><b>${esc(trickHeadline(last))}.</b></p></div>`;
}

export function logHtml(vm) {
  const { g } = vm;
  if (!g.tricks.length) return '<h3 class="log__title">Trick log</h3><p class="log__empty">Each trick will be written up here.</p>';
  const items = [...g.tricks].reverse().map((t) => {
    const dir = moveDir(t);
    return `<li class="log__item"><span class="log__n">${t.n}</span>${dir ? arrowImg(dir, 'log__arrow') : ''}<span class="log__text">${esc(trickSentence(t, g.roles))}</span></li>`;
  }).join('');
  return `<h3 class="log__title">Trick log</h3><ol class="log__list" reversed>${items}</ol>`;
}

// ---------- my hand ----------

/**
 * The shown hand, sorted by suit (the engine keeps hands sorted). Illegal cards are dimmed,
 * stay clickable and carry the engine's reason as title and aria-label.
 * vm.reasons: card -> block reason (null = playable) for the shown seat.
 */
export function handHtml(vm) {
  const { g, shown, reasons, ui } = vm;
  const cards = g.hands[shown];
  if (!cards.length) return '<p class="hand__empty">No cards left.</p>';
  const body = cards.map((card) => {
    const reason = reasons.get(card);
    const playable = reason === null;
    const state = !vm.myTurn ? 'is-wait' : (playable ? 'is-legal' : 'is-blocked');
    const title = !vm.myTurn || !playable ? reason : `Play ${cardName(card)}`;
    const sel = ui.selected === card ? ' is-selected' : '';
    return cardHtml(card, {
      tag: 'button',
      cls: `${state}${sel}`,
      attrs: `type="button" data-action="play" data-card="${card}" title="${esc(title)}" aria-disabled="${playable && vm.myTurn ? 'false' : 'true'}"`,
      label: playable && vm.myTurn ? `${cardName(card)}, playable` : `${cardName(card)}, cannot play now: ${reason}`,
    });
  }).join('');
  return `<div class="hand" style="--n:${cards.length}" role="group" aria-label="Your hand, sorted by suit">${body}</div>`;
}

// ---------- overlays ----------

export function handoffHtml(vm) {
  const { g, ctl, levels } = vm;
  const seat = ctl.toAct();
  const role = g.roles[seat];
  return '<div class="cover" role="dialog" aria-modal="true" aria-labelledby="cover-title">'
    + '<div class="cover__card">'
    + roleImg(role, 'cover__role')
    + `<p class="cover__kicker">Hands are hidden</p>`
    + `<h2 id="cover-title">Pass to ${esc(ctl.names[seat])} (${esc(ROLE_LABEL[role])})</h2>`
    + `<p class="cover__role-name">${typeBadge('human', levels)}</p>`
    + `<p class="cover__sub">${g.phase === 'lead' ? 'You lead the trick.' : `You follow ${esc(SUIT_NAMES[cardSuit(g.lead)])}.`} Only ${esc(ctl.names[seat])} should look.</p>`
    + `<button type="button" class="btn btn--primary" data-action="reveal" data-seat="${seat}">I am ${esc(ctl.names[seat])}: show my hand</button>`
    + '<p class="cover__links"><button type="button" class="linkbtn" data-action="open-rules">Rules</button> <button type="button" class="linkbtn" data-action="quit">Quit to setup</button></p>'
    + '</div></div>';
}

function whyLine(result) {
  return result.winnerRole === 'ahab'
    ? 'The whale ended inside harpoon range: Ahab wins.'
    : 'The whale ended out on the open sea: the Whale wins.';
}

/** The game-over panel (single game, or a tournament game with more to play). */
export function gameEndHtml(vm) {
  const { g, ctl, levels } = vm;
  const r = g.result;
  const t = ctl.mode === 'tournament' ? ctl.state : null;
  const winnerRole = ROLE_LABEL[r.winnerRole];
  const humanWon = ctl.seats[r.winnerSeat].type === 'human';
  const humans = ctl.seats.filter((s) => s.type === 'human').length;
  const heading = humans === 1 ? (humanWon ? 'You win!' : `${esc(ctl.names[r.winnerSeat])} wins`) : `${esc(ctl.names[r.winnerSeat])} wins`;
  const sub = `${esc(ctl.names[r.winnerSeat])} played ${esc(winnerRole)}.`;
  const buttons = t
    ? '<button type="button" class="btn btn--primary" data-action="next-game">Next game</button>'
      + '<button type="button" class="btn" data-action="review">Look at the board</button>'
      + '<button type="button" class="btn" data-action="new">Quit to setup</button>'
      + '<button type="button" class="btn" data-action="open-stats">Stats</button>'
    : '<button type="button" class="btn btn--primary" data-action="again">Play again</button>'
      + '<button type="button" class="btn" data-action="new">New setup</button>'
      + '<button type="button" class="btn" data-action="review">Look at the board</button>'
      + '<button type="button" class="btn" data-action="open-stats">Stats</button>';
  return endShell({
    kicker: t ? `Game ${t.history[t.history.length - 1].gameNo} over` : 'Game over',
    heading: `${heading}`,
    role: r.winnerRole,
    body: `<p class="end__line">${sub} ${esc(whyLine(r))}</p>`
      + `<div class="end__board">${boardHtml(g, { mini: true })}</div>`
      + `<p class="end__seats">${[0, 1].map((s) => `<span>${esc(ctl.names[s])} ${typeBadge(ctl.seats[s].type, levels)} <em>${esc(ROLE_LABEL[g.roles[s]])}</em></span>`).join('')}</p>`
      + (t ? scoreboardHtml(vm) : ''),
    buttons,
  });
}

/** The tournament-over panel. */
export function tournamentEndHtml(vm) {
  const { g, ctl, levels } = vm;
  const t = ctl.state;
  const w = t.winnerSeat;
  const humans = ctl.seats.filter((s) => s.type === 'human').length;
  const humanWon = ctl.seats[w].type === 'human';
  const heading = humans === 1 ? (humanWon ? 'You win the tournament!' : `${esc(ctl.names[w])} wins the tournament`) : `${esc(ctl.names[w])} wins the tournament`;
  const rows = t.history.map((h) => {
    const wr = ROLE_LABEL[h.winnerRole];
    return `<li>Game ${h.gameNo}: <b>${esc(ctl.names[h.winnerSeat])}</b> won as ${esc(wr)} <span>(whale ${isOpenSea(h.whale, t.rules) ? 'on the open sea' : 'in harpoon range'})</span></li>`;
  }).join('');
  const last = g.result;
  return endShell({
    kicker: `Tournament over, ${t.wins[w]}–${t.wins[1 - w]}`,
    heading,
    role: g.roles[w],
    body: `<div class="end__board">${boardHtml(g, { mini: true })}</div>`
      + `<p class="end__line">Last game: ${esc(whyLine(last))}</p>`
      + scoreboardHtml(vm)
      + `<ol class="end__history">${rows}</ol>`
      + `<p class="end__seats">${[0, 1].map((s) => `<span>${esc(ctl.names[s])} ${typeBadge(ctl.seats[s].type, levels)}</span>`).join('')}</p>`,
    buttons: '<button type="button" class="btn btn--primary" data-action="again">Play again</button>'
      + '<button type="button" class="btn" data-action="review">Look at the board</button>'
      + '<button type="button" class="btn" data-action="new">New setup</button>'
      + '<button type="button" class="btn" data-action="open-stats">Stats</button>',
  });
}

function endShell({ kicker, heading, role, body, buttons }) {
  return '<div class="overlay" data-overlay="end"><div class="end" role="dialog" aria-modal="true" aria-labelledby="end-title">'
    + `${roleImg(role, 'end__role')}<p class="end__kicker">${esc(kicker)}</p><h2 id="end-title">${heading}</h2>`
    + `${body}<div class="end__buttons">${buttons}</div></div></div>`;
}

/** Slim bar shown after "Look at the board" closes the panel. */
export function endBarHtml(vm) {
  const { ctl } = vm;
  const t = ctl.mode === 'tournament' ? ctl.state : null;
  const last = vm.g.result;
  const text = t && t.phase === 'over' ? `Tournament over: ${esc(ctl.names[t.winnerSeat])} wins ${t.wins[t.winnerSeat]}–${t.wins[1 - t.winnerSeat]}.` : `${esc(ctl.names[last.winnerSeat])} won as ${esc(ROLE_LABEL[last.winnerRole])}.`;
  const main = t && t.phase === 'between'
    ? '<button type="button" class="btn btn--primary btn--small" data-action="next-game">Next game</button>'
    : '<button type="button" class="btn btn--primary btn--small" data-action="again">Play again</button>';
  return `<div class="endbar"><span>${text}</span>${main}<button type="button" class="btn btn--small" data-action="new">New setup</button></div>`;
}

// ---------- status banner ----------

export function statusHtml(vm) {
  const { g, ctl } = vm;
  let pips = '';
  for (let i = 0; i < g.rules.HAND_SIZE; i++) pips += `<i class="tpip${i < g.trickNo ? ' tpip--done' : (i === g.trickNo && g.phase !== 'over' ? ' tpip--now' : '')}"></i>`;
  const shownTrick = Math.min(g.trickNo + (g.phase === 'over' ? 0 : 1), g.rules.HAND_SIZE);
  let line;
  if (g.phase === 'over') line = 'Game over.';
  else {
    const seat = ctl.toAct();
    const bot = ctl.seats[seat].type !== 'human';
    const who = `${esc(ctl.names[seat])} (${esc(ROLE_LABEL[g.roles[seat]])})`;
    const human = ctl.seats.filter((s) => s.type === 'human').length;
    if (bot) line = `${who} is ${g.phase === 'lead' ? 'choosing a card to lead' : 'choosing a reply'}…`;
    else if (human === 1) line = g.phase === 'lead' ? `Your turn: lead any card.` : `Your turn: follow ${esc(SUIT_NAMES[cardSuit(g.lead)])} if you can.`;
    else line = `${who}: ${g.phase === 'lead' ? 'lead any card' : `follow ${esc(SUIT_NAMES[cardSuit(g.lead)])} if able`}.`;
  }
  return `<div class="status"><div class="status__trick"><b>Trick ${shownTrick}</b><span>of ${g.rules.HAND_SIZE}</span></div>`
    + `<div class="status__main"><p class="status__line">${line}</p><div class="tpips" aria-hidden="true">${pips}</div></div></div>`;
}
