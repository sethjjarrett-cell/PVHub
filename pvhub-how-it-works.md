# PVhub — how it works

A briefing note covering what each tab does, how the layout generator
optimises, and what the three interface modes assume on the user's behalf.

**One-sentence version:** it turns the electrical single-line hierarchy into a
geometric unit, tiles that unit across a real site under boundary and gradient
constraints, and then generates and scores a family of alternative layouts so
the engineer chooses the trade-off rather than the tool choosing it silently.

**What it replaces:** a day of drawing three or four candidate layouts in CAD,
comparing them by eye, and picking one. It does not replace PVsyst, PVcase, or
detailed design.

---

## The workflow

Seven numbered tabs, run left to right, though nothing is gated — every page
has working defaults, so you can jump straight to the Layout tab to sanity-check
whether a site works and come back to refine. Everything is shared state: a
parameter entered once flows into every later step.

### 1 · Module

Datasheet capture for the PV module: physical dimensions and rated power,
then the STC electrical values (Voc, Vmp, Isc, Imp) and temperature
coefficients.

A live I–V curve is drawn from those four electrical points, with the P–V curve
overlaid and the maximum power point marked. It is a sanity check, not a
simulation: if a typo makes the curve look wrong, you see it here rather than
discovering it three steps later in the string sizing.

**Feeds:** string sizing (voltages and coefficients), frame geometry
(dimensions), layout capacity (rated power).

### 2 · Inverter

Voltage windows and current limits, taken from the datasheet **and the P–V
curve**: maximum DC input, the full-power upper and lower bounds, optional
MPPT tracking floor and startup voltage, current per MPPT, connector limit,
MPPT count, and AC rating at design ambient.

The graph draws the power-versus-voltage envelope: the ramp up from the
tracking threshold, the shaded full-power plateau, the derate above it, and the
hard ceiling at maximum DC input. This is the window the string bars on step 4
must land inside, so the two tabs tell one story.

**Feeds:** string sizing, the clipping table, and the layout's AC targets.

### 3 · Frame

The mounting system: tracker, fixed tilt, or East–West duo; 1P to 4P;
portrait or landscape; and the frame sized either by module count or by a
maximum frame length (in which case it fits the largest whole number of modules
inside that length).

Detail dimensions — module gap, cross gap, end overhang, central structural
gap, ground clearance, tilt or maximum rotation — build up the frame envelope,
drawn live as a datasheet-style section and elevation with dimension callouts.
It reports strings per frame and flags when that is not a whole number.

**Feeds:** the layout engine's fundamental placement unit.

### 4 · String Sizing

Reproduces the string sizing workbook on an IEC 62548 basis. Nine workings
cards, each showing the formula, the substitution with live numbers, the
result, and the engineering reasoning:

1. β_Vmp derivation waterfall — datasheet value, else γ_Pmax − α_Isc, else the
   NOCT delta corrected for the 800 W/m² irradiance difference
2. Adopted temperature extremes — the minimum of all source lows and maximum of
   all source highs across meteoblue, Solargis, ASHRAE and WeatherSpark. Never
   averaged; averaging dilutes the extreme the check exists to catch
3. Cell temperature extremes — ambient plus mounting rise plus safety margin
4. Temperature-corrected Voc and Vmp per module
5. **Maximum** modules per string — the cold over-voltage ceiling
6. **Minimum** modules per string — the hot full-power floor (the binding
   constraint is the full-power window from the P–V curve, not the wider
   tracking range on the datasheet front page)
7. Recommended N — snapped down to a multiple of the frame's P value so every
   string sits on whole frame bays, provided it stays above the hot minimum
8. Cold Vmp against the full-power upper bound — an efficiency flag, not a
   safety limit
9. Parallel strings per MPPT and the DC build-up to DC/AC ratio

An MPPT window widget plots the chosen string's cold Voc, cold Vmp and hot Vmp
against the shaded window and the ceiling, turning red on a failed check.
Below it, a clickable design-space strip shows every valid N, marking those
divisible by the frame's P. An **Adopt** button pushes the choice into the
layout and jumps to the next step.

### 5 · Paralleling

Strings per inverter against ILR and clipping. The table lists every candidate
count with modules, DC kWp, ILR, a **model** clipping estimate, a column for
your **PVsyst** figures, and a marginal-net column (added DC percent minus
added clipping percent per extra string) that marks where the extra string
stops paying.

The model column is a parametric curve for shape only — it exists so the
table has a sensible starting order. Enter the real PVsyst numbers and the
star marks the best run within your ILR cap. Rows breaching the cap turn red.
Pick one with **Use** and it carries into the frame and layout steps.

### 6 · Pitch & Shading

Deliberately does not simulate. You run the pitch candidates in PVsyst and
enter the outputs here — pitch, specific yield, shading loss, and a free-text
note — with GCR computed automatically from the shared frame geometry. Choose
whether you are optimising for yield or for shading loss and the best row is
starred. A coarse solstice-clearance geometric screen sits below for use before
any simulation exists.

### 7 · Layout

The generator. Covered in detail below.

### 8–10 · DC, AC and MV cable

Three sizing tools sharing one engine, one per voltage level. Each asks the same
two questions in the same order, because they bind in that order.

**Will it carry the current without cooking?** The base current-carrying capacity
comes from IEC 60364-5-52 (LV) or IEC 60502-2 Annex B (MV) for the conductor
material, insulation and arrangement stated in the tab's title — copper XLPO
two-core for DC, aluminium XLPE single-cores in trefoil for AC and MV. It is then
multiplied by four derating factors, each shown separately rather than rolled into
one number, so a failing run can be traced to the factor that actually cost the
capacity:

| Factor | Depends on | Typically worth |
|---|---|---|
| `f_temp` | ambient air or ground temperature | 0.85 – 0.96 |
| `f_grp` | how many circuits share the trench or tray, and their spacing | 0.34 – 1.0 |
| `f_soil` | soil thermal resistivity | 0.79 – 1.0 |
| `f_depth` | burial depth | 0.86 – 1.06 |

Grouping is nearly always what decides the size, and it is the one most often got
wrong, because it counts **circuits, not cables**: IEC 60364-5-52 Tables B.52.18
and B.52.19 NOTE 3 make a circuit with *m* conductors per pole in parallel count as
*m* circuits. Four cables per phase in a trench with five other runs is twenty-four
circuits for the lookup, not six. A trench cross-section is drawn from the same
inputs the factor is looked up with, so a wrong count or spacing is visible rather
than buried in a cell.

**Will the volt drop and the loss be acceptable?** DC uses a loop factor, because
the circuit is out and back and both legs drop volts; AC and MV use
√3·I·(R·cos θ + X·sin θ)·L, where the reactance term is negligible at unity power
factor and emphatically is not once the inverter is asked for reactive power. Each
tab gives the drop, the I²R loss, the maximum route length at the stated limit and
the headroom against the actual run — the last of these being the number that
usually decides whether to upsize the cable or move the transformer.

The MV tab adds ring runs: current accumulates along a branch and resets at each new
branch, so a radial feeder is one branch numbered from its far end inwards. It ends
in a cable schedule by size with a spares allowance, which is the bill of materials.

Two departures from a spreadsheet doing the same job, both stated in the interface.
Continuous variables — temperature, depth, soil resistivity, circuit count — are
interpolated between tabulated points rather than stepped down to the row below,
which is optimistic; at a tabulated point interpolation returns the tabulated value
exactly, so ordinary inputs agree to the digit. And conductor resistance is corrected
from the IEC 60228 20 °C value to an operating temperature you set, because a
conductor at its 90 °C limit is 27 % more resistive than the table says. Set it to
20 °C to reproduce a sheet that uses the table value raw.

### 12 · Yield report

The tab that answers the question a client asks first: what will it make?

**One place that pulls.** Three optional outbound calls, each with its status and its
provenance on screen — ERA5 daily temperature extremes for the cold-morning voltage
check, a PVGIS TMY for the pitch model, and PVGIS PVcalc for a validated absolute yield.
Each is bounded by a timeout, because a blocked network does not always refuse a
connection: a proxy will accept one and then say nothing, and a fetch with no timeout
leaves a button spinning for ever. All three are optional and the tool works without
them, but a generation figure quoted to a client from a fallback model is worse than no
figure, so nothing is assumed.

**Absolute against relative.** PVGIS supplies the absolute yield for one kWp, because
its model is validated and ours is not. It knows nothing about row spacing — no public
API takes a pitch — so the row-geometry effect is applied on top from our own model. The
consequence is worth stating plainly: the absolute number is PVGIS's and the differences
between pitches are ours, and the differences hold up far better. Swap the irradiance
dataset and every pitch moves together, which is exactly why the comparison is worth
reading before any simulation exists.

**Pitch against everything it costs.** Widening the pitch always adds yield per kWp, so a
model that charges nothing for the extra ground would answer "wider" for ever — an
artefact, not advice. What the space costs depends on which constraint is actually real,
and on a given job exactly one of them is:

| Constraint | What moves | What it costs |
|---|---|---|
| Fixed site — the boundary is the boundary | Capacity falls as 1/pitch: fewer rows fit | Lost energy, against saved array capex |
| Fixed capacity — the plant is the plant | Area grows with pitch | More cable (as √area), more land and civils |

Cable length at the pitch in use is the layout's own routed figure; every other row scales
away from that anchor. The net column is extra revenue over the appraisal period less the
extra capex, and it is the column to read: in the fixed-capacity case it rises, peaks and
falls, so there is a real optimum, and it sits well short of the pitch that maximises
yield alone.

The shading curve behind it is two parameters standing in for an hourly simulation,
calibrated so a backtracking tracker at GCR 0.41 loses about 2.2 % against a very wide
pitch and fixed tilt at the same GCR about 5.5 %. The coefficient is an input: run two
pitches in PVsyst, turn the dial until the model reproduces the gap between them, and
everything on the tab sharpens at once.

### 11 · Short circuit

The check that normal operation never reveals. A cable sized for load current and
volt drop can still be destroyed by a fault it has to hold for a few hundred
milliseconds, and it will run perfectly until the day it does not.

**Fault level** is built up per IEC 60909 from the grid infeed, the transformer and
the inverters, with the voltage factor *c* (1.1 on MV, 1.05 on LV). The inverter
contribution is deliberately modest — an inverter is a current source, not a machine
behind a subtransient reactance, so it delivers about 1.1 to 1.2 × rated for a few
cycles. That is why PV collector networks have low fault levels, and why grading
protection on one is harder than on a conventional network rather than easier. The
peak factor κ gives the mechanical duty and the thermal equivalent current *I_th*,
including the heat in the decaying d.c. component, gives the duty the cable sees.

**The adiabatic check** is `S ≥ I·√t / k`. Adiabatic means no heat leaves the
conductor during the fault, which is true enough below about five seconds and
conservative above. Rather than reading *k* from a table, the tool derives it:

```
K = √( Q_c·(β + 20) / ρ₂₀ )          material constant: 226 Cu, 148 Al
k = K · √( ln((β + θ_f) / (β + θ_i)) )
```

which reproduces the familiar 143 for copper in XLPE and 94 for aluminium, and also
gives a part-loaded cable proper credit for starting cooler than its 90 °C limit.
Inverting the same equation gives the temperature the conductor actually reaches.

Three things come out of it: the minimum area, the one-second withstand rating that
cable schedules quote, and the maximum permitted clearing time — the last being what
the protection engineer's grading margin has to fit inside, against the slowest
credible backup stage rather than the fastest main one.

A separate check covers the screen or armour on an earth fault, which is usually
what governs on an MV cable rather than the conductor: a 240 mm² aluminium core with
a 25 mm² copper screen withstands about 22 kA for a second on the phase and about
3.5 kA on the screen.

The withstand curves are the diagram worth reading. Each is `I = k·S / √t` for one
size — a straight line of slope −½ on log-log axes — and the fault point must sit
below and left of the curve for the size installed. The `√t` is the lesson: halving
the clearing time reduces the required area by only 29 %, so upsizing shifts the
whole curve right and buys far more than shaving milliseconds off the protection.

---

## How the layout generator works

### Inputs

- **Site boundary** — drawn on canvas, pasted as coordinates, or imported from
  DXF. Editable with CAD-style grips: square handles move vertices, hollow
  handles on edge midpoints insert new ones, double-click deletes, undo/redo
  throughout.
- **Terrain** — from the same DXF (POINT, 3DFACE, POLYLINE vertices, or
  contour elevations) or an XYZ/CSV export. Boundary and terrain are shifted to
  a shared local origin so they stay registered and the maths stays away from
  six-figure UTM coordinates.
- **Gradient limits** — hard and soft, split into **along-axis** and
  **across-axis**, because those are the two planes that matter and they have
  very different tolerances.
- **Electrical configuration** — modules per string, strings per inverter,
  inverters per transformer, from the earlier steps.
- **Pitch and corridors** — row pitch or clear gap (either can be entered, the
  other is derived), end gap, road width, and whether roads run between every
  block row or every second row.
- **Optimisation target** — Mode A maximises capacity; Mode B meets a design
  target expressed as MWac × DC/AC ratio, MWac, MWdc, modules, strings, or
  inverter count.

### Step 1 — Frame geometry

Module dimensions and the mounting configuration produce the physical envelope
of one frame: length along the axis, width across it. Fixed-tilt plan depth is
foreshortened by cos(tilt); an East–West duo is two faces plus a ridge gap.
Everything downstream treats a frame as this rectangle.

### Step 2 — The block is the unit, not the frame

From modules per string and strings per inverter, the engine derives strings per
frame and hence **frames per inverter**. For example 81 modules per frame with
27-module strings gives 3 strings per frame; 24 strings per inverter therefore
gives an 8-frame block.

That block, not the individual frame, is what gets placed. This is the key
design decision: constructability is built into the generator rather than
checked afterwards. It is why the output looks like a buildable site instead of
modules scattered wherever they fit.

### Step 3 — Candidate block shapes

Eight frames can be arranged 8 wide × 1 deep, 4 × 2, 2 × 4, and so on. Shapes
that cannot physically fit the site are discarded; the rest are ranked by a
DC-run proxy (half the block diagonal, standing in for average string cable
length to the inverter) and the best few carried forward.

### Step 4 — Tiling

Each candidate shape is stamped across the site on a macro grid: block width
plus a block gap in one direction, block depth plus a road corridor in the
other. A block is placed only if **every** frame in it, inflated by the
boundary setback, sits wholly inside the polygon and passes the gradient check.
Containment is tested by corner-inside plus edge-intersection, so concave
boundaries are handled properly.

Under the edge in-fill policy, a block that fails at full width retries one
lane narrower, down to a single lane — this produces the stepped edges that
follow the boundary in whole-frame, whole-lane increments, with no orphan
frames.

Because a fixed grid is sensitive to where it happens to land, the whole tiling
is repeated at multiple grid origins and the best kept. With terrain loaded the
search widens to 24 origins and scores them by **effective** frames, so an
origin that lands blocks on flat ground beats one that merely fits more.

### Step 5 — Gradient handling

For each frame, the terrain grid is sampled at fifteen points across its
footprint and the gradient resolved into two components:

- **Along the frame axis** — articulated frames tolerate more, default hard
  limit 12%
- **Across the axis** — the torque tube or table must stay level, so the limit
  is tighter, default 6%

Above a hard limit the frame is rejected outright, which propagates: the block
fails and the narrowing logic steps it around the steep ground. Between the
soft and hard limits the frame places with a linearly graded penalty that
outlines it amber, feeds the variant score, and steers cluster selection.

The tool additionally generates a **grading tolerance spectrum** — light
grading (refuses anything worse than halfway to the hard limit) and flat ground
only (refuses anything needing grading at all). On the Simandou test site that
spectrum runs 168 frames / 8.85 MWdc at full limits, 134 / 7.06 with light
grading, and 99 / 5.21 flat-only. That is the earthworks trade-off made
explicit rather than buried.

### Step 6 — Meeting a target (Mode B)

The engine places every possible block, then selects the subset that meets the
target. Selection is **region growing**: it starts from a seed block and
repeatedly adds the best block *adjacent to the cluster so far*, so the result
is one contiguous group rather than a scattered pick of individually attractive
blocks. Each candidate is costed on distance from the cluster centre, whether
it is a full block, and its gradient penalty.

Every block is tried as a seed (up to a sensible count), so the search finds
the genuinely best contiguous cluster rather than guessing where to start.
Clusters are then compared on capacity first, then flatness, then compactness,
then cable run.

The verdict is reported explicitly: **target achievable** with all blocks
placed, or **not achievable**, with the maximum the site can actually carry.
That is the feasibility question — can this land support the contracted AC
capacity, yes or no.

### Step 7 — Electrical grouping and cabling

Blocks are walked band by band in a boustrophedon (snake) order so that
sequentially numbered inverters are physical neighbours. Each block's inverter
sits on its corridor edge. DC run is reported as the average Manhattan distance
from frame centre to its inverter — a comparative metric, not a cable schedule.

Roads run in the corridors: continuous through staggered sections, and constant
**perpendicular** width, so a road specified at 8 m stays 8 m on a diagonal
rather than pinching.

Substation and AC collector runs exist but are hidden by default, pending the
proper multi-substation layer.

### Step 8 — Alignment by stagger, never rotation

Frames always stay true north–south (or east–west for fixed tilt). Following a
boundary or a road is done by **staggering** frame ends along the axis, lane by
lane — a shear, not a rotation — so tracking geometry and yield are preserved
exactly. Alignment lines can be drawn, moved and rotated on the canvas, or
taken from a boundary edge.

### Step 9 — Scoring and ranking

Every variant is scored on normalised, explicitly weighted criteria:

- **Density** — modules placed
- **Buildability** — share of full blocks, inverter fill percentage, and
  spatial compactness (block footprint over the bounding box of the build)
- **DC runs** — average frame-to-inverter distance
- **AC runs** — total collector length, when substations are shown
- **Gradient penalty** — mean grading requirement, when terrain is loaded

A **Priority** selector shifts the weights: Balanced, Minimise groundworks, or
Maximise capacity. Variants meeting a Mode B target outrank those that do not,
regardless of score.

The score only compares variants against each other for this site and this
configuration. It is a sorting aid with published weights, not a verdict.

### Outputs

A ranked set of variants, each a complete layout you can switch between
instantly, with modules, MWdc, strings, inverters and fill, frames, site area,
DC density, cable runs, percentage on flat ground, grouping percentage, and
target achievement. Plan view or 3D axonometric, with the terrain wireframe at
true vertical scale. Projects save to a single JSON file carrying every
parameter, the boundary, the terrain and the comparison runs.

---

## The three interface modes

The engine is identical in all three. Only what is exposed changes.

### Engineer

Everything. Every parameter on every tab, all seven tabs, gradient limits,
block and corridor configuration, the substation toggle, and the full variant
set.

### Simple

The same seven-tab workflow with the essentials only. Hidden: the β_Vmp
derivation inputs (NOCT route, cell count, diode ideality), the inverter's
startup and connector limits, frame gap dimensioning, and the block/corridor
configuration. Nothing is assumed differently — the same defaults apply, they
are just not shown.

**Use it for:** a competent engineer who does not need to re-derive
coefficients, or anyone working from a datasheet rather than first principles.

### Stupid

Collapses to the Layout tab alone, with four controls: mounting type, tilt if
relevant, the question being asked (*how much fits* versus *can it meet an AC
target*), and if the latter, target MWac and DC/AC ratio.

**What it assumes:** the module, inverter and frame parameters at their
defaults, the string configuration as previously set, standard pitch and
corridor widths, and the default gradient limits.

**What it still does properly:** the DC/AC ratio genuinely sizes the inverter
block — strings per inverter is set to hit that ratio against the inverter's AC
rating — so the blocks placed carry the DC being claimed. Terrain, gradient
limits, feasibility verdict and the variant comparison all work identically.

**Use it for:** a commercial or management colleague answering "can we get
8 MWac onto this parcel". Draw the boundary, pick tracker or fixed, type the
number, read the green or red banner. The mode carries a printed caveat: good
enough to say *that fits* or *that doesn't*, not good enough to build from.

---

## Known limitations — worth stating before anyone over-trusts it

- **Clipping figures** on the Paralleling tab are a parametric estimate for
  ordering the table. PVsyst governs the accepted number.
- **Pitch and shading** are not simulated. That tab compares runs you supply.
- **Layout cable lengths** are straight-line estimates for ranking variants. The
  MV tab produces a real cable schedule, but from route distances you enter; it
  does not read them back from the layout, so the two are not yet joined up.
- **MV ratings above 400 mm²** are extrapolated, not IEC data — IEC 60502-2
  Table B.3 stops at 400. Those rows are flagged in the table. Real ratings
  flatten off above 400 mm² as skin and proximity effects grow, so a straight
  line over-predicts and the safety reduction only partly offsets it.
- **The yield report's absolute figure is PVGIS's model, not a simulation.** It carries no
  soiling schedule, no availability assumption, no degradation profile and no measured
  horizon. Expect a bankable figure to sit below it. The pitch comparison is a ratio from a
  two-parameter shading curve and is for ranking pitches against each other only.
- **Cable length away from the pitch in use is scaled, not routed.** Only the row at the
  current pitch is the layout's real figure; the rest follow a scaling law. Re-running the
  layout at each pitch would give the true answer and is the obvious next step.
- **The short-circuit check is adiabatic.** IEC 60949 permits a non-adiabatic
  credit for screens and for long durations that is not claimed here, so screen
  results in particular are on the safe side. Nothing checks electrodynamic
  forces on cleats and supports; the peak current is reported for that purpose
  but the force calculation is not done.
- **Free global DEM data** at roughly 30 m posting is adequate for deciding
  which ground to avoid, not for per-tracker slope compliance at a 5.5 m pitch.
  Use surveyed data for anything past preliminary.
- **The macro grid is rigid.** That rigidity is what produces neat, buildable
  blocks, but it means the layout cannot dodge steep patches smaller than a
  block. Where terrain is interleaved at a finer scale than the block, the
  answer is the grading-tolerance variants, not a cleverer grid.
- **Substations** are a placeholder pending a proper multi-substation layer:
  clustering inverters per substation, placing them, and routing MV between
  them.
- **No exclusion zones** yet, no earthworks cut/fill volumes, no access routing
  from a site entrance.
