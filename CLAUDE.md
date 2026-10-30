# CLAUDE.md

Working context for Claude Code and other agents in this repository.

## Orientation

PVhub is a browser-based preliminary design tool for utility-scale PV. Read
[README.md](./README.md) for what it does and how to run it, and
[pvhub-how-it-works.md](./pvhub-how-it-works.md) for the engineering model — especially
the layout generator, which is the most intricate part. This file covers only what those
two do not: how to work on the code without breaking it.

```
src/App.jsx            the shell and most of the application — ~6,300 lines
src/ui.jsx             shared atoms: palette C, formatters, Num/Sel/Section/Working/Page,
                       and Rows — the table-or-cards primitive the phone layout rests on
src/cableData.js       IEC reference tables and the adiabatic k physics — data, no React
src/CableTools.jsx     the four Cables tabs (DC, AC, MV, short circuit)
src/CableRefTables.jsx the reference-table display layer — RefCard, the three
                       highlight states, the factor chain
src/pvgis.js           the three outbound data pulls — ERA5, PVGIS TMY, PVGIS PVcalc
src/pvsystFiles.js     .PAN / .OND readers — the authoritative component input
src/YieldReport.jsx    Yield report tab: pulled data, expected generation, pitch trade-off
src/roofGeom.js        roof polygon maths, the plane fit and the module auto-fill — no React
src/dxf.js             DXF R12 writer — string assembly, no React, no dependencies
src/dxfRead.js         DXF reader: polylines, lines with stitching, layers — no React
src/layoutDxf.js       trench occupancy from routed cable, and the layout DXF — no React
src/RoofDesigner.jsx   Roof designer tab: plan editor, auto-generate, DXF export
src/costing.js         the quote library, LCOE, NPV and IRR — no React, no prices in it
src/CostingTool.jsx    Costing tab: quote library, ageing, escalation, LCOE, comparison
src/bess.js            battery capacity chain and the 8,760-hour dispatch — no React
src/BessTool.jsx       Battery tab: capacity chain, dispatch, sweep, the walkthrough
src/batchAnalyser.js   PVsyst batch CSV parsing and tilt/pitch analysis, no React
src/pvsystBatch.js     writes the batch PARAMETER csv PVsyst reads — the other half of it
src/BatchAnalyser.jsx  Batch analyser tab: six hand-rolled charts, recommendation, exports
src/pvsystReport.js    PVsyst simulation-report PDF reader — text in, project record out
src/ProjectTracker.jsx Tracker tab: drop reports in, compare yields and loss diagrams
src/trackerStore.js    where tracked projects live: a file on disk, or browser storage
src/pdfText.js         pdf.js plumbing: worker setup and text extraction, shared
src/main.jsx           mount + boot-overlay teardown
src/pdfWorkerText.js   pdf.js worker, inlined as a string (1.3 MB, generated — never hand-edit)
scripts/genPdfWorker.mjs regenerates the above from the installed pdfjs-dist
index.html             Vite entry shell
vite.config.js         base:"./" so the build works from a subpath on Pages
.github/workflows/     builds and publishes to Pages on push to main
pvhub-how-it-works.md  engineering documentation
GAPS.md                known gaps and risks
```

Build: `npm install`, then `npm run dev` (hot reload) or `npm run build` (into `dist/`).

## The one thing to know before editing

**Almost everything is in `src/App.jsx`.** The layout generator, the yield simulation, the
PDF datasheet parser, all the styling and most of the components. The cable tools are the
exception — they live in `src/CableTools.jsx`, `src/CableRefTables.jsx` and
`src/cableData.js`, and they import their
UI atoms from `src/ui.jsx` rather than from App.jsx, because importing App.jsx back into a
tool it renders is a cycle. If you extract anything else, take the same route: move the
shared piece into `ui.jsx` first, then import it from both sides.

App.jsx is readable and well-commented, but it is still one large file, so:

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

**Workspaces.** The landing asks which tool you came for before anything else, because that
decides how much of the application is relevant. `WORKSPACES` in `src/App.jsx` defines them
and `switchWorkspace` moves between them. They are presented through `LANDING_GROUPS`, three
sections — **Plant design**, **Sizing tools**, **Costing** — because eight cards in one row
read as a wall rather than a menu. Each card names its tools when closed, so the hover only
adds the description rather than hiding anything; it opens on hover on a mouse and on tap on
a touch screen, and `landNarrow` switches the panel between an absolute dropdown and an
in-flow accordion. A section holding exactly one tool and nothing planned skips the
disclosure and enters that tool directly, because a menu of one is a click for nothing.
Adding a workspace means adding it to a group as well, or it is unreachable.

| Workspace | Tabs |
|---|---|
| `prelim` | the whole thing — then asks mount type and detail level |
| `layout` | `layout` alone; the generator already carries every input it needs |
| `cable` | `cdc`, `cac`, `cmv`, `csc` |
| `string` | `module`, `inverter`, `string`, `clip` |
| `yield` | `shade`, `report`, `batch` |
| `cost` | `cost` alone |
| `bess` | `bess` alone |
| `track` | `track` alone; reads exported PVsyst report PDFs |

They are **one app with one state tree**, not separate apps — a value typed in any workspace
is still there in the others. Do not fork them; duplicated inputs would drift apart within a
week. Mount type and detail level are prelim-only concepts and the header hides those
controls elsewhere (`isPrelim`).

Standalone tools take a `standalone` prop where they would otherwise import from a tab that
is not on screen. The cable DC and AC tabs use it to swap the `Imported` link table for plain
`Num` inputs writing to the *same* override state, so a project started standalone opens
correctly in the preliminary tool.

**Healthy baseline:** boot overlay clears, `pageerror` count is 0, and in the `prelim`
workspace five tab groups render. The set depends on the mount type picked on the landing
screen:

- **Ground** — `Technologies` (module, inverter, frame), `Calculations` (string, clip),
  `Layout`, `Cables` (cdc, cac, cmv, csc), `Yield & Summary` (shade, report, batch, bess,
  summary).
- **Roof** — the same, but `Roof` (roof) replaces `Layout`, `Cables` loses `cmv`, and
  `Yield & Summary` loses `batch`.

`GROUPS_GROUND` / `GROUPS_ROOF` in `src/App.jsx` map the tools onto those groups, and
Stupid mode filters to Layout (or Roof) + Yield & Summary. Check **every workspace** when
touching the shell, not just both mounts — `landOn` exists because changing either mount or
workspace can otherwise strand the user on a tool the new set does not contain.

Check the phone path too, because it is a separate layout rather than the same one
narrowed: at an iPhone viewport `document.documentElement.scrollWidth` must equal
`clientWidth` on every tab (a wide table scrolls inside its own box, never the document),
the Layout tool lands on the map with an `☰ Inputs` button rather than on a split screen,
and a two-finger pinch on the site canvas must change its `viewBox` width. Drawing is the
case that broke before: four *finger* taps (a tap carries ~10 px of wobble, so simulate it
with a touchmove between down and up) must place four corners, not zero.

Two traps in writing that probe, both of which produce a confident false negative:

- **The canvas pinches on pointer events, not touch events.** `onPointerDown` /
  `ptrsRef` / `pinchRef` are what the gesture runs through, so a probe that dispatches
  `TouchEvent` watches the `viewBox` sit still and reports a dead pinch on working code.
  Send `PointerEvent` with `pointerType: "touch"` and two distinct `pointerId`s.
- **Every tab renders in the DOM at once**, so an unscoped `querySelectorAll` returns
  hidden panes. Filter on `getClientRects().length` or the probe measures a tab nobody
  is looking at — a zero-width element reads as 0 px wide and passes everything.

Sweeping it properly means walking the tab *groups* as well as the sub-tabs; only the
current group's `.pvhub-subtab`s are in the DOM visible, so iterating sub-tabs alone covers
about a fifth of the preliminary workspace. Reaching a workspace at all now means opening
its landing section first, so a probe that clicked a card by name needs updating when the
grouping changes.

**The shell must keep its height.** `.pv-root` carries `height: 100dvh` and the scrollbar
styling, and the root element also needs `pvhub-root`. Put both on **one** `className` — React
keeps only the last of two `className` props and drops the other silently. When `.pv-root` went
missing the shell sized to its own content inside a body with `overflow: hidden`, so any tab
taller than the window had everything below the fold unreachable, with no scrollbar to reach it
either. Short tabs hid it for weeks. Check a long tab at a short window, not just a long window.

A third trap, this one in the application rather than the probe: **a tap fires `focus` and
then `click` as two separate events**, and React re-renders between them. A disclosure that
opened `onFocus` therefore handed the following click a handler that saw it already open and
shut it again — working perfectly under a synthetic `hover()` and not at all on a phone. Put
the toggle on click alone; Enter and Space on a `<button>` fire click, so the keyboard still
works.

The PVsyst readers have a trap worth knowing: the format nests blocks, and a counted
sub-block (`Remarks, Count=7`) closes with `End of Remarks`. Treating any `End of …` line as
a generic pop closes the *enclosing* block early and silently dumps the whole electrical
section onto the root, where the module lookup cannot see it — the file appears to parse and
yields two fields instead of fourteen. `parsePvsystTree` pops only when the closing line
names the block that opened. Files also carry a UTF-8 BOM.

Tests that run without a browser, both dependency-free:

```bash
node tests/batchAnalyser.test.mjs    # 58 assertions against the Solango fixture
node tests/cableTables.test.mjs     # 783 derating values against the source workbook
node tests/bess.test.mjs            # 103 assertions: the capacity chain against the
                                    # workbook, the dispatch against conservation of
                                    # energy, and the meter-file reader
node tests/roof.test.mjs            # 93 assertions: polygon maths, the plane fit both
                                    # ways, the fill, and the DXF structure
node tests/layoutDxf.test.mjs       # 51 assertions: trench occupancy, the layout export,
                                    # and the reader against four producers
node tests/costing.test.mjs         # 79 assertions: the finance against closed forms, and
                                    # the quote handling against the cases that corrupt a
                                    # comparison silently
node tests/pvsystReport.test.mjs    # 188 assertions against three real reports: a fixed-tilt
                                    # roof, a plant of several sub-arrays, and a bifacial
                                    # field quoted in MWp and kVA
node tests/pdfWorker.test.mjs       # 1 assertion: the inlined worker matches pdfjs-dist
node tests/trackerStore.test.mjs    # 26 assertions: which store is chosen at startup, and
                                    # that the interface never misstates where data is
node tests/pvsystBatch.test.mjs     # 169 assertions: the sweep file PVsyst reads, reproduced
                                    # byte for byte against a template PVsyst itself wrote,
                                    # plus the gap-to-pitch and whole-unit DC/AC conversions
```

**The inlined pdf.js worker rots silently.** `src/pdfWorkerText.js` holds the worker source as
a string so the application makes no CDN call, and pdf.js refuses to run a worker whose
version does not match the API. Because every PDF path here is an optional convenience, that
mismatch surfaces as one file that will not read — not as a broken build — which is how a
6.1.200 worker sat against a 6.2.108 API unnoticed. `npm run gen:pdf-worker` regenerates it,
`ensurePdfWorker` throws with that instruction if they diverge, and `tests/pdfWorker.test.mjs`
catches it before a user does. Run it after any `npm install` that moves `pdfjs-dist`.

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
- **Every factor shows the row it was read from.** The sizing tools print the IEC
  tables they used and pick out the cell in green. A value that was interpolated is
  amber on *both* bracketing rows with the result stated separately, because no such
  row exists in the standard and colouring one of them green would be a lie. A value
  extrapolated past where the table stops is purple and labelled as not IEC data
  everywhere it appears. A value entered by hand is blue, and the table row it
  replaced is still shown, struck through, rather than hidden. Do not collapse the
  four states into one.
- **All three installation methods render at once, and trenching is opt-in.** `LvSizing`
  draws a `MethodCard` per method rather than one focused method with a comparison strip.
  `st.multiTrench` gates every trench control and forces `trenches: 1` in `evaluateRow`
  when off, which is the conservative reading. Do not make trenching default — it answers
  a question most runs never ask.
- **Every calculated figure is overridable, and an override never hides what it
  replaced.** `applyOverride` keeps the table value on the bracket as `auto`, so the
  chip carries the old number struck through beneath the new one and the table row
  stays visible struck through. The control is a dropdown (Auto / Enter a value), never a
  bare box whose emptiness silently means automatic. Selecting Auto returns to the table. Do not
  "simplify" this by dropping the auto value — the whole point is that the reader can
  see what was moved away from and how far.
- **Factor overrides belong to an installation method, base-rating overrides to a
  size.** A factor typed for a buried run means nothing to the same cable on a tray,
  so overrides are stored per method. `recommendSize` deliberately strips the base
  override before scanning sizes; leaving it in would rate every candidate the same
  and make the recommendation nonsense.
- **Extrapolated ratings are never presented as standard values.** Where IEC stops
  tabulating, `ratingFor` extends the last two rows in a straight line and then
  subtracts a safety reduction, because real ratings flatten off as skin and
  proximity effects grow, so the straight line over-predicts. The tool says so, names
  the two rows it extended from, and tells the reader to get a manufacturer figure.
- **Cable grouping counts circuits, not cables.** A circuit with m conductors per pole in
  parallel counts as m circuits (IEC 60364-5-52 B.52.18/19 NOTE 3). Own circuits =
  circuits routed together × parallel N. Splitting the run across trenches divides
  that count, because each trench is its own thermal group — but only if they are far
  enough apart to be independent, which the interface says rather than assumes.
- **The two soil-resistivity bases are never mixed.** IEC 60364-5-52 references its factors
  to 2.5 K·m/W, IEC 60502-2 to 1.5. Separate tables, deliberately.
- **Conductor resistance is corrected from 20 °C.** IEC 60228 tabulates R at 20 °C; the
  tools apply α(θ−20) with the operating temperature as an input. Setting it to 20
  reproduces a spreadsheet that uses the table value raw.
- **A PVsyst file beats a datasheet PDF, always.** A `.PAN` or `.OND` is the manufacturer's
  data already named and typed; the PDF path exists only for when no file is available. Do
  not "improve" the scraper at the expense of the file reader.
- **Temperature coefficients are converted, not read.** PAN stores muISC in mA/°C and
  muVocSpec in mV/°C; PVhub works in %/°C. The conversion needs Isc and Voc from the same
  file, so those two fields are marked derived and show their arithmetic.
- **An OND's MPPT range is the tracking range, not the full-power range.** `VMppMin` maps to
  `trackLo`. It is also offered as `fpLo` at low confidence with a note to read the real
  knee off the P-V curve — never silently as the full-power bound, which would widen the
  string minimum and break the `N_min` convention above.
- **PVsyst batch noise is treated as a tie, not a ranking.** Batch results are not smooth; in the
  Solango fixture 22° beats 21° at 10 m, which is not physical. Anything within the tolerance of
  the best case is a tie and the interface says so. Do not present the raw argmax as a winner.
- **"Warning: parameter X did not change" rows are valid and kept.** It means the swept value
  already equalled the base variant's. Dropping them silently would delete a whole pitch from
  the sweep; seven of the Solango file's 35 rows are in that state.
- **An edge-of-range optimum is reported as not bracketed.** If the best case sits on the
  boundary of the sweep, the honest answer is to extend the sweep, not to call the edge an
  optimum. The tool suggests the next three steps.
- **Absolute yield is PVGIS's, differences between pitches are ours.** No public API takes a
  pitch, so the report scales a PVGIS PVcalc baseline by a row-geometry ratio. The ratios
  survive a change of irradiance dataset; the absolute does not. Never present the two as
  having the same standing.
- **The pitch trade-off always charges for the space.** Widening a pitch adds yield, so a
  model that costs nothing for the extra ground answers "wider" for ever. Cable, land and
  array capex are all in the net figure, and which of capacity or site is held fixed is an
  explicit choice, not an assumption.
- **Frames are never rotated to follow a boundary** — alignment is done by staggering frame
  ends, so tracking geometry and yield are preserved.
- **A capacity requirement and a load-following question are never conflated.** "35 MW for
  5 hours" is arithmetic — the derate chain and a unit count, no weather involved. "How big
  a battery is worth buying" is an 8,760-hour simulation, because the answer depends on
  when the sun shines against when the load runs. `src/bess.js` keeps both and the tab
  makes you choose which you are asking. Do not let one answer stand in for the other.
- **The battery derate chain divides by √RTE, not RTE.** The round trip covers a charge and
  a discharge; only the discharge half stands between stored energy and the meter, and the
  even split is the usual convention. The dispatch uses the same √RTE each way, so the two
  halves of the file agree. A supplier quoting a one-way figure should have it entered as
  RTE², which the interface says.
- **Depth of discharge is the easiest thing to double-count.** A container quoted in
  *usable* kWh already has DoD in the number and the input belongs at 100. The interface
  says so because getting it wrong moves the plant size by a fifth in either direction and
  nothing downstream catches it.
- **The battery sweep reports the knee, never the maximum.** Self-sufficiency against size
  saturates, so the largest size swept always scores highest and reporting it is useless
  advice. The knee is the last size whose marginal gain is still a stated fraction of the
  first increment's, that fraction is an input, and a curve still climbing at the top of the
  range is reported as not bracketed — the same convention the batch analyser uses.
- **`offsetPolygon` is negative-inward, and a deep inset is degenerate.** The mitre inverts
  once past the point where the shape closes and inverts *again* past that, coming back to a
  valid winding with a plausible area that is nowhere near the requested distance from the
  original edges. Winding and area checks miss that second case; the distance test
  (`distanceToBoundary` ≥ |d| for every output vertex) catches all of them. Do not remove it.
- **Touching is not crossing.** `polysCross` uses a *proper* crossing test. A module laid
  flush against the setback line shares an edge with it, and treating that as a collision
  rejects the entire perimeter ring of every roof — which reads as "a module that would not
  fit" rather than as the bug it is. `segmentsCross` stays inclusive for the general API;
  containment and keep-out tests use the strict one, and `polysOverlap` compares centroids
  rather than vertices for the same reason.
- **The module grid phase is arbitrary, so it is swept, not trusted.** Where the grid starts
  changes the count: a 50 mm shift wins or loses a whole column. `autoFill` at one phase is a
  valid answer, not the answer; `bestFill` tries both orientations at thirty-six offsets and
  that is what the designer shows. A test asserting an exact count from a single `autoFill`
  is asserting the phase, not the geometry.
- **The roof tool is an area check, not a layout.** It assumes one clear rectangle per plane
  and spreads obstructions as a percentage, and it says so. Do not present its count as a
  layout; a real roof layout is a separate tool that does not exist yet (GAPS §G24).
- **Flush and tilted are different geometries, not a preference.** Flush takes the roof's own
  pitch and azimuth and needs no row spacing, because one plane cannot shade itself. Tilted
  sets the module angle independently and must pay for it in row pitch —
  `p = l·cos β + l·sin β / tan α` at the stated limit elevation. Tilting above a roof already
  at 15° or more is flagged, because it needs a structural reason rather than a yield one.
- **A roof plane is never averaged with another.** East and west faces are two generators
  sharing an inverter; averaging them to one tilt and azimuth loses the fact that they peak
  at different times, which is what changes both the inverter sizing and the battery case.
- **The load source is always stated.** `parseLoadCsv` works out the delimiter by consistency
  across rows (not by first match — a semicolon file with decimal commas splits happily on
  the comma and comes out tenfold), the header, the reading column and whether it holds kW or
  kWh, and reports every one of those decisions. Reading half-hourly kW as kWh doubles the
  year. Do not make any of it silent.
- **`DAY_SHAPES` are normalised to sum to exactly 1 at module load.** `loadProfile` rescales
  the whole year and would not notice otherwise, but the daily-CSV branch multiplies straight
  through, and a shape summing to 0.954 lost 4.6% of the year there.
- **Pitch and node heights are one piece of information, driven either way.** `fitPlane`
  reads the pitch and azimuth off the nodes; `heightsFromPitch` moves the nodes to match a
  stated pitch about an anchor. Neither is the master and the interface says which way it
  last went. Dragging a node in plan re-reads its height off the current plane, so it stays
  on the roof instead of hanging in the air.
- **A non-planar outline is reported, not silently averaged.** Four nodes that do not lie on
  one plane usually mean a hip or a valley caught in one outline, or a typo. The best-fit
  plane is used and the worst residual is shown in millimetres, because a few millimetres of
  survey noise is fine and 300 mm is two roof faces drawn as one.
- **The DXF goes out in 3D, on named layers.** Every module corner carries the plane's height
  at that point — a flat export would throw away the one thing worth exporting. R12 (AC1009)
  because every reader opens it. A DXF carries geometry, layers and text; it does not carry
  module electrical data, string assignments or yield, and the interface says so.
- **Cable grouping is measured off the layout, not remembered.** `analyseTrenches` counts how
  many routed runs share each stretch of trench and reports the busiest, which is what the
  grouping factor must be looked up on. Segments are keyed on *rounded* endpoints and
  order-independently — a millimetre of drift between two geometrically identical routes would
  otherwise read as two trenches carrying one circuit each, and a route is counted once per
  segment even if it doubles back.
- **The maximum sizes the cable; the distribution costs it.** Both are reported. One short
  segment carrying forty circuits is a different problem from half the route carrying forty:
  the first is solved by splitting that segment. Where under a tenth of the route is at the
  maximum the interface says so rather than letting the whole run be sized for it.
- **Trench length is the union of segments, not the sum of route lengths.** Shared trench is
  counted once. `routeLengths` gives cable metres and `analyseTrenches` gives trench metres;
  they differ by the sharing and neither is wrong.
- **There are two DXF readers and that is deliberate.** `parseDxf` in `App.jsx` serves the
  boundary-and-terrain import, where the Y-flip (CAD is Y-up, screen Y-down) and the shared
  geo origin that keeps 6-figure UTM out of the SVG maths both matter. `src/dxfRead.js` is the
  general reader used for cable-route analysis, where neither applies. Do not route the
  boundary import through the general one — it has no idea about either.
- **The costing tool ships with no prices in it, and that is a refusal rather than a gap.**
  Module prices, EPC rates and connection charges move faster than any embedded figure stays
  true, and a plausible default gets used — it ends up in a board paper with nobody
  remembering where it came from. `REGIONS` carries climate-driven physical bands, structural
  notes and a cost-of-capital band, and no money at all. Do not add a default price to it.
- **A quote's pricing date is a property, not a footnote.** `stalenessOf` reports it
  everywhere a quote is used, with the thresholds stated (six months current, eighteen
  ageing) because they are a judgement rather than a standard. A quote with no date reads as
  "unknown", never as fresh.
- **Escalation never overwrites.** `escalate` returns a copy carrying `escalatedFrom` with the
  original lines, date, rate and factor, so the interface shows the quoted figure struck
  through beside the indexed one — the same convention as an overridden derating factor. An
  indexed price is an assumption and must stay distinguishable from one somebody gave you.
- **Regional indices are derived from two real quotes, never assumed.** `deriveIndices`
  divides one of your quotes by another, per line, and reports which lines only one of them
  carries rather than treating a zero as a price. It also reports a currency mismatch, because
  a ratio across currencies includes the exchange rate and is not a cost index.
- **Lump sums do not scale per watt.** A substation priced at 5 MW neither costs the same at
  100 MW nor twenty times as much. `quoteAt` offers as-quoted, linear and a power law
  (default exponent 0.7), reports which was applied per line, and the choice is the user's.
- **Currency is never converted.** There is no exchange rate in the tool. Quotes in different
  currencies sit side by side, and `compareQuotes` says they are not comparable on money
  rather than quietly applying a rate that would be stale by the time it is read.
- **A dense table becomes cards on a phone, it does not gain a scrollbar.** `Rows` in
  `src/ui.jsx` renders a `<table>` above 760 px and one card per row below it, from one
  column definition, so the two cannot drift. A twelve-column table does not become usable
  at 390 px by scrolling sideways — the costing quote table cut off at Region, which put
  the pricing date and its age, the entire point of that tool, off-screen. Use `Rows` for
  anything wider than about six columns rather than wrapping it in a scroller.
- **The font floor is applied at source, never as a CSS rule.** The obvious rule,
  `font-size: max(1em, 11px)` on every descendant, does not work twice over: `1em`
  resolves against the *parent*, so a 9 px caption inside a 14 px panel comes out at 14 px
  rather than 11, and an inline `font:` shorthand beats the rule anyway. Nothing in `src/`
  declares below 10.5 px; keep it that way rather than reintroducing a blanket floor.
  `<sub>` and SVG `<text>` legitimately measure smaller — a subscript is a subscript, and
  SVG text scales with its `viewBox`, which is what pinch zoom is for.
- **A checkbox is hit by its label.** The box stays a box; `label:has(> input[type=
  "checkbox"])` carries the 38 px minimum height. Growing the box instead gives a 38 px
  checkbox, which looks broken and still misses the text beside it.
- **A PVsyst report is read generically where it varies, strictly where it does not.**
  `parsePvsystReport` reads the monthly balance table off its own header row, because the
  column set changes with the system type — a self-consumption run carries `EFrGrid` columns
  a grid-feed run does not, and reading `E_Grid` from a fixed slot reports such a plant as
  generating nothing. The loss diagram is read the same way: any signed-percentage row
  becomes an entry under PVsyst's own wording, so a row this reader has never seen is
  captured rather than dropped.
- **The loss diagram is read from the loss-diagram page only, and only signed rows.** The
  array-loss *parameters* page carries lines of the identical shape — "Loss Fraction 2.00 %
  at STC" — and an unscoped scan turned those into loss rows called "at STC" and "at MPP".
  The module efficiency ("efficiency at STC = 23.03% PV conversion") sits on the diagram page
  itself and arrived as a +23% gain until the reader required an explicit `+`/`-` or a zero.
  Both would then have appeared as columns in every comparison.
- **Fields whose column cannot be identified are not read at all.** The soiling, LID, quality
  and mismatch fractions share one line in a three-column block, and flattened PDF text has
  lost which is which — taking the first match returned the 0.10% strings mismatch as the
  soiling loss. They are deliberately absent from the record, because the loss diagram
  carries the realised value of each of them correctly and one right number beats two
  plausible ones.
- **Power is normalised to kW, but kVA stays kVA.** A roof prints "Pnom total 600 kWp"; a
  78 MW field prints "77.75 MWp" and its inverters "52480 kVA", because the limit there is
  apparent power. `scalePower` normalises the scale so the numbers are comparable, and the
  unit *kind* is kept — relabelling kVA as kWac would quietly equate two different
  quantities. A kWp-only pattern read the MW plant as nothing at all.
- **The DC/AC ratio is derived, never scraped.** "Pnom ratio" is printed against three
  different things and the label does not say which: the inverters, the *grid* limit
  ("Grid lim. Pnom ratio 1.558" on a curtailed plant whose DC:AC is 1.48), and once per
  sub-array ("1.70" for the first block of a plant whose whole-site figure is 1.69). Every
  pattern picks a different wrong answer on some report. It is computed from the plant's own
  DC and AC capacities, shows the arithmetic in `src`, and warns when a stated value
  disagrees.
- **Several sub-arrays mean several "Modules N x M In series" lines.** Taking the first
  describes one sub-array as the whole plant — 390 × 27 = 10,530 against a stated 11,300.
  Strings are summed across the blocks; the string length is reported only when every block
  agrees, and otherwise withheld with the differing lengths named, because no single figure
  exists.
- **A PDF with no text is a different failure from a PDF of the wrong kind.** Windows
  "Print to PDF" rasterises the whole document — nine pages, one image each, not a character
  of text. No pattern-widening reads that, so it is detected before parsing and the message
  names the cause and the fix (re-export from PVsyst). There is no OCR here (GAPS §G37).
- **The same report imported twice is skipped; a re-run is kept.** `isSameRun` compares
  project, variant *and* simulation timestamp. Identical on all three is the file arriving
  again and there is nothing to learn from a second copy. A different timestamp is a re-run
  of that variant, and the change between the two is usually the point — `dedupeAgainst`
  keeps those and `findDuplicates` flags them.
- **PVsyst is driven by a parameter file, never by a generated variant.** A `.VCx` is plain
  text and its definition is only ~600 lines of the 24,000 (the rest is base-36 hourly
  results), so writing one looks tempting. It is not: the format is undocumented, every
  object is stamped `Version=8.1.4`, the `Flags=$...` are opaque bitfields, and the file
  holds `pvShdFTable` shading factor tables that PVsyst *derives* from the 3D scene — write
  a scene without regenerating those and it may simulate something other than what was
  drawn, silently. Batch mode is a documented feature driving a variant a human built.
  `src/pvsystBatch.js` writes the sweep, `src/batchAnalyser.js` reads the results back.
- **Batch column headings are copied verbatim from files PVsyst wrote, never tidied.**
  PVsyst's own template says *"Do not modify the column titles!"*, so the catalogue carries
  `azim` not `azimuth`, `in parall` not `in parallel`, `*.OND File` with its asterisk. Seven
  are confirmed against real files: `Plane/tilt`, `Plane/azim`, `Sheds 3D/pitch`,
  `Nb module/in series`, `Nb strings/in parall`, `Nb inverter/or MPPT`,
  `Inverter/*.OND File`. A heading that is close but not exact is worse than none, because
  PVsyst accepts the file and silently runs the base case — the "Warning: parameter X did
  not change" rows the analyser already has to keep. `tests/pvsystBatch.test.mjs` asserts
  every shipped heading appears in a fixture PVsyst produced, so the catalogue cannot drift
  into guesswork.
- **The delimiter differs by direction and is a setting, not a constant.** The parameter
  template PVsyst *generates* is comma separated; the results file it *writes back* is
  semicolon separated — both from the same user on the same product. The writer defaults to
  the comma, since the file it produces is the one PVsyst reads, and `parseBatchParamsCsv`
  detects the delimiter from the header row rather than the whole file, because the preamble
  prose contains commas of its own.
- **The written parameter file reproduces PVsyst's template byte for byte**, preamble notes
  and all, including the literal quotes in `Only the lines beginning by "SIM_" will be
  executed` (written raw, never escaped into `""` pairs) and the three blank rows before the
  footer. That exact-reproduction test is the strongest check available without PVsyst
  itself: it covers the delimiter, every header row, the spacing and the CRLF endings at
  once.
- **The batch file PVhub writes is pure ASCII.** PVsyst reads these as Windows-1252, so an
  em dash or a curly quote arrives as mojibake. The degree and squared signs in PVsyst's own
  files appear only in *result* column units, which a parameter file does not carry, so
  there is no encoding to get wrong — provided nothing non-ASCII is written. A test asserts
  it.
- **Row spacing is specified as the clear gap, and the pitch is derived.** A site walk and a
  mounting supplier talk about the daylight between rows (2.5 to 5 m in 0.5 m steps is the
  working range here); PVsyst wants the pitch, axis to axis. They differ by the collector's
  horizontal projection, so `pitch = gap + L·cos(tilt)` — which means **the pitch is not a
  value list**, it depends on the tilt of the case it sits in, and sweeping tilt and gap
  together gives a different pitch on every row. A steeper tilt gives a *shorter* pitch for
  the same gap; getting that backwards widens rows as they steepen. A tracker has no fixed
  gap, because the panels rotate, so there the pitch is swept directly.
- **DC/AC is stepped in whole units, never as a ratio.** Neither a string nor an inverter
  divides, so stepping a target ratio and rounding manufactures values the plant cannot
  build and runs the same case twice under two labels. What is stepped is whichever whole
  thing is free to move: **AC fixed** (the grid connection sets the export) steps the
  strings and the ratio climbs evenly; **DC fixed** (the site or layout sets the array)
  steps the inverters and the ratio falls in much bigger jumps. `unitRangeForBand` suggests
  the integer range covering a band so the user does not have to solve it, and the sweep
  reports the increment each step actually produces — on a four-inverter plant a string
  moves the ratio 0.05 and an inverter moves it 0.16.
- **The DC/AC bands are the user's working numbers, not a standard.** Fixed tilt 1.10–1.40,
  tracker 1.05–1.30, east-west 1.10–1.60. The ordering is physical and a test asserts it: a
  tracker's flatter profile puts more hours near the inverter limit so it clips sooner and
  carries *less* DC than fixed tilt, while an east-west pair shares one inverter between
  faces that peak apart and carries *more*.
- **PVsyst's scene is a regular field, so the capacity is PVhub's and the specific yield is
  PVsyst's.** A layout fitted to a real boundary will not have the module count of an N x M
  grid. Take kWh/kWp and PR from the simulation and multiply by the capacity the layout
  actually achieved — the same standing rule as the PVGIS baseline above: the ratio survives
  the geometry simplification, the absolute does not.
- **A tracked field that was not found is listed as missing, never shown as zero.** Across a
  comparison table a silent zero moves every average taken down the column. `fieldSpread`
  excludes absent records and reports how many it excluded; `lossMatrix` returns `null`, not
  `0`, for a row a report does not have.
- **Re-importing a report adds a record, it never overwrites one.** Two runs of the same
  project and variant are flagged as duplicates and left alone, because the difference
  between them is usually the thing worth seeing.
- **The tracker's records belong in a file the user chose, not in the browser.** This
  application is served from a public origin, and `localStorage` there is plain text readable
  by anything on that origin and by anyone with the machine. `src/trackerStore.js` writes to a
  file picked through the File System Access API and clears the browser copy when it does.
  Firefox and Safari have no such API; there it falls back to `localStorage` and
  `describeStore` says which store is in use — never the stronger guarantee than is true.
  Only the file *handle* is kept in IndexedDB, so the file can be reconnected; it carries no
  records, and failing to store it costs reconnection, not the session.
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
