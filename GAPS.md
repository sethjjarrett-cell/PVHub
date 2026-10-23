# PVhub — Gap Analysis

Assessment of the repository against its own goals. Ordered by how much each finding
constrains future work, not by how hard it is to fix.

Written after the source tree replaced the stale single-file build that the repository had
been tracking. Several findings from the earlier revision of this document were artefacts
of that build being the only thing present, and have been removed rather than restated.

---

## Severity 1 — Structural

### G1. `src/App.jsx` is 6,300 lines and 84 top-level functions

Almost everything is in one file: the layout generator, the yield simulation, the PDF
datasheet parser, the styling, most of the components.

*Partly addressed.* The cable tools were added as separate modules rather than appended:
`src/cableData.js` (reference data and the adiabatic physics, no React), `src/CableTools.jsx`
(the four tabs) and `src/ui.jsx` (the atoms both sides share). That establishes the seam the
recommendation below describes and proves it works — `cableData.js` is pure and importable,
and the verification below was written against it directly. The rest of the file has not
moved. It is genuinely well written — real names,
useful comments, coherent sections — which is the only reason it remains workable at this
size. But it is at the limit.

The practical costs today: no module can be imported in isolation, so nothing can be unit
tested (§G2); two people cannot work on different tools without conflicting; and the
top-level namespace is shared by 84 functions, so every addition risks a collision.

**Recommendation.** Split along the seams the file already has, lowest-risk first:

```
src/calc/     pure engineering functions — no React
              solar geometry (sunVector, eqTime, clearSky, skyVF)
              yield (buildEnv, simulatePitch, pitchSweep, parseTmy)
              strings (N_max, N_min, N_rec, β_Vmp derivation)
              layout (frameGeom, tiling, gradient handling, scoring)
src/tools/    the seven tab components
src/ui/       Field, Section, Select, Readout, WorkedStep, warnings
src/theme.js
```

`src/calc/` is the one that matters. Those functions already take plain arguments and
return plain data — they are pure by construction, just not by packaging. Extracting them
is mostly mechanical and immediately unlocks §G2.

### G2. No tests

There is no test of any kind, and no test runner in `package.json`. For a tool whose entire
value is numerical correctness in an engineering context, this is the most consequential
gap after §G1.

Highest value to pin down first, all of which are pure functions today in everything but
packaging:

1. `simulatePitch` / `pitchSweep` — the yield model. Golden-value tests against a fixed
   TMY fixture, so a refactor cannot silently move the answer.
2. `skyVF` — the sky view factor. Analytically checkable: at `pitch → ∞` it must approach
   `(1 + cos β)/2`.
3. `N_max` / `N_min` / `N_rec` string bounds, including the floor/ceiling behaviour the UI
   explicitly calls out as deliberate.
4. β_Vmp derivation — both routes, and route selection when the datasheet omits it.
5. Temperature extreme adoption — that sources are taken as MIN/MAX and **never averaged**.
6. `parseTmy` — malformed rows, short years, missing columns.
7. Project save → open round-trip fidelity across all seven tools.
8. Layout gradient handling — that a frame breaching a hard limit is always rejected.

Vitest fits the existing Vite setup with essentially no configuration.

---

## Severity 2 — Correctness and trust

### G3. `Math.min(...)` over empty collections yields non-finite SVG geometry

**Verified against the current build.** A fresh page load, before any user interaction,
produces ~270 console errors:

```
Error: <line> attribute y1: Expected length, "-Infinity".
Error: <line> attribute y2: Expected length, "NaN".
Error: <rect> attribute width: Expected length, "Infinity".
```

`Math.min()` with no arguments returns `Infinity` and `Math.max()` returns `-Infinity`, so
any bounds computed by spreading an empty array produce a degenerate viewBox and non-finite
child coordinates. `src/App.jsx` has a dozen such call sites — lines 297–304, 576, 879,
1082–1084, 2560, 2803, 2837 among them — and the layout panes compute before a site
boundary or terrain set exists.

**Impact.** Currently cosmetic: the browser rejects the bad attributes and the app is fully
usable. But it makes the console useless for real debugging, and any future code that
consumes those bounds numerically — a fit-to-screen, an area total, a DXF export — will
produce `NaN` silently instead of throwing.

**Fix.** A small guarded helper, used everywhere bounds are derived:

```js
const minOf = (xs, dflt = 0) => (xs.length ? Math.min(...xs) : dflt);
const maxOf = (xs, dflt = 0) => (xs.length ? Math.max(...xs) : dflt);
```

and an empty-state in the layout panes rather than a degenerate SVG. Worth doing early:
it is contained, and it clears the noise that would otherwise mask a real regression.

### G4. The clear-sky fallback is honest in the UI but easy to miss downstream

Without PVGIS TMY, `buildEnv` synthesises a clear-sky year at a flat 25 °C. The pane says
so plainly — *"Using a clear-sky model — geometry is right, absolute yield runs high"* —
which is the right instinct.

The risk is that the resulting `specYield` is a number like any other: it flows into the
runs table, into the ranked variants, and into a saved project file, none of which carry
the caveat with them. A project opened six months later cannot tell whether its pitch was
chosen against real weather or a synthetic year.

**Recommendation.** Tag the provenance onto the data, not just the pane — record
`source: "tmy" | "clearsky"` alongside every modelled yield, persist it in the project
file, and show it in the runs table and on any variant that was ranked using it.

### G5. Two independent weather sources, no cross-check

Temperature extremes come from Open-Meteo ERA5; the yield model's temperatures come from
PVGIS TMY. They are different datasets, different reference periods, and different
locations on the grid. Nothing compares them.

If ERA5 says the site reaches 42 °C and the TMY peaks at 33 °C, that is worth surfacing —
it usually means the TMY is not representative of the site, which matters for the
temperature derate. Cheap to check, and the app already holds both.

### G6. No schema version on saved projects

`pvhub-project.json` carries no version field, and the per-tool `{ get, set }` contract
merges whatever keys it finds. An older file opened against a newer build half-applies
silently: recognised keys load, new fields keep defaults, removed fields are ignored, and
the user gets a plausible design that is not the one they saved.

**Recommendation.** Add `schemaVersion`, validate on open, and refuse-with-explanation or
migrate on mismatch. For an engineering tool this is a correctness issue.

### G7. README is behind the code

The README states *"The Pitch & Shading tab does not simulate. It compares PVsyst runs you
enter."* That was true when it was written; the tab now runs a full 8,760-hour simulation
with PVGIS TMY. The caveats section is the most safety-relevant part of the README, so it
is the worst part to have drift.

---

## Severity 3 — Provenance and process

### G8. No engineering provenance for the assumptions

The tool encodes real design decisions — the ±margin defaults, the mounting-dependent
temperature rise presets, the road-width presets, `bifaciality: 0.8`, `kRear: 0.9`,
`bos: 12`, `mismatch: 2`, `albedo: 0.2`, the NOCT fallback of 45 °C. None cites a standard,
a project convention, or a date.

This matters because the output sizes real equipment, and a reviewer cannot tell whether a
default came from IEC 62548, a manufacturer guideline, or a rule of thumb. The same applies
to the model's methods: the clear-sky model, the backtracking formulation, the NOCT cell
temperature model, and the two-dimensional sky view factor all deserve a citation.

**Recommendation.** A `docs/assumptions.md` mapping each default and each method to its
source, with a review date. This is the highest-value document the project does not have.

### G9. No licence

No `LICENSE` file and no copyright statement, so the default is "all rights reserved" —
anyone who forks or contributes has no defined terms. React ships its own MIT banner inside
the build, which covers React only.

### G10. React 18 while the ecosystem has moved

`package.json` pins `react@^18.3.1`. Not urgent and nothing is broken, but worth planning
rather than discovering during an unrelated change.

### G11. No linter, formatter, or CI check beyond the deploy

`.github/workflows/deploy.yml` builds and publishes, which means a syntax error is caught —
but only at deploy time, and nothing checks style, unused variables, or accidental globals
in a 6,300-line file where those are easy to introduce.

**Recommendation.** ESLint with `eslint-plugin-react-hooks`, run in CI on pull requests.
The hooks rule is the valuable one here, given how much `useMemo` dependency management the
file does by hand.

---

### G15. Cable sizing and the layout do not talk to each other

The MV tab sizes ring runs from route distances typed in by hand, while the layout generator
already computes cable routes for exactly those runs and reports their lengths. Nothing
carries one into the other, so the cable schedule can silently describe a different plant
from the layout beside it.

**Recommendation.** Feed `planCabling`'s segments into the MV runs table as a starting set,
the way `onAdopt` already carries a string length from string sizing into the electrical
config. The layout knows the inverter count per run too, which is the other column being
typed by hand.

### G16. MV ratings above 400 mm² are extrapolated

IEC 60502-2 Table B.3 stops at 400 mm². The 500 and 630 mm² rows extend the 300–400 gradient
linearly and subtract a safety reduction. Real ratings flatten off above 400 mm² as skin and
proximity effects grow, so the straight line over-predicts and the reduction only partly
offsets it. The rows are flagged in the table and in a warning, which is the right handling
for a preliminary tool, but they are a placeholder for a manufacturer rating and not a
standard value.

### G17. The short-circuit check claims no non-adiabatic credit

IEC 60949 permits a non-adiabatic uplift for screens and for durations past about a second,
which can be worth a size on a screen. Not claiming it is safe, and stated in the interface,
but it means the screen result is pessimistic rather than accurate. Electrodynamic force on
cleats and supports is not computed either; the peak current is reported so it can be, but
the calculation itself is absent.

### G18. The pitch trade-off scales cable rather than re-routing it

The yield report anchors on the cable length the layout actually routed at the pitch in use, then
scales every other pitch by a law — with capacity on a fixed site, as √area at fixed capacity. The
honest answer is to re-run the layout generator at each pitch and route the cable for real, which
the generator is already capable of; it is a question of cost, not capability, since a sweep of
nine pitches is nine full generations.

**Recommendation.** Run the generator across the sweep in a worker, or on demand behind a button,
and replace the scaling law with routed figures. The scaling law can stay as the instant answer.

### G19. Outbound calls outside src/pvgis.js still have no timeout

`src/pvgis.js` bounds every request, because a proxy that accepts a connection and then says
nothing leaves the UI spinning for ever. The older fetches inside `ShadeTab` and the string-sizing
temperature pull do not, and they are the same class of bug.

**Recommendation.** Move those two onto `fetchTmy` / `fetchEra5` from `src/pvgis.js`. They already
duplicate the logic, so this removes code as well as fixing the hang.

### G20. The .OND reader is unverified against a real inverter file

`src/pvsystFiles.js` parses both PVsyst component formats. The `.PAN` side is verified against
a real Suntech file, value by value, including the two unit conversions. The `.OND` side was
written from the documented structure and exercised only against a file constructed for the
purpose, so key names that differ between PVsyst versions or manufacturers would come through
empty rather than wrong — the parser takes only what it recognises.

**Recommendation.** Run two or three real `.OND` files through it and widen the key aliases
where they miss. `PMaxOUT` versus `PNomConv` for the AC rating, and whether a per-MPPT current
is stated at all, are the fields most likely to vary.

### G21. Extrapolated cable ratings over-predict, and the safety reduction is a guess

Where IEC stops tabulating — 400 mm² and above for some LV methods, above 400 mm² in
IEC 60502-2 Table B.3 — `ratingFor` and `mvTable` extend the last two tabulated sizes in a
straight line and subtract a user-set reduction, 5 % by default. The interface labels every
such figure as not IEC data, colours it separately, names the two rows it extended from and
tells the reader to replace it with a manufacturer rating, so nothing is passed off as a
standard value.

The physics is still wrong in a known direction. Real ratings flatten off as size grows,
because skin and proximity effects put an increasing share of the current in the outer
annulus of the conductor, so a straight line over-predicts and the error widens with size.
The 5 % reduction is not derived from anything; it was chosen to be roughly one standard
size of margin at the sizes where extrapolation starts, and at 630 mm² it is very likely
insufficient.

**Recommendation.** Replace the linear extension with a fit to a manufacturer's published
range over the tabulated sizes, or drop the extrapolation entirely for MV and require a
manufacturer figure above 400 mm². A curve fitted to the tabulated rows themselves would at
least reproduce the flattening rather than ignore it.

### G22. Trench independence is asserted by the user, not checked

Splitting a run across trenches divides the circuit count the grouping factor is looked up
on, which is correct only if the trenches are thermally independent. The tools state this
plainly and say that two trenches a metre apart are still one group, but nothing enforces
it: the trench separation is not an input, so a user can split into four trenches a metre
apart and get a grouping factor that does not exist in practice.

The same applies to the circuit widths behind the trench-width calculation. `CIRCUIT_WIDTH_MM`
is an indicative overall-diameter figure interpolated by size, not a manufacturer dimension,
and there is an override input precisely because it is approximate. The width figure is good
enough to answer "does this need one trench or three", not good enough for a civil drawing.

**Recommendation.** Add trench centre-to-centre separation as an input and refuse to divide
the circuit count below a separation where the trenches genuinely decouple — IEC 60502-2
Table B.19 already tabulates by centre spacing and gives a defensible threshold. Take the
cable diameter from the `.PAN`-equivalent manufacturer data where one is loaded.

### G23. An overridden factor is not recorded anywhere

Every calculated figure in the cable tools can be typed over, which is necessary — real
jobs carry manufacturer ratings and client standards the IEC tables do not. The interface
is honest about it: an override shows blue, the displaced table value stays visible struck
through, and a line says the rating is no longer purely the standard's.

What it does not do is ask *why*. There is no field for a source, a reference or a date,
so a design saved with four overridden factors looks identical to one where the numbers
came from nowhere. The person who set them knows; the reviewer six months later does not.
The same applies to the exports, which carry the final numbers without any mark that some
were entered rather than derived.

**Recommendation.** A short free-text source against each override, required before it
takes effect, and a provenance column in every export marking each figure as calculated,
interpolated, extrapolated or entered. Cheap to add and it is the difference between a
defensible design file and a set of numbers.

### G24. The roof designer places modules but cannot shade them

**Substantially addressed.** `src/RoofDesigner.jsx` draws a roof plane with draggable nodes,
couples pitch and node heights in both directions, takes placed obstructions with their own
keep-outs, fills the plane with modules in surface coordinates, sweeps orientation and grid
phase for the best fit, and exports a 3D DXF on named layers.

What it still does not do:

- **One plane at a time.** A hipped roof is four planes and the tool holds one. The state is
  already an array (`st.planes`, `st.active`) so the editor can take a plane selector, but
  nothing aggregates across planes yet.
- **No shading.** An obstruction removes the modules under its keep-out and nothing else. A
  chimney to the south of a row costs that row output for part of the day, and that loss
  depends on where it falls in a string, not on its footprint. The keep-out is a placement
  rule, not a shading model.
- **No yield.** The drawn coordinates are not sent to PVGIS, so the designer reports capacity
  and not generation. The call already exists in `src/pvgis.js`; wiring the designer's
  centroid and the fitted tilt and azimuth into it is a small piece of work and would make
  the tab answer "what will this roof produce" rather than "how many modules fit".
- **Mitred offset only.** `offsetPolygon` is exact for a convex outline and good for a simple
  concave one. A setback deep enough to split a plane in two needs a straight-skeleton
  offset; the degenerate case is detected and refused rather than returning nonsense, which
  is the right behaviour but not the complete one.

**Recommendation.** In order: multiple planes with a selector and a roll-up; PVGIS yield for
the drawn location; then a real shading model. The DXF writer needs nothing further for the
AutoCAD path — if PVsyst import turns out to want a particular layer convention, that is a
change to `ROOF_LAYERS` and nothing else.

### G24a. The original roof area check, superseded but kept

`RoofAreaTab` divides a rectangle by a module and applies an obstruction percentage. For
"is this a 12-module roof or a 40-module roof" that is the right level of effort, and the
interface states the limitation plainly rather than implying a layout.

It is still a long way from what a roof needs. A real roof has the vent in the middle of
the best row, a hip that cuts a corner off, a rooflight that costs three modules rather
than the two a percentage implies, and a shading obstruction whose cost depends on where it
falls in the string, not on its area. Nothing here knows any of that, and no drawing comes
out of it.

The pitch, azimuth and flush-or-tilted choice are now real inputs, and the row spacing for a
tilted array is computed rather than assumed, so the area figure is defensible. What is still
missing is placement.

**Recommendation.** A 2D roof drawing tool, which is the next piece of work and has been
asked for explicitly: draw or import roof planes against a coordinate reference, place
modules with real edge setbacks and placed obstructions rather than a percentage, pull the
yield for those coordinates from the PVGIS call the ground-mount side already uses, and
export DXF/DWG for AutoCAD so the geometry can be carried into PVsyst. The module placement
can reuse the tiling logic from the ground-mount generator; the plane geometry, the
obstruction handling and the DXF writer are the new work. DXF is a documented text format and
is the sensible target — AutoCAD opens it directly and PVsyst imports from it. Until that
exists, the area check must keep saying it is an upper bound.

### G25. The battery dispatch has no cost model and no tariff

The simulation answers "how much of the load does this battery cover", which is a physical
question, and reports the knee in self-sufficiency against size. It does not answer "is it
worth the money", because there is no capital cost, no tariff, no export price and no
degradation over the project life in it.

That is a real limit on the advice. The knee in self-sufficiency is not the economic
optimum, and the two can be far apart: under a flat tariff with a poor export rate the
economic answer is usually a smaller battery than the knee, and under a wide
peak/off-peak spread it can be larger. The tool is careful to present the knee as a
physical turning point rather than a recommendation to buy, but a reader in a hurry may not
make that distinction.

**Recommendation.** Capital cost per kWh and per kW, an import tariff with at least a
two-rate option, an export price, a discount rate and a cycle-life curve, producing NPV
against battery size alongside the existing self-sufficiency curve. The dispatch already
produces the hourly import and export series the calculation needs, so this is a costing
layer rather than new physics. The same panel would serve the batch analyser's deferred
cost phase.

### G26. Trench occupancy counts routes, not what is actually in the trench

`analyseTrenches` counts how many routed LV runs share each stretch and reports the busiest.
That is a real improvement on a number typed from memory, and it is the right quantity for
IEC 60364-5-52 B.52.18/19 NOTE 3. It is still not the whole trench.

It does not know about anything the routing does not draw: auxiliary supplies, comms, earth
conductors, or a second phase of the project sharing the same route later. It assumes one
route is one circuit, so parallel conductors per pole are applied downstream in the cable
tool rather than here — correct, but it means the figure on the Layout tab is not the number
that goes into the lookup unless the parallel count is one. And it has no notion of vertical
separation: two circuits in the same trench at different depths are counted as neighbours
when the standard would treat them differently.

**Recommendation.** An "other services in this trench" input on the Layout tab that carries
through to the cable tool, and a depth band per route so a trench with two layers is counted
as two groups. Neither is hard; both need the routing to carry more than geometry.

### G27. The DXF export has no coordinate reference

The layout exports in the local metre grid the tool works in, with the origin wherever the
boundary import put it. Opened on its own that is fine. Overlaid on a survey it is not — there
is no georeference, no scale statement beyond the implied metres, and no record of which
projection the boundary came from, so a drawing that came in as UTM goes out as something
near the origin instead.

The boundary importer does keep a geo origin internally to stop 6-figure coordinates reaching
the SVG maths, so the information exists; it simply is not written back out.

**Recommendation.** Write the stored geo origin into the DXF as a header variable and offer an
"export in source coordinates" option that adds it back to every point. Until then, anyone
overlaying the export on a survey has to move it manually, and the interface should say so.

### G28. Load flow is not built, and the MV tool implies it

The MV cable tool accumulates current round a ring, carries R and X per size, and reports
cumulative voltage drop per run. That is most of a load flow and it is close enough to one
that a reader could mistake it for one. It is not: it is a one-way drop calculation along a
radial path, with no reactive power, no voltage-dependent behaviour and no convergence.

What a real load flow would add, in rough order of value:

- **Voltage rise at full export.** A collector carrying generation rather than load runs the
  volt drop backwards, and the binding constraint on an MV ring is usually the rise at the
  far inverter rather than the drop at the substation. The current tool cannot show that
  because it has no sign convention for generation.
- **Reactive power.** Grid codes ask for a power factor range at the connection, and holding
  it changes every current in the network. The MV tool takes a single design power factor and
  applies it uniformly, which is the right simplification for sizing and the wrong one for
  compliance.
- **Losses per segment at a real operating point**, rather than at nameplate.
- **A closed ring.** Running a ring closed rather than open changes the flows substantially
  and is how most collectors are actually operated under fault.

**Method.** A PV collector is radial or weakly meshed, so a backward–forward sweep converges
in a handful of iterations and is perhaps a hundred lines — a full Newton–Raphson is not
needed and would be harder to explain, which matters in a tool whose whole premise is showing
the working. The network is already implicit in the MV tab's run table (from, to, inverters,
length, size); it needs a slack bus at the point of connection and a per-node injection.

**Recommendation.** Build it against the MV run table rather than as a separate network
editor, so the ring is entered once. Until it exists, the MV tool should not be read as a
compliance check, and the landing screen lists load flow as planned rather than offering an
empty tab.

### G29. The costing tool is unlevered, pre-tax and single-currency

`src/costing.js` gives LCOE, NPV, IRR and payback at one discount rate. That is the right
level for ranking options and the wrong level for a financial close. It has no debt, no
gearing, no tax, no depreciation, no residual value and no DSCR, so the IRR it reports is a
project IRR and not an equity one, and the two are not close on a geared project.

It also does not convert currency, by design — there is no exchange rate anywhere in it, and
a comparison across currencies reports that it is not comparable rather than applying a rate
that would be stale. That is honest but it does leave the cross-region comparison half
finished: the user has to bring the quotes to one currency themselves.

**Recommendation.** A gearing block (debt share, tenor, margin, DSCR) producing equity IRR
alongside project IRR; and an exchange-rate table the user maintains with its own date,
handled exactly as the quotes are — entered, dated, never fetched. Neither is hard; both
are more spreadsheet than engineering, which is why they are not here yet.

### G30. The quote library lives in the browser

Quotes are held in the project state and in the CSV export. There is no shared store, so two
people pricing the same market keep separate libraries and neither knows the other exists.
The CSV is the answer for now — keep it in version control or a shared drive — but it is a
convention rather than a mechanism, and conventions decay.

**Recommendation.** If this becomes the real cost record for a team, it needs a backing store
with an append-only history, so a price can be traced to who entered it and when it changed,
not merely when it was quoted. That is a different kind of application from the rest of
PVhub and should be a deliberate decision rather than a drift.

---

## Severity 4 — Polish

### G12. No favicon

`index.html` declares no `rel="icon"`, so browsers request `/favicon.ico` and 404. The
brand mark already exists in the boot overlay and would inline as a data-URI SVG.

### G31. The phone layout is verified at one viewport, in portrait

The sweep that signed off the mobile pass runs at 390x844 in portrait, which is an
iPhone 13. Nothing has been checked in landscape, on a tablet between 760 and 1024 px, or
with the text size turned up in iOS accessibility settings — the last of which scales
`rem` and leaves `px` alone, so an interface declared almost entirely in `px` ignores it.
The 760 px breakpoint is also a single hinge: a 768 px tablet gets the desktop layout
including twelve-column tables, which is the worst of both.

What would close it: run the existing probe at 414x896, 768x1024 and both orientations,
and move the type scale onto `rem` so the system text size does something.

### G32. The checkbox target depends on `:has()`

`label:has(> input[type="checkbox"])` carries the 38 px touch target. That is Safari 15.4
and Chrome 105 and up, which is almost everything in 2026, but on anything older the box
falls back to 22 px rather than degrading to something larger. It is not a break — it is
the behaviour before the rule existed — but it is worth knowing it is a soft floor rather
than a guaranteed one.

### G33. The report reader is proven against one report layout

`parsePvsystReport` reads a grid-connected, fixed-tilt, self-consumption run from PVsyst
8.1 completely — 127 assertions, every field, the monthly table and the whole loss diagram.
That is one layout. A tracker plant prints a tracking section this reader does not look for;
a stand-alone system has no grid rows at all; older PVsyst versions word their headings
differently. Those will read partially, and the tracker says which fields it could not find
rather than inventing them, so the failure is visible rather than silent — but "visible" is
not "handled".

What would close it: a second and third real report, of different system types, added as
fixtures with the same assertion density.

### G34. The tracker has no basemap

`SiteMap` plots latitude and longitude on a labelled graticule with the tropics marked, and
deliberately draws no coastlines: a tile service would be the only part of the application
that needs the network, and an outline sketched from memory looks authoritative and is
wrong — the first attempt at one was unrecognisable. The degrees are exact, so a project is
locatable, but you cannot see at a glance that a pin is in Zambia rather than the Indian
Ocean.

What would close it: embed a real low-resolution coastline (Natural Earth 1:110m is public
domain and compresses to tens of kilobytes as a simplified path set), still with no network
call.

### G35. A tracked project cannot carry its layout

The stated intent for the tracker is a drawing beside the numbers. The DXF readers already
exist (`src/dxfRead.js`, and `parseDxf` in App.jsx) and the layout tools render plans, so
the geometry half is built; what is missing is attaching a drawing to a tracked record and
storing it. Note that a DXF is far larger than the parameter record, so the browser-storage
limit below becomes a real constraint rather than a theoretical one.

### G36. The tracker's file mode is unverified end to end

`src/trackerStore.js` writes the records to a file the user picks, and clears browser storage
when it does. Connecting a file, writing to it and clearing the browser copy are all verified
against a stubbed File System Access API. Two paths are **not**: reconnecting to a remembered
file after a reload, and re-granting permission in a new session. Neither can be driven by a
test — a stubbed handle is not structured-cloneable so it never reaches IndexedDB, and a real
permission prompt needs a human. The branching around them is pulled into the pure
`startupPlan` and tested there (`tests/trackerStore.test.mjs`), but the browser halves are
verified by reading only.

What would close it: confirm by hand in Chrome that choosing a file, reloading, and
reconnecting in a fresh session all behave — then write down what happened.

Browser storage remains the fallback on Firefox and Safari, which have no such API, with the
same limitation as the costing quote library (§G30): a cleared cache loses the lot, and the
JSON export is the archive. `localStorage` also caps at roughly 5 MB per origin, which the
parameter records will not trouble but an attached drawing (§G35) would.

### G13. Accessibility not addressed

Tabs are `<button>` elements without `role="tab"` / `aria-selected` / `aria-controls`.
Pass/fail status is carried by colour with a text label alongside — better than most — but
several readouts mark significance with accent colour alone.

### G14. Bundle is 2.2 MB, largely `pdfWorkerText.js`

The pdf.js worker is inlined as a 1.3 MB string and loaded on every visit, including for
users who never open a datasheet. A dynamic `import()` on first use would cut initial load
by more than half.

---

## Suggested order of work

1. **G3** — guard the spread reductions. Contained, and it clears ~270 errors that would
   otherwise mask a real regression in every future check.
2. **G2 + G1** together — extract `src/calc/` and pin the yield model and string bounds
   with golden-value tests. Everything else is safer afterwards.
3. **G9** — add a licence. Five minutes.
4. **G4, G6** — provenance on modelled yields, schema version on project files. Both are
   about a number outliving the context that qualifies it.
5. **G7, G8** — reconcile the README with the code, and write the assumptions down while
   the reasoning is still in someone's head.
6. **G11** — ESLint in CI.
7. **G21, G22, G23** — cable extrapolation physics, trench independence, override provenance.
8. **G24** — multiple planes, PVGIS yield for the drawn roof, then shading. The drawing tool
   and DXF export are done.
9. **G25** — a cost model for the battery.
10. **G26, G27** — other services in the trench, and a georeferenced DXF export.
11. **G28** — load flow on the MV collector. The largest outstanding engineering piece.
12. **G29, G30** — gearing and currency in the costing tool; a shared store for the quotes.
13. **G5, G10, G12–G14**.
