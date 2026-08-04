# PVhub — Gap Analysis

Assessment of the repository against its own goals. Ordered by how much each finding
constrains future work, not by how hard it is to fix.

Written after the source tree replaced the stale single-file build that the repository had
been tracking. Several findings from the earlier revision of this document were artefacts
of that build being the only thing present, and have been removed rather than restated.

---

## Severity 1 — Structural

### G1. `src/App.jsx` is 6,300 lines and 84 top-level functions

Everything is in one file: seven tools, the layout generator, the yield simulation, the PDF
datasheet parser, the styling, the components. It is genuinely well written — real names,
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

## Severity 4 — Polish

### G12. No favicon

`index.html` declares no `rel="icon"`, so browsers request `/favicon.ico` and 404. The
brand mark already exists in the boot overlay and would inline as a data-URI SVG.

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
7. **G5, G10, G12–G14**.
