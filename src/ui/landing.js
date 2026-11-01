// landing.js - the landing page, which is also the setup screen (a sell sheet with a form in it),
// and the How to play text that the in-game Rules dialog reuses. Pure string builders plus two
// small form helpers; main.js owns the wiring.

import { assetUrl, img } from './assets.js';
import { esc, arrowImg, windGlyph } from './components.js';

export const RULEBOOK_URL = 'rules/ahab-and-the-whale-rule-book-v4.pdf';

export const DEFAULT_SETUP = {
  types: ['human', 'easy'],
  roles: ['random', 'random'],
  names: ['', ''],
  mode: 'single',
};

const ICON_PLAYERS = '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="13" cy="12" r="6" fill="#EDBE74"/><path d="M3 34c0-7 4.5-12 10-12s10 5 10 12z" fill="#EDBE74"/><circle cx="28" cy="12" r="6" fill="#D9622B"/><path d="M18 34c0-7 4.5-12 10-12s10 5 10 12z" fill="#D9622B"/></svg>';
const ICON_TIME = '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="15" fill="none" stroke="#EDBE74" stroke-width="3"/><path d="M20 10v10l7 4" stroke="#D9622B" stroke-width="3.2" stroke-linecap="round" fill="none"/></svg>';
const ICON_AGE = '<svg viewBox="0 0 40 40" aria-hidden="true"><rect x="7" y="5" width="20" height="28" rx="3" fill="#EDBE74" transform="rotate(-10 17 19)"/><rect x="14" y="8" width="20" height="28" rx="3" fill="#D9622B" stroke="#5A2E1E" stroke-width="1.5" transform="rotate(8 24 22)"/></svg>';

// ---------- How to play ----------

export function howToPlayHtml() {
  const wind = (s, name) => `<li>${windGlyph(s, 'how__glyph')}${arrowImg(s, 'how__arrow')}<span><b>${name}</b></span></li>`;
  return `<div class="how">
    <p class="how__lead">Twelve tricks. One whale. Every trick drags the whale one step across the sea chart.</p>
    <ol class="how__steps">
      <li><h3>Lead</h3><p>The leader plays any card. Its suit is the <b>wind</b> that blows: it picks the line the whale moves along.</p>
        <ul class="how__winds" aria-label="The four winds">${wind('N', 'North, up')}${wind('E', 'East, right')}${wind('S', 'South, down')}${wind('W', 'West, left')}</ul></li>
      <li><h3>Follow</h3><p>The other player must play the led wind if they can. The higher card wins. If they have none, they play any card and the <b>leader wins</b>. There are no trumps.</p></li>
      <li><h3>Move the whale</h3>
        <table class="how__table"><thead><tr><th scope="col">What happened</th><th scope="col">The whale moves</th></tr></thead><tbody>
          <tr><td>The leader won (the follower followed)</td><td><b>With</b> the led wind</td></tr>
          <tr><td>The follower won</td><td>The <b>opposite</b> way to the led wind</td></tr>
          <tr><td>Drift: the follower could not follow</td><td>The way of the wind the follower <b>discarded</b></td></tr>
        </tbody></table>
        <p class="how__note">One step only. If a step would leave the chart, the whale stays put. The winner leads next.</p></li>
      <li><h3>Drift</h3><p>When you cannot follow you lose the trick, but you steer: the whale goes the way of the wind on the card you throw. Sometimes the best card to lose is the one that points the right way.</p></li>
      <li><h3>Caught or free</h3><p>Only the whale's cell after trick 12 counts. Inside the inner 5&times;5 <b>harpoon range</b>, Ahab wins. On the outer ring of <b>open sea</b>, the Whale wins. The whale can touch the open sea earlier and be dragged back.</p></li>
    </ol>
    <p class="how__tournament"><b>First to 3:</b> play up to five games. Roles swap every game, and the score belongs to the seat, not the role.</p>
    <p class="how__link"><a href="${RULEBOOK_URL}" target="_blank" rel="noopener" data-action="rulebook">Read the full rule book (PDF)</a></p>
  </div>`;
}

// ---------- the page ----------

function heroHtml() {
  const wide = assetUrl('hero-wide');
  const source = wide ? `<source media="(min-width: 760px)" srcset="${wide}">` : '';
  const fallback = img('hero-square', { alt: 'Captain Ahab in his whaleboat hauls on the line to the white whale, in a folk-print border.', cls: 'hero__img', label: 'Ahab and the Whale' });
  return `<div class="hero__art"><picture>${source}${fallback}</picture></div>`;
}

function seatFieldset(i, levels, setup) {
  const type = setup.types[i];
  const role = setup.roles[i];
  const typeOpts = [{ id: 'human', label: 'Human' }, ...levels.map((l) => ({ id: l.id, label: `${l.label} bot` }))]
    .map((o) => `<option value="${esc(o.id)}"${o.id === type ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
  const roleOpts = [['random', 'Random'], ['ahab', 'Ahab'], ['whale', 'The Whale']]
    .map(([v, l]) => `<option value="${v}"${v === role ? ' selected' : ''}>${l}</option>`).join('');
  return `<fieldset class="seatform">
      <legend>Seat ${i + 1}</legend>
      <label class="field"><span>Player</span><select name="type${i}">${typeOpts}</select></label>
      <label class="field"><span>Plays as</span><select name="role${i}">${roleOpts}</select></label>
      <label class="field"><span>Name <small>(optional)</small></span><input name="name${i}" type="text" maxlength="20" autocomplete="off" value="${esc(setup.names[i])}" placeholder="${i === 0 ? 'You' : 'Seat 2'}"></label>
    </fieldset>`;
}

/** The whole landing / setup page. `levels` is botLevels(); `setup` the form defaults; `message` an error. */
export function landingHtml(levels, setup = DEFAULT_SETUP, message = '') {
  return `<div class="landing">
    <nav class="topnav" aria-label="Site">
      <span class="topnav__brand">Ahab and the Whale</span>
      <span class="topnav__links">
        <button type="button" class="linkbtn" data-action="open-rules">Rules</button>
        <button type="button" class="linkbtn" data-action="open-stats">Stats</button>
      </span>
    </nav>
    <header class="hero">
      ${heroHtml()}
      <div class="hero__text">
        <p class="hero__kicker">After Herman Melville's <i>Moby-Dick</i></p>
        <h1 class="hero__title">Ahab <span>and the</span> Whale</h1>
        <p class="hero__hook">The suit you lead is the wind that blows.</p>
        <p class="hero__sub">A two-player trick-taking duel on a sea chart. Lead and win, the whale goes forward. Lead and lose, it goes backwards.</p>
      </div>
    </header>
    <ul class="stats" aria-label="At a glance">
      <li>${ICON_PLAYERS}<div><b>2</b><span>Players</span></div></li>
      <li>${ICON_TIME}<div><b>10</b><span>Minutes</span></div></li>
      <li>${ICON_AGE}<div><b>10+</b><span>Ages</span></div></li>
    </ul>
    <section class="panel setup-panel" aria-labelledby="setup-title">
      <h2 id="setup-title">Set sail</h2>
      <form id="setup-form" novalidate>
        <div class="setup__seats">${seatFieldset(0, levels, setup)}${seatFieldset(1, levels, setup)}</div>
        <fieldset class="modeform">
          <legend>Mode</legend>
          <label class="radio"><input type="radio" name="mode" value="single"${setup.mode === 'single' ? ' checked' : ''}> <span><b>Single game</b> One hand of twelve tricks, about ten minutes.</span></label>
          <label class="radio"><input type="radio" name="mode" value="tournament"${setup.mode === 'tournament' ? ' checked' : ''}> <span><b>First to 3</b> Up to five games, roles swap every game.</span></label>
        </fieldset>
        <p class="hint">Set both seats to bots to watch a game. Set both to Human to pass and play on one device.</p>
        <p class="form-msg" role="alert">${esc(message)}</p>
        <button type="submit" class="btn btn--primary btn--big">Set sail</button>
      </form>
    </section>
    <section class="panel" id="how" aria-labelledby="how-title">
      <h2 id="how-title">How to play</h2>
      ${howToPlayHtml()}
    </section>
    <footer class="footer">
      <span><b>Dean Morris</b> &middot; Wombat Game Factory &middot; London, UK</span>
      <span>Rule book v4 &middot; Prototype art</span>
    </footer>
  </div>`;
}

// ---------- form helpers ----------

/**
 * Keeps the role selects honest (no two fixed seats on the same role): a role chosen on one
 * seat is disabled on the other, and a clash is reset to Random.
 */
export function syncSetupForm(form) {
  const roles = [form.elements.role0, form.elements.role1];
  roles.forEach((sel, i) => {
    const other = roles[1 - i];
    for (const opt of sel.options) opt.disabled = opt.value !== 'random' && opt.value === other.value;
    if (sel.selectedOptions[0] && sel.selectedOptions[0].disabled) sel.value = 'random';
  });
}

/** Reads the form into a setup object (never throws). */
export function readSetup(form) {
  const v = (n) => (form.elements[n] ? form.elements[n].value : '');
  const mode = (form.querySelector('input[name="mode"]:checked') || {}).value || 'single';
  return {
    types: [v('type0'), v('type1')],
    roles: [v('role0') || 'random', v('role1') || 'random'],
    names: [v('name0').trim(), v('name1').trim()],
    mode,
  };
}

/** Default display names for a setup: "You" for a lone human, "Player n" for two, "Easy bot" for bots. */
export function defaultNames(setup, levels) {
  const humans = setup.types.filter((t) => t === 'human').length;
  const labels = setup.types.map((t) => (t === 'human' ? null : (levels.find((l) => l.id === t) || { label: t }).label));
  const botSame = setup.types[0] !== 'human' && setup.types[0] === setup.types[1];
  return setup.types.map((t, i) => {
    const typed = setup.names[i];
    if (typed) return typed;
    if (t === 'human') return humans === 2 ? `Player ${i + 1}` : 'You';
    return botSame ? `${labels[i]} bot ${i + 1}` : `${labels[i]} bot`;
  });
}
