# PVhub — Gap Analysis

Assessment of the repository as it stands. Findings are ordered by how much they constrain
future work, not by how hard they are to fix.

**Repository state at time of writing:** two files (`README.md`, `index.html`), six
commits, five of them titled "Add files via upload". No branches other than `main` and the
current working branch. No tags, no releases, no issues, no CI.

---

## Severity 1 — Structural

### G1. The source code is not in the repository

`index.html` is a **build artifact**: a ~360 KB esbuild bundle containing React 19.2.7 and
the application, committed with no corresponding source tree, no `package.json`, no build
config, and no source map (`grep sourceMappingURL` → nothing).

What this costs concretely:

- **Every change is a change to bundled output.** The application code inside the bundle
  has minified identifiers (`T`, `Bt`, `cl`, `je`, `Zi`, `bg`, `xg`, `Mg`) and no module
  boundaries. Two lines are 133 KB and 100 KB long. Editing this by hand is possible — the
  strings, CSS and JSX-equivalent structure survived minification — but it is slow,
  error-prone, and every edit degrades the file further.
- **No diffs are reviewable.** The commit history shows changes as `83 insertions,
  67 deletions` on a file whose lines are 100 KB wide. Nobody can review that.
- **React cannot be upgraded** without the original build, since the vendor code is fused
  into the same file.
- **Provenance is unverifiable.** There is no way to confirm the shipped bundle matches any
  reviewed source, because no source exists to compare against.

**Recommendation.** Recover or reconstruct the source and make the bundle a build output,
not a tracked file. Minimum viable structure:

```
src/
  main.tsx                 mount + boot-overlay teardown
  theme.ts                 the T palette object
  state/                   project schema, save/open, undo-redo, localStorage
  tools/
    Module.tsx  Inverter.tsx  Frame.tsx  StringSizing.tsx
    Paralleling.tsx  PitchShading.tsx  Layout.tsx
  calc/                    pure functions — the engineering model, no React
  components/              Field, Section, Select, Readout, Warn, WorkedStep
index.html                 shell only
package.json  vite.config.ts  (or the esbuild config already in use)
```

The `calc/` split matters most: the engineering model is currently entangled with
rendering, which is the direct reason G5 (no tests) is unfixable today.

If the source is genuinely lost, say so explicitly in the README and treat a one-time
extraction from the bundle as a planned project — the readable CSS, formula strings and
component structure make it recoverable, but it is a deliberate piece of work, not
something to attempt incrementally alongside feature changes.

### G2. No build, no CI, no release process

There is no `package.json`, no lockfile, no GitHub Actions workflow, no linter, no
formatter, no `.gitignore`, no `.editorconfig`. Deployment is implicitly "GitHub Pages
serves `index.html`", but that is nowhere stated or configured in the repo.

**Recommendation.** Once G1 lands: a lockfile, a `build` script, and a workflow that builds
on push and publishes to Pages. Until G1 lands, at minimum add a `.gitignore` and a
workflow that does an HTML sanity check so the repo is not entirely unguarded.

---

## Severity 2 — Correctness

### G3. Layout renders `-Infinity` / `NaN` SVG geometry on first load

**Verified, reproducible.** Loading the page in headless Chromium produces ~200 console
errors immediately, before any user interaction:

```
Error: <line> attribute y1: Expected length, "-Infinity".
Error: <rect> attribute width: Expected length, "Infinity".
Error: <svg> attribute viewBox: Expected number, "…600000000000023 -Infinity 547.2 …".
```

**Root cause.** The Layout tool computes its bounding box with spread reductions —
`Math.min(...pts)` / `Math.max(...pts)` — and the site boundary polygon is empty on first
load. `Math.min()` with no arguments returns `Infinity` and `Math.max()` returns
`-Infinity`, so the viewBox and every child coordinate become non-finite. The bundle
contains seven such spread call sites.

**Why it fires on load rather than on visiting the tab:** all seven panes mount
simultaneously and are hidden with `display: none` (see OVERVIEW §3), so the Layout tool
renders — and computes — even while the user is on tab 1.

**Impact.** Currently cosmetic: the browser rejects the bad attributes, the boot overlay
clears, all seven tabs render, and the app is usable. But it means the console is unusable
for real debugging, and any future code that reads those bounds numerically (an area
calculation, a fit-to-screen, an export) will silently produce `NaN` rather than throwing.

**Fix.** Guard every bounds computation with an empty check and return a sane default
viewBox, e.g.:

```js
const bounds = pts.length
  ? { minX: Math.min(...pts.map(p => p.x)), /* … */ }
  : { minX: 0, minY: 0, maxX: 100, maxY: 100 };
```

and render an empty-state prompt ("Draw or paste a site boundary to begin") instead of a
degenerate SVG.

### G4. The solstice clearance check uses a fixed-declination approximation

Winter noon elevation is computed as `90 − |latitude| − 23.45`. This is the standard
solstice shortcut and is defensible for preliminary design, but it is **not stated as an
approximation anywhere in the UI**, and the tool otherwise makes a virtue of explaining
exactly what it assumes.

It also has a real failure mode: within the tropics (|lat| < 23.45°) the sun passes
overhead and this formula stops meaning what the surrounding UI implies. That is not a
hypothetical for this codebase — the temperature-source notes reference **Guinea**
(latitude ~10°N), squarely inside that band.

**Recommendation.** Either state the assumption in the step's "why" text — matching the
house style used everywhere else — or compute declination properly per day-of-year. Add an
explicit note for low-latitude sites.

### G5. Zero tests

There is no test of any kind. For a tool whose entire value is numerical correctness in an
engineering context, this is the most consequential quality gap after G1.

The calculations that most need pinning down, in priority order:

1. `N_max` / `N_min` string bounds, including the floor/ceiling behaviour that the UI text
   explicitly calls out as deliberate ("Floor, never round").
2. β_Vmp derivation — both the `γ_Pmax − α_Isc` route and the NOCT/diode route, plus route
   selection when β Vmp is absent from the datasheet.
3. Temperature extreme adoption — specifically that sources are taken as MIN/MAX and
   **never averaged**, which is a stated design rule and exactly the kind of thing a
   well-meaning refactor breaks.
4. `N_rec` frame-divisibility fallback when the divisible candidate drops below `N_min`.
5. Parallel-string limit — that the lower of connector limit and MPPT current governs.
6. GCR and clear-gap geometry.
7. Project save → open round-trip fidelity across all seven tools.

These are pure functions today in everything but their packaging. Extracting `calc/` (G1)
makes all seven testable in an afternoon; without that extraction none of them are
reachable.

### G6. No schema version or migration path for saved projects

The `localStorage` key is versioned (`pvhub.library.v1`) — good. But `pvhub-project.json`
carries no version field, and the save/open contract is a loose per-tool
`{ get, set }` where `set` merges whatever keys it finds. An older project file opened
against a newer build will silently half-apply: recognised keys load, new fields keep their
defaults, removed fields are ignored, and the user gets a plausible-looking design that is
not the one they saved.

**Recommendation.** Add a `schemaVersion` to `pvhub-project.json`, validate it on open, and
refuse-with-explanation (or migrate) on mismatch. For an engineering tool this is a
correctness issue, not a nicety.

---

## Severity 3 — Documentation and product

### G7. The README is two lines

```
# PVhub
PV Preliminary Design Tool
```

Nothing about what it computes, how to run it, what standards or assumptions it follows,
who it is for, or how to contribute. OVERVIEW.md and CLAUDE.md (added alongside this file)
cover the first pass; the README should become a short front door that points at them.

### G8. No licence

No `LICENSE` file and no copyright statement. The bundle carries React's MIT banner, which
covers React only — the PVhub code itself is unlicensed, meaning default "all rights
reserved". Anyone who forks or contributes has no defined terms.

**Recommendation.** Add a `LICENSE`. If the intent is open use, MIT matches the vendored
dependency and is the least friction.

### G9. No engineering provenance for the assumptions

The tool encodes real design decisions — the ±margin defaults, the mounting-dependent
temperature rise presets, the road-width presets (Base 5.5 m / Wide 6.5 m), the shading
loss thresholds, the choice of ASHRAE/ERA5/Solargis/MERRA-2/meteoblue as sources. None of
these cite a standard, a project convention, or a date.

This matters because the tool's output is used to size real equipment. A reviewer cannot
tell whether "+ rise for roof mount, gap ≤ 15 cm" comes from IEC 62548, from a manufacturer
guideline, or from a rule of thumb.

**Recommendation.** A `docs/assumptions.md` mapping each default and preset to its source,
with a review date. This is the single highest-value document the project does not have.

### G10. Unhandled data-quality path on the ERA5 fetch

The Open-Meteo call has a sensible primary/fallback host pair and surfaces the two likely
failure causes to the user (`file://` origin, corporate network block). What it does not
appear to handle is **partial or sparse data** — Open-Meteo returns `null` entries for days
it has no reanalysis for, and the extremes are derived with spread `Math.min`/`Math.max`
over the returned arrays. A `null` in that array coerces to `0`, which would silently drop
a fictitious 0 °C into the low-temperature extreme — the exact input the whole string-sizing
chain is most sensitive to.

**Recommendation.** Filter non-finite values before reducing, and report the actual number
of days used against the number requested so the user can see coverage.

---

## Severity 4 — Polish

### G11. No favicon

`index.html` declares no `rel="icon"`. Browsers request `/favicon.ico` and 404. The brand
mark (`PV` + orange `hub` badge) already exists in the boot overlay markup and would inline
as a data-URI SVG in a few lines.

### G12. No PWA/offline manifest

The app is a single file that works offline apart from one optional fetch — an almost ideal
PWA candidate, and plausibly valuable for the field use this tool implies (site visits,
poor connectivity). No manifest, no service worker.

### G13. Accessibility not addressed

Tabs are `<button>` elements without `role="tab"` / `aria-selected` / `aria-controls`.
Collapsible sections use `<details>`/`<summary>` (good), but the custom caret hides the
native marker without an ARIA equivalent. Colour is load-bearing for pass/fail status
(green `.wk-status.ok` vs red `.wk-status.bad`) with a text label alongside — better than
most, but the readouts marking values in orange `<b>` carry meaning by colour alone.

### G14. Commit hygiene

Five of six commits are titled "Add files via upload", indicating the GitHub web upload
flow rather than a local git workflow. There is no record of what changed or why in any of
them. Combined with G1, the project currently has no usable history.

---

## Suggested order of work

1. **G1** — recover or reconstruct the source tree. Everything below is cheaper afterwards,
   and G5 is impossible before it.
2. **G3** — guard the empty-polygon bounds; it is a contained fix and clears the console.
3. **G8** — add a licence. Five minutes, unblocks any external contribution.
4. **G5** — extract `calc/` and pin the seven calculations listed above.
5. **G9** — write down the assumptions while the reasoning is still in someone's head.
6. **G6, G10** — schema version and ERA5 data-quality guard.
7. **G2** — build and CI, once there is a build to run and tests to run in it.
8. **G7, G11–G13** — README, favicon, PWA, accessibility.
