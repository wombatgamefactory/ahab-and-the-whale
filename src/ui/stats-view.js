// stats-view.js - the stats screen markup (a dialog body) and the download helper. Pure string
// builders except download(), which needs the DOM. Numbers always come with their counts so a
// small sample is obvious.

import { esc } from './components.js';
import { summarise } from './stats-store.js';

const TYPE_LABEL = { human: 'Human', easy: 'Easy', medium: 'Medium', hard: 'Hard' };
const label = (t) => TYPE_LABEL[t] || t;

const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '-');
const sample = (n) => (n < 10 ? ' <span class="st__small" title="Fewer than 10 games: treat with care">(small sample)</span>' : '');

function matchupName(m) {
  if (m.ahabType === 'human' && m.whaleType === 'human') return 'Human v Human';
  return `${label(m.ahabType)} as Ahab v ${label(m.whaleType)} as Whale`;
}

function heatmapHtml(s) {
  const size = s.heat.length;
  const cells = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = s.heat[y][x];
      const a = s.heatMax ? n / s.heatMax : 0;
      const ring = x === 0 || y === 0 || x === size - 1 || y === size - 1;
      cells.push(`<li class="heat__cell${ring ? ' heat__cell--sea' : ''}${a > 0.55 ? ' heat__cell--hot' : ''}" style="--a:${a.toFixed(3)}" title="Column ${x + 1}, row ${y + 1}: ${n} game${n === 1 ? '' : 's'}">${n || ''}</li>`);
    }
  }
  return `<ol class="heat" style="--n:${size}" aria-label="Where the whale finished, games per cell. North is up.">${cells.join('')}</ol>`;
}

/** The whole stats dialog body. */
export function statsHtml(data) {
  const s = summarise(data.games, data.tournaments);
  if (!s.total && !s.tournaments) {
    return '<div class="st"><p class="st__empty">No games recorded yet. Finish a game and your results will appear here. They are kept in this browser only.</p></div>';
  }
  const rows = s.matchups.map((m) => `<tr><th scope="row">${esc(matchupName(m))}</th><td>${m.n}</td><td>${m.ahabWins}</td><td>${pct(m.ahabWins, m.n)}${sample(m.n)}</td></tr>`).join('');
  const lead = (role, name) => {
    const l = s.lead[role];
    return `<tr><th scope="row">${name} led trick 1</th><td>${l.n}</td><td>${l.won}</td><td>${pct(l.won, l.n)}${sample(l.n)}</td></tr>`;
  };
  const tw = Object.entries(s.tournamentWinners).map(([t, n]) => `${esc(label(t))} ${n}`).join(', ');
  const recent = data.tournaments.slice(-5).reverse().map((t) => `<li>${esc(new Date(t.date).toLocaleDateString('en-GB'))}: ${esc(label(t.seats[0]))} ${t.wins[0]}&ndash;${t.wins[1]} ${esc(label(t.seats[1]))} over ${t.gamesPlayed} games, <b>${esc(label(t.winnerType))}</b> (seat ${t.winnerSeat + 1}) won</li>`).join('');
  return `<div class="st">
    <p class="st__lead"><b>${s.total}</b> game${s.total === 1 ? '' : 's'} played. Ahab won <b>${s.ahabWins}</b> (${pct(s.ahabWins, s.total)}), the Whale <b>${s.whaleWins}</b> (${pct(s.whaleWins, s.total)}).${sample(s.total)}</p>
    <h3>Ahab win rate by matchup</h3>
    <div class="st__scroll"><table class="st__table"><thead><tr><th scope="col">Matchup</th><th scope="col">Games</th><th scope="col">Ahab won</th><th scope="col">Ahab win rate</th></tr></thead><tbody>${rows}</tbody></table></div>
    <h3>Does leading first help?</h3>
    <div class="st__scroll"><table class="st__table"><thead><tr><th scope="col">First leader</th><th scope="col">Games</th><th scope="col">Leader won</th><th scope="col">Win rate</th></tr></thead><tbody>${lead('ahab', 'Ahab')}${lead('whale', 'Whale')}
      <tr><th scope="row">Either role</th><td>${s.leadOverall.n}</td><td>${s.leadOverall.won}</td><td>${pct(s.leadOverall.won, s.leadOverall.n)}${sample(s.leadOverall.n)}</td></tr></tbody></table></div>
    <h3>Tournaments</h3>
    ${s.tournaments ? `<p>${s.tournaments} finished${tw ? `. Won by: ${tw}.` : '.'}</p><ul class="st__list">${recent}</ul>` : '<p class="st__muted">No finished tournaments yet.</p>'}
    <h3>Where the whale finished</h3>
    <p class="st__muted">Final cell after trick 12, all ${s.total} games. The outer ring is open sea.</p>
    ${heatmapHtml(s)}
    <p class="st__muted">Stored in this browser only (last 2000 games). Nothing here is sent anywhere.</p>
  </div>`;
}

export function statsButtonsHtml(hasData) {
  return '<button type="button" class="btn btn--small" data-action="export-csv"' + (hasData ? '' : ' disabled') + '>Export CSV</button>'
    + '<button type="button" class="btn btn--small" data-action="export-json"' + (hasData ? '' : ' disabled') + '>Export JSON</button>'
    + '<button type="button" class="btn btn--small" data-action="clear-stats"' + (hasData ? '' : ' disabled') + '>Clear</button>';
}

/** Blob + <a download>. Returns true if the click was issued. Never throws. */
export function download(filename, text, mime) {
  try {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return true;
  } catch {
    return false;
  }
}
