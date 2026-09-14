# PVhub — PVhub

Browser-based tools for utility-scale PV preliminary design: parameter capture,
string sizing, string paralleling, pitch comparison, DC/AC/MV cable sizing,
short-circuit withstand, and an automatic layout generator with terrain awareness.

It works on a phone: the tables scroll inside their own boxes, the site canvas
takes pinch-zoom and two-finger pan, and the layout inputs open as a full-screen
sheet rather than fighting the map for half a screen.

Everything runs in the browser. No server, no account, no data leaves the machine.

---

## Just want to use it?

Open **`pvhub.html`** (the single-file build) in any browser. That's it — no install.

Everything below is only needed if you want to change the code or host it online.

---

## The tools

| Step | Tool | What it does |
|------|------|--------------|
| 1 | Module | Datasheet parameters, live I–V and P–V curves; reads PVsyst `.PAN` files |
| 2 | Inverter | Voltage windows and ratings, power-vs-voltage envelope; reads `.OND` files |
| 3 | Frame | Mounting type, 1P–4P, frame dimensions, live frame drawing |
| 4 | String Sizing | IEC 62548 basis, full workings shown, MPPT window widget |
| 5 | Paralleling | Strings per inverter vs ILR and clipping; enter PVsyst results to compare |
| 6 | Pitch & Shading | Compare your PVsyst pitch runs side by side |
| 7 | Layout | Site boundary, terrain, automatic block layout, ranked variants |
| 8 | DC cable | String and array cable: IEC derating chain, volt drop, I²R loss |
| 9 | AC cable | Inverter-to-transformer feeder, three-phase drop with R and X |
| 10 | MV cable | Collector ring runs, cumulative current, cable schedule and BOM |
| 11 | Short circuit | Fault levels and the adiabatic withstand check, with curves |
| 12 | Yield report | Pulls ERA5 / PVGIS, states expected generation, trades pitch against cable |

Three interface modes, top right:

- **Stupid** — draw a boundary, read the answer. Sensible defaults everywhere else.
- **Simple** — the full workflow, essential inputs only.
- **Engineer** — everything.

Use **Save project** / **Open** in the header to keep work between sessions
(a single `.json` file holding parameters, boundary, terrain and comparison runs).

---

## Importing a component

Module tab section 1C, or Inverter tab section 2C → **Upload .PAN / .OND or PDF**.

A PVsyst `.PAN` (module) or `.OND` (inverter) is the best input the tool can be given: it is
the manufacturer's own data already named and typed, so nothing is scraped and no column has
to be guessed. Every value shows the exact line it came from, and the module cross-check
(Pmax ≈ Vmp × Imp) runs on it just as it does on a PDF.

Two values are converted rather than read, and say so: PVsyst stores the Isc coefficient in
mA/°C and the Voc coefficient in mV/°C, while everything here works in %/°C.

One value is deliberately not trusted. An `.OND` states the MPPT *tracking* range; PVhub
sizes strings on the full-power lower bound from the P-V curve, which is a different and
higher number. The tracking bound is filled in at low confidence with a note to overwrite it.

Datasheet PDFs still work, for components with no PVsyst file.

## Importing a site

Layout tab, section 01 → **Import KMZ / KML / DXF / XYZ / CSV**.

- **KMZ / KML** straight from Google Earth. A drawn polygon becomes the boundary; a pin with
  no extent sets the site coordinates instead, which is what drives the temperature pull,
  the TMY and the yield model. Coordinates are projected to metres about the site's own
  latitude, and the import says so.
- **DXF** (ASCII, not DWG — in AutoCAD/Civil 3D use `SAVEAS` → DXF).
  One file can carry both: closed polylines are offered as boundary options,
  and POINT / 3DFACE entities are read as terrain.
- **XYZ / CSV** — one `x, y, z` per line, metres.

Gradient limits (hard and soft, along-axis and cross-axis) are set in the
Layout tab once terrain is loaded. Frames breaching a hard limit are rejected;
frames between soft and hard place with a graded penalty that feeds the
variant scores.

---

## Developing

Requires [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install     # once
npm run dev     # local dev server, hot reload
npm run build   # production build into dist/
```

Most application code lives in `src/App.jsx`. The cable and short-circuit tools
are in `src/CableTools.jsx` with their IEC reference data in `src/cableData.js`,
and the UI atoms both sides share are in `src/ui.jsx`.

---

## Hosting it online

**Option A — GitHub Pages (automatic).**
Push this repo to GitHub, then in the repo go to
*Settings → Pages → Source* and choose **GitHub Actions**.
The included workflow builds and publishes on every push to `main`;
the URL appears under *Actions* when the first run finishes.

**Option B — drag and drop.**
Run `npm run build`, then drag the `dist` folder onto
[app.netlify.com/drop](https://app.netlify.com/drop) for an instant public link.

**Option C — no build at all.**
Upload `pvhub.html` anywhere that serves files. It is entirely self-contained.

---

## Putting this on GitHub the first time

From a terminal in this folder:

```bash
git init
git add .
git commit -m "PVhub design tools"
git branch -M main
git remote add origin https://github.com/<your-username>/pvhub.git
git push -u origin main
```

Create the empty `pvhub` repository on github.com first (no README, no
`.gitignore` — this folder supplies both).

If you have the [GitHub CLI](https://cli.github.com) installed, it does the
repo creation and the push in one:

```bash
gh auth login
gh repo create pvhub --public --source=. --push
```

---

## Caveats worth knowing

- Clipping percentages on the Paralleling tab are a **parametric estimate for
  comparison only**. Enter real PVsyst figures in the adjacent column and use
  those to decide.
- The Pitch & Shading tab does not simulate. It compares PVsyst runs you enter.
- On the Yield report, the absolute yield is PVGIS's validated model and the differences
  between pitches are ours. The differences are the trustworthy half — swap the irradiance
  dataset and every pitch moves together. Treat the absolute as a figure to start a
  conversation, never as a bankable one.
- Layout cable lengths are straight-line estimates for ranking variants, not a
  cable schedule. The MV tab produces a real schedule, but from route distances
  you enter — it does not read them from the layout.
- MV cable ratings above 400 mm² are **extrapolated, not IEC data**: IEC 60502-2
  Table B.3 stops there. Those rows are flagged in the table and should be
  replaced with a manufacturer rating before anything is ordered.
- The short-circuit check is adiabatic. IEC 60949 permits a non-adiabatic credit
  for screens and long durations which is not claimed here, so screen results are
  on the safe side.
- Free global DEM data (~30 m posting) is fine for deciding which ground to
  avoid; it is not accurate enough for per-tracker slope compliance.
- Frames are axis-aligned to true north–south (or east–west for fixed tilt).
  Following a boundary is done by staggering frame ends, never by rotating
  frames, so tracking geometry and yield are preserved.
