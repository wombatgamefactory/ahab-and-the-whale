# Ahab and the Whale

A two-player trick-taking duel after *Moby-Dick*, played in the browser. About ten minutes a game, ages 10 and up.

One player is Captain Ahab, the other is the White Whale. Twelve tricks drag a whale token across a 7×7 sea chart. **The suit you lead is the wind that blows**: it decides which way the whale moves. After trick twelve, if the whale is out on the open sea (the outer ring of the chart) the Whale wins. If it is still inside harpoon range (the inner 5×5), Ahab wins.

**Play it online: <https://www.wombatgamefactory.com/ahab-and-the-whale/>**

## What is in the game

- A single game, or a first-to-three tournament where the roles swap every game.
- Each seat can be a Human or an Easy, Medium or Hard bot. Two humans can pass and play on one device (the hands are hidden between turns). Two bots play each other, which is a good way to watch a game.
- A preview as you hover over (or tap) a card: where the whale would go.
- A local stats screen with CSV and JSON export. Results stay in your browser; nothing about who won is sent anywhere. The live site counts anonymous usage (games started and finished, never results) with Google Analytics, behind a cookie-consent banner; neither loads on localhost.
- The printed rule book, as a PDF, in [`rules/`](rules/ahab-and-the-whale-rule-book-v4.pdf), and a short how-to-play on the page.
- A built-in "report a problem" button (also Ctrl+Shift+B) that saves a JSON snapshot of the game as it stands, for bug reports.

## Run it locally

There is no build step and nothing to install. The game is plain JavaScript modules, HTML and CSS.

```sh
npm run dev
```

This serves the folder on <http://localhost:8080> (it uses `npx http-server`, so it needs Node.js and an internet connection the first time). Any other static file server works too: serve the repository root and open `index.html` through it. Opening the file directly from disk will not work in most browsers, because modules need a server.

Two URL options are handy while testing: `?seed=7` makes the deals repeatable, and `?botdelay=50` sets the pause (in milliseconds) before each bot move.

## Tests

```sh
npm test
```

Runs every Node test suite: the rules, a replay of games recorded from an independent Python implementation, a smoke test that plays thousands of bot games, the bots, the game controller, the stats store and the interface helpers. It takes about half a minute and needs only Node.js.

```sh
npm run test:browser
```

Drives the real page in headless Chromium: it plays full games against each bot, pass-and-play, a tournament, the stats screen and exports, the bug reporter and several screen widths. This one needs [Playwright](https://playwright.dev) (`npm install -g playwright`, then `npx playwright install chromium`); the tests look for it in the global npm folder, or in the folder named by the `PLAYWRIGHT_PATH` environment variable.

Two more scripts are for people preparing a release:

```sh
npm run qa      # a longer browser run from a sub-path, with screenshots in your temp folder
npm run sweep   # checks that nothing private or oversized is in the files that would be published
```

## Simulations

The bots and the rules can be measured without a browser. `npm run sim` plays many bot-versus-bot games and writes a JSON record; `tests/sim-report.mjs` summarises it.

```sh
# 2000 games, Medium Ahab against Medium Whale, with 5% random noise so the two seats are not copies of each other
npm run sim -- --ahab=medium --whale=medium --games=2000 --seed=1 --jitter=5 --out=tests/tmp/medium-v-medium.json

# 500 first-to-three tournaments, Hard against Medium, roles swapping between games
npm run sim -- --mode=tournament --seat0=hard --seat1=medium --games=500 --seed=1 --out=tests/tmp/hard-v-medium.json

node tests/sim-report.mjs tests/tmp/medium-v-medium.json
```

The header of `tests/sim.mjs` lists every option; any rule constant can be changed with `--const.NAME=VALUE`. Output goes to `tests/tmp/`, which is not tracked.

## Project layout

```text
index.html, style.css      the page and its styles
src/engine/                the rules: pure functions on a plain-JSON game state (no DOM, no clock)
src/bots/                  Easy (random), Medium (greedy) and Hard (look-ahead) bots
src/ui/                    the interface: setup page, game screen, stats, bug reporter, analytics
assets/                    runtime art, and manifest.json listing every image
rules/                     the printed rule book (PDF)
tests/                     Node suites, Playwright suites, the simulator and tests/qa (QA run and sweep)
```

The engine never touches the page, so the same code runs in the browser, in the Node tests and in the simulator. Hard-bot moves are worked out in a Web Worker so the page stays responsive.

## Credits

Game design: Dean Morris, Wombat Game Factory. Prototype art.
