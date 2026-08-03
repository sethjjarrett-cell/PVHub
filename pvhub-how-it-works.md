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
- **Cable lengths** are straight-line estimates for ranking variants, not a
  cable schedule. Cable sizing is not yet implemented.
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
