# CLAUDE.md

Working context for Claude Code and other agents in this repository.

## Orientation

PVhub is a browser-based preliminary design tool for utility-scale PV. Read
[README.md](./README.md) for what it does and how to run it, and
[pvhub-how-it-works.md](./pvhub-how-it-works.md) for the engineering model — especially
the layout generator, which is the most intricate part. This file covers only what those
two do not: how to work on the code without breaking it.

```
src/App.jsx            the entire application — 6,300 lines, 84 top-level functions
src/main.jsx           mount + boot-overlay teardown
src/pdfWorkerText.js   pdf.js worker, inlined as a string (1.3 MB, generated — never hand-edit)
index.html             Vite entry shell
vite.config.js         base:"./" so the build works from a subpath on Pages
.github/workflows/     builds and publishes to Pages on push to main
pvhub-how-it-works.md  engineering documentation
GAPS.md                known gaps and risks
```

Build: `npm install`, then `npm run dev` (hot reload) or `npm run build` (into `dist/`).

## The one thing to know before editing

**Everything is in `src/App.jsx`.** Seven tools, the layout generator, the yield
simulation, the PDF datasheet parser, all the styling and all the components. It is
readable and well-commented, but it is one file, so:

- Search by function name — they are real names (`simulatePitch`, `buildEnv`, `skyVF`,
  `parseTmy`, `frameGeom`), not minified.
- Section codes (`1A`, `2D`, `07`) appear in both the UI and the source and are the
  fastest way to locate a specific input group.
- Assume nothing is module-scoped. Check for collisions before adding a top-level name.

**History note:** the repository previously tracked only a stale single-file build with no
source. That is resolved — this tree is the source, and the build is generated. Do not
commit build output (`dist/`, `pvhub.html`) as if it were source.

## Verifying a change

There is **no test suite** (GAPS §G2). The checks that exist:

```bash
npm run build     # catches syntax and import errors — the cheapest real gate
```

Then a headless load, which is the only functional regression check available:

```js
import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage();
p.on('pageerror', e => console.log('PAGEERROR:', e.message));
await p.goto('http://127.0.0.1:8000/', { waitUntil: 'networkidle' });
console.log(await p.$$eval('.pvhub-tab', ns => ns.map(n => n.textContent.trim())));
await b.close();
```

Chromium and Playwright are available (`executablePath: '/opt/pw-browsers/chromium'`;
never run `playwright install`). Serve over `http://` — `file://` blocks the outbound API
calls.

**Healthy baseline:** boot overlay clears, `pageerror` count is 0, and four tab groups
render — `Technologies` (module, inverter, frame), `Calculations` (string, clip), `Layout`,
`Yield & Summary` (shade, summary). The seven tools still exist; `GROUPS` in `src/App.jsx`
maps them onto the four tabs, and Stupid mode filters to Layout + Yield & Summary.

**Known pre-existing noise:** ~270 console errors of the form
`<line> attribute y1: Expected length, "-Infinity"` fire on load, plus a favicon 404. That
is GAPS §G3 (unguarded `Math.min(...)` over an empty collection), not something you broke.
Filter it out when checking your own work — `pageerror` is the count that matters, and it
should be 0.

## Outbound calls

All optional; the app works offline without them, and each degrades with a visible notice
rather than failing silently.

| Host | Purpose |
|---|---|
| `archive-api.open-meteo.com` / `api.open-meteo.com` | ERA5 daily temperature extremes for string sizing |
| `re.jrc.ec.europa.eu/api/v5_3/tmy` | PVGIS TMY — 8,760 hours of GHI/DNI/DHI/temperature |
| `re.jrc.ec.europa.eu/api/v5_3/PVcalc` | PVGIS validated absolute yield baseline |

Without TMY the pitch model falls back to a clear-sky synthetic year and says so:
*"Using a clear-sky model — geometry is right, absolute yield runs high."* Preserve that
honesty if you touch it — the geometry is trustworthy, the absolute number is not.

## Domain conventions — do not "fix" these

Deliberate engineering decisions, each stated in the UI's own text:

- **Temperature sources are never averaged.** `T_low = MIN(all lows)`,
  `T_high = MAX(all highs)`. Averaging softens exactly the extreme the check exists to catch.
- **`N_max` floors, never rounds.** One more module over-volts the inverter on the coldest morning.
- **`N_min` uses the full-power lower bound from the P-V curve**, not the MPPT tracking
  lower bound on the datasheet front page.
- **`N_rec` trades modules for frame divisibility**, falling back to the electrical maximum
  if the divisible candidate drops below `N_min`.
- **Parallel strings take the lower** of connector limit and MPPT current headroom.
- **Frames are never rotated to follow a boundary** — alignment is done by staggering frame
  ends, so tracking geometry and yield are preserved.
- **British English** (`optimisation`, `paralleling`, `metre`), `lang="en-GB"`. SI units.

If you think one of these is wrong, raise it — they size real equipment.

## House style

Every derived number is explained: numbered badge and title, the formula in monospace,
the substituted values, a pass/fail chip where it is a check, and a short paragraph on
*why the rule exists*. Match that — a bare number with no derivation is out of place here.

Monospace (`--mono`) for numeric readouts and formulas, system sans for labels and prose.
Numbers go through the shared rounding helper with an explicit decimal count. Theme object
`C`/`T` holds the palette; accent is `#e8820c`.

Be careful to distinguish **modelled** figures from **entered** ones in the UI. Several
panes deliberately place a parametric estimate next to a column for real PVsyst results,
because the estimate is for ranking options and the PVsyst figure is for deciding. Do not
blur that line.

## Git workflow

- Write real commit messages. Much of the early history says "Add files via upload"; that
  is not worth imitating.
- Never commit `node_modules/`, `dist/`, or scratch files.
