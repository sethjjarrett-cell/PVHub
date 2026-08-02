# PVhub — Overview

PVhub is a browser-based preliminary design tool for utility-scale and commercial
photovoltaic (PV) systems. It walks an engineer from a module datasheet through to a
laid-out array on a real site boundary, showing the governing formula and the reasoning
behind every number it produces.

The whole application is a **single self-contained `index.html`** (~360 KB). Open it in a
browser and it runs. There is no server, no build step in the repository, no package
manager, and no account system.

---

## 1. What it does

The tool is organised as a seven-step pipeline. Each step is a tab; state flows forward
from step 1 to step 7, but nothing is gated — every page ships with working defaults, so
you can jump straight to Layout and come back to refine.

| # | Tab | Purpose |
|---|-----|---------|
| 1 | **Module** | Module nameplate: physical envelope, STC electrical values, temperature coefficients (β Voc, γ Pmax, α Isc, optional β Vmp), max system voltage. |
| 2 | **Inverter** | Inverter/MPPT datasheet: voltage windows, full-power P-V curve bounds, startup voltage, max current per MPPT, MPPT count, connector limits, AC rating. |
| 3 | **Frame** | Mounting frame geometry: fixed-tilt or single-axis tracker, tilt, module orientation, modules per frame, frame sizing by module count or max frame length. Includes a live frame drawing. |
| 4 | **String Sizing** | The core electrical calculation — modules per string, derived from temperature extremes. Nine numbered worked steps, each with formula, result, pass/fail status, and a plain-English "why". |
| 5 | **Paralleling** | Parallel strings per MPPT and DC build-up: string count limited by the lower of connector limit and MPPT current headroom; DC/AC ratio against the AC rating. |
| 6 | **Pitch & Shading** | Row pitch vs. shading trade-off. Computes GCR and clear row gap, runs a solstice clearance check, and models specific yield (kWh/kWp) and row-shading loss per candidate pitch from the fetched irradiance record. |
| 7 | **Layout** | Site boundary, blocks and corridors, array pitch and alignment, terrain gradient limits, electrical grouping, and design variants scored against an optimisation target. |

### Three UI modes

A mode switcher in the header changes how much of the tool is exposed:

- **Stupid** — collapses everything to the Layout tab only. Draw a boundary, pick a
  mounting type, get an array. Advanced sections (`02 The basics`, `1B Gradient limits`,
  `07 Optimisation target`) are hidden.
- **Simple** — the seven tabs with advanced sub-sections hidden.
- **Engineer** — everything, including gradient limits, optimisation targets, and the
  full derivation waterfalls.

Sections are addressed by short codes (`1A Physical`, `1B Electrical (STC)`,
`1D Saved modules`, `2D Saved inverters`, …) which appear in the UI and are the most
reliable way to refer to a specific input group.

---

## 2. The engineering model

This is the part worth understanding before changing any numbers.

### String sizing (tab 4)

The calculation runs as nine numbered steps, rendered as a "worked example" waterfall:

1. **β_Vmp derivation** — if the datasheet does not publish β Vmp, it is recovered.
   Route A: `γ_Pmax − α_Isc` (power coefficient splits into voltage and current parts).
   Route B (NOCT): compares Vmp at NOCT (800 W/m², hot cell) with STC and strips the
   irradiance contribution using the diode term `N·n·kT·ln(0.8)`, leaving pure temperature
   effect. The method actually used is reported in the UI.
2. **Adopted temperature extremes** — `T_low = MIN(all source lows)`,
   `T_high = MAX(all source highs)`. **Sources are never averaged.** The most extreme
   value governs, because averaging would soften exactly the extreme the check exists to
   catch. Built-in source rows include ASHRAE extreme dry bulb, ERA5 absolute extremes,
   Solargis T2m, WeatherSpark/MERRA-2, and meteoblue.
3. **Cell temperature extremes** — `T_cell,min = T_low − margin`,
   `T_cell,max = T_high + rise + margin`. The *rise* is a mounting-dependent preset (an
   operating module runs well above ambient); the ± margin covers source and model
   uncertainty at both ends.
4. **Temperature-corrected voltages** — `V(T) = V_STC × (1 + coeff/100 × (T_cell − 25))`.
   Cold Voc is the highest voltage the module will ever present; hot Vmp is the lowest it
   operates at. Cold Vmp is also computed, for the plateau check in step 8.
5. **Maximum modules per string (cold over-voltage)** —
   `N_max = ⌊ min(inverter V_max, module V_sys) / Voc(cold) ⌋`. **Floor, never round** —
   one more module would over-volt the inverter on the coldest morning.
6. **Minimum modules per string (hot full-power floor)** —
   `N_min = ⌈ V_fp,lower / Vmp(hot) ⌉`. This uses the *full-power* lower bound from the
   P-V curve, not the MPPT tracking lower bound on the datasheet front page. Below the
   full-power bound the inverter still tracks but cannot deliver rated power — yield
   collapses quietly on the best days. The startup-voltage threshold is reported for
   information only.
7. **Recommended N — frame divisibility** —
   `N_rec = N_max − (N_max mod P) if ≥ N_min, else N_max`. Strings that divide evenly into
   frame bays mean no strings spanning frames, cleaner harnesses, simpler commissioning —
   usually worth trading the odd module below the electrical maximum. If the divisible
   candidate falls below the hot minimum, the electrical maximum stands.
8. **Cold Vmp vs full-power upper (plateau check)** — `N × Vmp(cold) ≤ V_fp,upper ?`
   Flags the case where the array sits above the full-power plateau until it warms, so the
   small cold-morning loss is a conscious trade rather than a surprise.
9. **Parallel strings & DC build-up** — `S = min(connector limit, ⌊ I_MPPT / I_string ⌋)`.
   Either the connector count or the current runs out first; both are checked and the
   lower governs. DC/AC ratio is reported against the AC rating when entered.

### Pitch & shading (tab 6)

Row pitch drives a direct trade: tighter pitch adds MWp per hectare but costs winter
yield. The tool computes GCR as `collector width / row pitch` and the clear gap between
rows, then evaluates candidate pitches on kWh/kWp and shading loss (lower wins).

The solstice clearance check uses a fixed-declination approximation — the winter noon
solar elevation is taken as `90 − |latitude| − 23.45`, and the required shadow geometry
comes from the tilted collector's rise (`L·sin θ`) and run (`pitch − L·cos θ`). For a
tracker the tilt is treated as 0. This is the "quick geometric screen"; the modelled
yield below is the quantitative answer.

### Energy yield model (section 6C)

`pvYield()` is a self-contained pure function that turns the fetched irradiance record
into a specific yield (kWh/kWp·yr) and a row-shading loss for any candidate pitch. It is a
**preliminary screening model, not a bankable yield**. The chain, per month:

1. **Day types.** Each month runs as two representative days — a clear day at the 90th
   percentile of recorded daily GHI and a dull day — weighted so their mean returns the
   recorded monthly total. A single average day would smooth away the peaks that cause
   inverter clipping, which would make the DC/AC input inert.
2. **Beam/diffuse split.** Daily clearness index `kt = H / H₀` against extraterrestrial
   irradiation, then the **Erbs** correlation for the diffuse fraction.
3. **Intra-day distribution.** **Collares-Pereira–Rabl** for global and Liu–Jordan for
   diffuse, stepped at 15 minutes across the day.
4. **Transposition.** `POA = B·R_b + D·(1+cos β)/2 + G·ρ·(1−cos β)/2` — isotropic sky plus
   ground reflectance ρ.
5. **Row shading.** Profile-angle geometry against the row rise `L·sin β` and clear gap
   `pitch − L·cos β`, deducted from the **beam component only**. Diffuse is left unshaded.
6. **Trackers.** Single-axis N–S with **ideal backtracking** (the pvlib formulation,
   `axes_distance = pitch / L`), clamped to the frame's `maxRot`. Backtracked rows do not
   self-shade, so the shading column reads ≈ 0 and pitch acts through the backtracking
   angle instead.
7. **Temperature.** NOCT model, `T_cell = T_amb + (NOCT−20)/800 · POA`, against the monthly
   mean ambient from the same ERA5 request — so the derate tracks the site's weather.
8. **Losses and clipping.** System losses, inverter efficiency, then an AC cap at
   `1 / DC-AC`, which is what turns an oversized array into lost energy.

Exposed assumptions (all editable in 6C): system losses 12%, inverter efficiency 98%,
ground albedo 20%, DC/AC 1.2.

Not modelled: horizon shading, seasonal soiling, bifacial rear gain, spectral and IAM
corrections, and diffuse row blocking. Validation against synthetic input reproduces the
input GHI to within ~0.7%, and yields the expected fixed-vs-tracker and
pitch-vs-shading relationships.

### Layout (tab 7)

Site boundary is entered as a polygon of coordinates (a simple `x, y` per line text
field). On top of that sit blocks and corridors, road widths (presets: Base 5.5 m, Wide
6.5 m), ridge gaps between E/W faces, row stagger that keeps frames true N–S, and terrain
gradient limits (soft and hard, along-axis and across-axis, with optional terrain points).

Design variants are generated and scored against an optimisation target — either
"maximise capacity" or a target-driven mode (target DC, target modules, target strings,
target inverters). Variants are tagged, with the recommended one highlighted.

---

## 3. Architecture

```
index.html
├── <head>
│   ├── inline <style>          boot-screen CSS only
│   └── (no external <link>, no favicon)
├── <body>
│   ├── #root                   React mount point
│   ├── #boot                   animated loading overlay, removed on mount
│   └── <script type="module">   ~360 KB esbuild bundle
│       ├── React 19.2.7 + ReactDOM + scheduler   (minified, lines ~31–39)
│       └── application code                      (readable-ish, lines ~40–178)
└── bundled license banner       (lines 179–224)
```

Key characteristics:

- **React 19.2.7**, mounted with `createRoot`. No JSX at runtime — the bundle contains
  `React.createElement` calls, so the shipped code is the compiled output.
- **No CSS framework.** Styling is inline `style={{…}}` objects plus template-literal CSS
  strings injected per component. A shared theme object (referred to as `T` in the bundle)
  holds the palette: `T.accent` `#e8820c` orange, `T.panel`, `T.panel2`, `T.line`,
  `T.text`, `T.muted`, `T.chrome`, `T.warn`.
- **All seven tool panes mount simultaneously** and are shown/hidden with
  `display: flex | none`. State therefore survives tab switches for free — but every pane
  also *computes* on every render, including panes you cannot see.
- **All drawings are inline SVG** (frame drawing, layout plan, shading sections). There is
  no `<canvas>` anywhere.
- **Undo/redo** is wired to Ctrl+Z / Ctrl+Y with toolbar buttons.

### State and persistence

- Component library (saved modules and inverters) is persisted to `localStorage` under the
  key **`pvhub.library.v1`**, JSON-encoded.
- Projects are saved and opened as file downloads/uploads, not stored in the browser:
  - **`pvhub-project.json`** — the full project state.
  - **`pvhub-component-library.json`** — the module/inverter library, exportable separately.
- Tools expose their state to the project save/open machinery through a ref-based
  `{ get, set }` contract — each tool registers a handle exposing `get()` returning its
  slice and `set(slice)` restoring it. Look for `layout`, `shade`, and sibling keys on that
  shared ref.
- There is a **"Read from a datasheet"** section on both the Module and Inverter tabs
  (`1C`/`2C`) — a paste-and-parse helper that maps free text onto known field keys
  (`voc`, `vmp`, `isc`, `imp`, `pmax`, `bVoc`, `gPmax`, `aIsc`, `vSysMax`, `acKva`,
  `vMax`, `vStart`, `trackLo`, `fpLo`, `fpHi`, `iMppt`, `nMppt`, `connMax`).

### The one external dependency

Despite being a single offline file, the app makes **one network call**: the Pitch &
Shading / temperature workflow can pull ERA5 reanalysis history from Open-Meteo.

```
https://archive-api.open-meteo.com/v1/archive   (primary)
https://api.open-meteo.com/v1/archive           (fallback)
  ?latitude=…&longitude=…&start_date=…&end_date=…
  &daily=temperature_2m_max,temperature_2m_min,
         temperature_2m_mean,shortwave_radiation_sum
  &timezone=UTC
```

No API key. The window is "N years back from one week ago" (`Date.now() − 6.048e8 ms`),
where N comes from the "Years of record" input. The app already surfaces the two common
failure modes to the user: opening the page from a `file://` path (browsers block
cross-origin requests from local files — host it instead), and corporate networks blocking
`open-meteo.com`. Everything else in the app works fully offline.

The single request serves both halves of the tool. Temperature extremes feed string sizing;
`shortwave_radiation_sum` (MJ/m², converted to kWh/m² by ÷3.6) and `temperature_2m_mean`
are aggregated per calendar month and written to `loc.clim`:

```js
loc.clim = {
  ghiDaily,   // [12] mean daily GHI, kWh/m²·day
  ghiHi,      // [12] 90th-percentile daily GHI — the "clear day"
  tMon,       // [12] mean ambient, °C
  ghiAnnual,  // kWh/m²·yr
  days        // sample count
}
```

`loc` is App-level state already passed to both the string-sizing tool (which fetches) and
the shading tool (which models), so this needs no extra plumbing. Non-finite days are
filtered before any reduction, so sparse coverage cannot inject a fictitious 0 °C or
0 kWh/m² into the extremes.

---

## 4. Running it

```bash
# Simplest — works for everything except the ERA5 fetch
open index.html

# Recommended — serve over http:// so the Open-Meteo call works
python3 -m http.server 8000
# → http://127.0.0.1:8000/index.html
```

The repository is structured to be served directly by GitHub Pages: `index.html` at the
root is the entire deployable artifact.

---

## 5. Repository layout

```
.
├── README.md      2 lines — title and one-line description
├── index.html     the entire application (bundled build artifact)
├── OVERVIEW.md    this file
├── GAPS.md        known gaps, risks, and recommended work
└── CLAUDE.md      working context for AI agents and new contributors
```

**There is no source tree.** `index.html` is a build output — an esbuild bundle committed
without the TypeScript/JSX sources that produced it, and without the build configuration.
See [GAPS.md](./GAPS.md) for what that costs and what to do about it.

---

## 6. Conventions worth knowing

- **British English** throughout the UI (`optimisation`, `paralleling`, `metre`), and
  `<html lang="en-GB">`.
- **SI units**, metres and degrees Celsius. Voltages in V, currents in A, power in Wp/kWp/
  MWp, AC rating in kVA.
- **Typography is deliberate**: monospace (`--mono`) for all numeric readouts and formulas,
  system sans for labels and prose. Numbers are formatted through a shared rounding helper
  with an explicit decimal count.
- **Every derived number is explained.** The house style is formula → substituted values →
  result → a short "why this rule exists" paragraph. New calculations are expected to
  follow that pattern rather than emitting a bare number.
