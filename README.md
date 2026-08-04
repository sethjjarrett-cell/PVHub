# PVhub — PVhub

Browser-based tools for utility-scale PV preliminary design: parameter capture,
string sizing, string paralleling, pitch comparison, and an automatic layout
generator with terrain awareness.

Everything runs in the browser. No server, no account, no data leaves the machine.

---

## Just want to use it?

Open **`pvhub.html`** (the single-file build) in any browser. That's it — no install.

Everything below is only needed if you want to change the code or host it online.

---

## The tools

| Step | Tool | What it does |
|------|------|--------------|
| 1 | Module | Datasheet parameters, live I–V and P–V curves |
| 2 | Inverter | Voltage windows and ratings, power-vs-voltage envelope |
| 3 | Frame | Mounting type, 1P–4P, frame dimensions, live frame drawing |
| 4 | String Sizing | IEC 62548 basis, full workings shown, MPPT window widget |
| 5 | Paralleling | Strings per inverter vs ILR and clipping; enter PVsyst results to compare |
| 6 | Pitch & Shading | Compare your PVsyst pitch runs side by side |
| 7 | Layout | Site boundary, terrain, automatic block layout, ranked variants |

Three interface modes, top right:

- **Stupid** — draw a boundary, read the answer. Sensible defaults everywhere else.
- **Simple** — the full workflow, essential inputs only.
- **Engineer** — everything.

Use **Save project** / **Open** in the header to keep work between sessions
(a single `.json` file holding parameters, boundary, terrain and comparison runs).

---

## Importing a site

Layout tab, section 01 → **Import DXF / XYZ / CSV**.

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

All application code lives in `src/App.jsx`.

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
- Layout cable lengths are straight-line estimates for ranking variants, not a
  cable schedule.
- Free global DEM data (~30 m posting) is fine for deciding which ground to
  avoid; it is not accurate enough for per-tracker slope compliance.
- Frames are axis-aligned to true north–south (or east–west for fixed tilt).
  Following a boundary is done by staggering frame ends, never by rotating
  frames, so tracking geometry and yield are preserved.
