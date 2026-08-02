# CLAUDE.md

Working context for Claude Code and other agents in this repository. Read this before
touching `index.html`.

## The one thing to understand first

**This repository contains no source code.** `index.html` is a ~360 KB esbuild bundle —
React 19.2.7 plus the entire application, minified, with no source map and no build config.
There is no `package.json`, no `src/`, no test suite, no CI.

So the normal instinct — "find the component, edit the component" — does not apply. Any
change you make is a change to compiled output. Read [GAPS.md](./GAPS.md) §G1 before
proposing structural work, and [OVERVIEW.md](./OVERVIEW.md) for what the app does and how
its engineering model works.

## Repository layout

```
README.md      2 lines
index.html     the entire application (build artifact, 226 lines, ~360 KB)
OVERVIEW.md    product, engineering model, architecture
GAPS.md        gap analysis with severities and suggested order of work
CLAUDE.md      this file
```

## Navigating index.html

The file is 226 lines but two of them are >100 KB. Line-number ranges (approximate, they
shift with edits — re-derive rather than trusting these blindly):

| Lines | Contents |
|-------|----------|
| 1–22 | `<head>`, boot-overlay CSS |
| 23–30 | `<body>`, `#root`, `#boot` overlay markup |
| 31–39 | React + ReactDOM + scheduler, minified. **Do not edit.** Lines 38 and 39 are 133 KB and 100 KB. |
| 40–178 | Application code. Minified identifiers, but CSS template literals, formula strings and UI prose survived intact. |
| 179–224 | Bundled React licence banner |

Useful reconnaissance commands:

```bash
# Where is the weight?
awk '{print NR": "length($0)}' index.html | sort -t: -k2 -rn | head

# Work on the app region in isolation (never commit this)
sed -n '100,178p' index.html > /tmp/app.js

# Find UI strings — these are the reliable handles into minified code
grep -o 'title:"[^"]\{2,60\}"' index.html | sort -u
grep -o 'label:"[^"]\{2,40\}"' index.html | sort -u
grep -o 'formula:"[^"]\{2,90\}"' index.html | sort -u
```

**Search by user-visible string, not by identifier.** Component names are mangled (`Bt`,
`cl`, `je`, `Zi`, `bg`, `xg`, `Mg`); section titles, field labels and formula text are not.
Section codes (`1A`, `1B`, `2D`, `07`) are stable and appear in both the UI and the source.

## Running and verifying

```bash
python3 -m http.server 8000     # serve over http:// — file:// blocks the Open-Meteo fetch
# → http://127.0.0.1:8000/index.html
```

Chromium and Playwright are available in this environment
(`executablePath: '/opt/pw-browsers/chromium'`, `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`;
never run `playwright install`). Since there are no tests, **a headless load is the only
regression check available** — do it after any edit to `index.html`:

```js
import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage();
p.on('pageerror', e => console.log('PAGEERROR:', e.message));
await p.goto('http://127.0.0.1:8000/index.html', { waitUntil: 'networkidle' });
await p.waitForTimeout(1500);
console.log(await p.$$eval('.pvhub-tab', ns => ns.map(n => n.textContent.trim())));
await b.close();
```

**Healthy baseline:** the `#boot` overlay is gone, and exactly seven tabs render:
`1 · Module`, `2 · Inverter`, `3 · Frame`, `4 · String Sizing`, `5 · Paralleling`,
`6 · Pitch & Shading`, `7 · Layout`.

**Known pre-existing noise:** ~250 console errors of the form
`<rect> attribute width: Expected length, "Infinity"` fire on load, plus one 404 for the
missing favicon. Those are GAPS §G3 (empty site polygon → `Math.min(...[])`) and §G11, not
something you broke. Filter them out when checking your own changes — and don't report them
as new. **`pageerror` count should be 0**; that is the signal that actually matters.

To exercise the energy model without hitting the network, intercept the archive call and
serve synthetic daily data:

```js
await page.route('**/v1/archive**', r => r.fulfill({ status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ daily: { time: [...], temperature_2m_max: [...],
    temperature_2m_min: [...], temperature_2m_mean: [...], shortwave_radiation_sum: [...] } }) }));
```

Then: tab 4 → **Get design temperatures** (section `03 · Site location`) → tab 6, where
section `6C` should show a POA figure, a specific yield, and a modelled-runs table.

## Architecture facts that affect how you edit

- **React 19.2.7**, `createRoot`, no JSX at runtime — the bundle contains
  `React.createElement(...)` calls. Match that style; do not introduce JSX into the bundle.
- **All seven tool panes mount at once**, hidden via `display: flex | none`. State survives
  tab switches for free, but every pane computes on every render — including invisible ones.
  This is why G3 fires before the user ever opens the Layout tab.
- **No CSS framework.** Inline `style={{…}}` objects plus per-component template-literal CSS
  strings. The theme object `T` holds the palette: accent `#e8820c`, plus `panel`, `panel2`,
  `line`, `text`, `muted`, `chrome`, `warn`.
- **All drawings are inline SVG.** No `<canvas>` anywhere.
- **Persistence:** component library → `localStorage['pvhub.library.v1']`. Projects →
  downloaded files `pvhub-project.json` and `pvhub-component-library.json`. Tools expose
  state through a shared ref with a per-tool `{ get, set }` handle.
- **One network call:** Open-Meteo ERA5 archive (`archive-api.open-meteo.com` primary,
  `api.open-meteo.com` fallback), no API key. Everything else works offline. It returns
  temperature *and* `shortwave_radiation_sum`; the monthly aggregate lands in `loc.clim`
  (`ghiDaily`, `ghiHi`, `tMon`, `ghiAnnual`), which is App-level state shared by the
  string-sizing tool (fetches) and the shading tool (models).
- **`pvYield(cfg)`** is the energy model — a pure function sitting immediately before the
  shading component. Erbs diffuse split, Collares-Pereira–Rabl intra-day distribution,
  isotropic transposition, profile-angle row shading, pvlib-style backtracking, NOCT cell
  temperature, AC clipping. It touches no React state, so it can be lifted out and tested
  in isolation the moment there is somewhere to put a test. See OVERVIEW §2 for the chain
  and GAPS §G15 for what is not sourced.
- **Undo/redo** on Ctrl+Z / Ctrl+Y.

## Domain conventions — do not "fix" these

These look like bugs and are not. Each is a deliberate engineering decision, stated in the
UI's own explanatory text:

- **Temperature sources are never averaged.** `T_low = MIN(all lows)`,
  `T_high = MAX(all highs)`. Averaging would soften exactly the extreme the check exists to
  catch.
- **`N_max` floors, never rounds.** One more module would over-volt the inverter on the
  coldest morning.
- **`N_min` uses the full-power lower bound from the P-V curve**, not the MPPT tracking
  lower bound on the datasheet front page. Below full-power the inverter still tracks but
  cannot deliver rated power.
- **`N_rec` trades modules for frame divisibility** — but falls back to the electrical
  maximum if the divisible candidate would drop below `N_min`.
- **Parallel strings take the lower** of connector limit and MPPT current headroom.
- **British English** (`optimisation`, `paralleling`, `metre`), `lang="en-GB"`. Keep it.
- **SI units** throughout — metres, °C, V, A, Wp/kWp/MWp, kVA.

If you believe one of these is genuinely wrong, raise it rather than silently changing it —
they affect equipment sizing on real projects.

## House style for new calculations

Every derived number in this app is explained. The established pattern, per step:

1. A numbered badge and title
2. The formula, in monospace, symbolic
3. The substituted values and the result
4. A pass/fail status chip where the step is a check
5. A short plain-English paragraph on *why the rule exists* — what goes wrong without it

Match that. A bare number with no derivation is out of place here, and the explanatory
prose is a large part of what the tool is for.

Typography: monospace (`--mono`) for numeric readouts and formulas, system sans for labels
and prose. Numbers go through the shared rounding helper with an explicit decimal count.

## Git workflow

- Development branch for this work: `claude/repo-docs-setup-p12ov7`. Push with
  `git push -u origin <branch>`.
- Write real commit messages. Five of the six existing commits say "Add files via upload"
  (GitHub web upload flow) — that history is not worth imitating.
- **Never commit extracted scratch files** (`/tmp/app.js`, `node_modules/`, screenshots).
  There is no `.gitignore` yet.

## When asked to add a feature

Given the state of the repository, the honest sequencing is usually:

1. Say plainly that the change lands in a bundled artifact and what that costs.
2. For small, contained edits — a label, a threshold, a guard like G3 — editing the bundle
   directly is reasonable. Locate by UI string, make the minimal edit, verify with a
   headless load.
3. For anything structural — a new tool tab, a new calculation module, a React upgrade —
   recommend recovering the source tree first (GAPS §G1). Do not build significant new
   functionality inside the bundle; it compounds the problem the repository already has.

Verify with a headless load either way. It is the only check that exists.
