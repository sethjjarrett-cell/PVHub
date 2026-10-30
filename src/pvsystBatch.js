/* =====================================================================
   PVSYST BATCH PARAMETER FILES
   ---------------------------------------------------------------------
   Writes the CSV that PVsyst's batch mode reads, so a sweep decided here
   is simulated there. The other half of the loop already exists:
   src/batchAnalyser.js reads the results file PVsyst writes back.

   WHY THIS RATHER THAN WRITING A VARIANT. A .VCx is plain text and its
   definition is only a few hundred lines, so generating one looks
   tempting. It is not: the format is undocumented, every object carries
   a "Version=8.1.4" stamp, the Flags are opaque bitfields, and the file
   holds shading factor tables PVsyst derives from the 3D scene. Write a
   scene without regenerating those and PVsyst may simulate something
   other than what was drawn — silently. Batch mode is a documented
   feature driving a variant a human built and checked.

   WHAT IS CONFIRMED AND WHAT IS NOT. Every column heading below has been
   read off a real PVsyst batch file — a parameter template PVsyst wrote
   itself, and two results files. None came from documentation. PVsyst's
   own template says "Do not modify the column titles!", so a heading
   that is close but not exact is a sweep that silently does nothing.
   Anything not in this list is entered by hand against the parameter
   list in PVsyst's own dialog, and is marked unconfirmed in the
   interface.

   THE DELIMITER IS NOT THE SAME IN BOTH DIRECTIONS. The parameter
   template PVsyst generates is comma separated; the results file it
   writes back is semicolon separated. Both came from the same user on
   the same product. So the delimiter is a setting rather than a
   constant: it defaults to the comma PVsyst used in the template it
   expects back, and can be switched.
   ================================================================== */

/**
 * Columns whose heading has been read off a real PVsyst batch file.
 * `group`, `sub` and `unit` are the three header rows, verbatim — PVsyst
 * tells you not to modify them, so they are copied rather than tidied
 * ("azim", not "azimuth"; "in parall", not "in parallel").
 */
export const BATCH_PARAMS = [
  {
    id: "tilt", group: "Plane", sub: "tilt", unit: "deg", kind: "number", confirmed: true,
    label: "Plane tilt", dp: 1,
    note: "The collector tilt. On a tracker variant this is not the parameter to sweep.",
  },
  {
    id: "azimuth", group: "Plane", sub: "azim", unit: "deg", kind: "number", confirmed: true,
    label: "Plane azimuth", dp: 1,
    note: "PVsyst's convention: 0 is the equator-facing direction, negative is east of it.",
  },
  {
    id: "pitch", group: "Sheds 3D", sub: "pitch", unit: "m", kind: "number", confirmed: true,
    label: "Shed pitch (3D scene)", dp: 2,
    note: "Row spacing in the shading scene. PVsyst notes in the results that it set the "
      + "orientation's Pitch NS to match.",
  },
  {
    id: "nSeries", group: "Nb module", sub: "in series", unit: "", kind: "number", confirmed: true,
    label: "Modules in series", dp: 0,
    note: "String length. Check it against the string sizing tab's N_min and N_max — PVsyst "
      + "will run a string that does not fit the inverter window and only warn.",
  },
  {
    id: "nParallel", group: "Nb strings", sub: "in parall", unit: "", kind: "number", confirmed: true,
    label: "Strings in parallel", dp: 0,
    note: "Together with modules in series this sets the array size, so sweeping it sweeps "
      + "the DC/AC ratio.",
  },
  {
    id: "nInverter", group: "Nb inverter", sub: "or MPPT", unit: "", kind: "number", confirmed: true,
    label: "Inverters (or MPPTs)", dp: 0,
    note: "The other half of the DC/AC ratio.",
  },
  {
    id: "ondFile", group: "Inverter", sub: "*.OND File", unit: "Filename", kind: "text",
    confirmed: true, label: "Inverter model (.OND)",
    note: "A filename, not a number — the .OND must already be in PVsyst's component "
      + "database on the machine that runs the batch.",
  },
];

export const paramById = (id) => BATCH_PARAMS.find((p) => p.id === id) || null;

/** A column the user typed from PVsyst's batch dialog, for anything the
    confirmed list does not cover. */
export function customParam(group, sub, unit, label) {
  const g = String(group || "").trim();
  if (!g) return null;
  return {
    id: `custom:${g}|${String(sub || "").trim()}`,
    group: g, sub: String(sub || "").trim(), unit: String(unit || "").trim(),
    label: label || [g, sub].filter(Boolean).join(" "), confirmed: false,
    note: "Typed by hand — check the heading against PVsyst's batch parameter list.",
  };
}

/* ---------- what a prelim actually sweeps ---------------------------
   Two of the things worth sweeping are not PVsyst batch columns at all,
   and have to be converted into ones that are.

   ROW SPACING is specified as the clear gap between rows — the daylight
   on the ground between the back of one row's shadow footprint and the
   front of the next — because that is what a site walk and a mounting
   supplier talk about. PVsyst wants the pitch, axis to axis. The two
   differ by the collector's horizontal projection, which depends on the
   tilt, so sweeping tilt and gap together gives a DIFFERENT pitch on
   every row. That is why the pitch column is computed per case rather
   than being a value list of its own.

   A tracker has no fixed gap — the panels rotate, so the daylight
   between them changes through the day. There the pitch is swept
   directly, which is also how trackers are specified.

   DC/AC RATIO is not a PVsyst parameter either, and it cannot be swept
   as one. It is the array against the inverters, and both sides move in
   whole units: you cannot buy 0.4 of a string or 0.3 of an inverter. So
   the ratio is not stepped directly — stepping a *target* and rounding
   to the nearest string manufactures values the plant cannot reach and
   runs the same simulation twice under two different labels.

   What is stepped is whichever whole thing is actually free to move,
   and that depends on which side is fixed:

     AC fixed (the grid connection sets the export limit)
       -> step the STRINGS. Each one adds a fixed slice of DC, so the
          ratio climbs in even increments.

     DC fixed (the site or the layout sets the array)
       -> step the INVERTERS. Each one adds a block of AC, so the ratio
          falls, and in larger jumps than a string gives.

   Every reachable ratio therefore appears exactly once, and the
   interface shows what each step actually lands on, so the granularity
   is visible rather than discovered afterwards.
   ------------------------------------------------------------------ */

/** Typical DC/AC bands by mount type. These are the user's working
    numbers, not a standard — a tracker's flatter production profile
    means more hours near the inverter limit, so it clips sooner and
    wants a lower ratio than fixed tilt; an east-west pair shares one
    inverter between two faces that peak at different times, so it
    carries more. */
export const MOUNTS = [
  { id: "fixed", label: "Fixed tilt", dcac: [1.10, 1.40], spacing: "gap",
    note: "Row spacing given as the clear gap; the pitch follows from the tilt." },
  { id: "tracker", label: "Horizontal single-axis tracker", dcac: [1.05, 1.30], spacing: "pitch",
    note: "No fixed gap to quote, because the panels rotate. Pitch is swept directly." },
  { id: "ew", label: "East-west", dcac: [1.10, 1.60], spacing: "gap",
    note: "Two faces on one inverter, peaking at different times, so it carries a higher ratio." },
];
export const mountById = (id) => MOUNTS.find((m) => m.id === id) || MOUNTS[0];

/** The clear gap a sweep steps through, in metres. */
export const GAP_DEFAULT = { from: 2.5, to: 5.0, step: 0.5 };

/**
 * Pitch from the clear gap.
 *   pitch = gap + L cos(tilt)
 * L cos(tilt) is the collector's horizontal projection, which is the
 * ground the row itself occupies; the gap is the daylight after it.
 */
export function pitchFromGap(gapM, collectorWidthM, tiltDeg) {
  const g = Number(gapM), L = Number(collectorWidthM), t = Number(tiltDeg);
  if (![g, L, t].every(Number.isFinite) || L <= 0) return null;
  return Math.round((g + L * Math.cos((t * Math.PI) / 180)) * 1000) / 1000;
}

/** Ground cover ratio for a pitch, as a percentage — the figure PVsyst
    reports back, so it is worth showing beside the gap that produced it. */
export function gcrFor(collectorWidthM, pitchM) {
  const L = Number(collectorWidthM), p = Number(pitchM);
  if (!Number.isFinite(L) || !Number.isFinite(p) || p <= 0) return null;
  return Math.round((L / p) * 1000) / 10;
}

/** The two things that can actually be stepped, and which side each
    one holds still. */
export const DCAC_MODES = [
  { id: "strings", label: "AC is fixed \u2014 step the strings",
    param: "nParallel", holds: "The grid connection sets the export, so the inverters stay "
      + "put and the array grows. Each string is an even increment, so the ratio climbs "
      + "smoothly." },
  { id: "inverters", label: "DC is fixed \u2014 step the inverters",
    param: "nInverter", holds: "The site or the layout sets the array, so the DC stays put "
      + "and the inverter count changes. Each inverter is a block of AC, so the ratio falls "
      + "in bigger jumps than a string gives." },
];

/** DC/AC for a given whole-unit configuration. */
export function ratioFor(sys) {
  const { moduleWp, modulesInSeries, nParallel, inverterKwac, nInverter } = sys || {};
  if (![moduleWp, modulesInSeries, nParallel, inverterKwac, nInverter].every(Number.isFinite)) return null;
  const dcKwp = (nParallel * modulesInSeries * moduleWp) / 1000;
  const acKw = nInverter * inverterKwac;
  if (acKw <= 0) return null;
  return { dcKwp: Math.round(dcKwp * 10) / 10, acKw,
    ratio: Math.round((dcKwp / acKw) * 1000) / 1000 };
}

/**
 * The whole-unit range that covers a DC/AC band, so the interface can
 * suggest where to start rather than making the user solve it. Returns
 * inclusive integer bounds, widened outwards so the band is covered
 * rather than clipped.
 */
export function unitRangeForBand(mode, band, sys) {
  const [lo, hi] = band || [];
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  const { moduleWp, modulesInSeries, inverterKwac, nInverter, nParallel } = sys || {};
  if (mode === "strings") {
    const acKw = nInverter * inverterKwac;
    const perString = (modulesInSeries * moduleWp) / 1000;
    if (!Number.isFinite(acKw) || !Number.isFinite(perString) || acKw <= 0 || perString <= 0) return null;
    return { from: Math.max(1, Math.floor((lo * acKw) / perString)),
      to: Math.max(1, Math.ceil((hi * acKw) / perString)), step: 1 };
  }
  const dcKwp = (nParallel * modulesInSeries * moduleWp) / 1000;
  if (!Number.isFinite(dcKwp) || !Number.isFinite(inverterKwac) || inverterKwac <= 0 || dcKwp <= 0) return null;
  /* More inverters is a LOWER ratio, so the band's top bound gives the
     smallest inverter count and vice versa. */
  return { from: Math.max(1, Math.floor(dcKwp / (hi * inverterKwac))),
    to: Math.max(1, Math.ceil(dcKwp / (lo * inverterKwac))), step: 1 };
}

/**
 * Strings in parallel for a target DC/AC ratio, and the ratio that
 * whole number actually gives. Kept for the suggestion above and for
 * answering "what string count is 1.2 on this array" — not used to
 * generate a sweep, for the reason in the header.
 */
export function stringsForRatio(target, sys) {
  const { moduleWp, modulesInSeries, inverterKwac, nInverter } = sys || {};
  const r = Number(target);
  if (![r, moduleWp, modulesInSeries, inverterKwac, nInverter].every(Number.isFinite)) return null;
  const acKw = nInverter * inverterKwac;
  const perString = (modulesInSeries * moduleWp) / 1000;
  if (acKw <= 0 || perString <= 0) return null;
  const strings = Math.max(1, Math.round((r * acKw) / perString));
  const achieved = Math.round(((strings * perString) / acKw) * 1000) / 1000;
  return { strings, achieved, dcKwp: Math.round(strings * perString * 10) / 10, acKw };
}

/* ---------- building the sweep ------------------------------------- */

/** Inclusive range. Steps are generated by multiplication rather than
    repeated addition so a 0.1 step does not drift into 10.299999999. */
export function range(from, to, step) {
  const a = Number(from), b = Number(to), s = Math.abs(Number(step));
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(s) || s === 0) return [];
  if (a === b) return [a];
  const dir = b > a ? 1 : -1;
  const n = Math.floor(Math.abs(b - a) / s + 1e-9);
  const out = [];
  for (let i = 0; i <= n; i++) out.push(Math.round((a + dir * i * s) * 1e6) / 1e6);
  return out;
}

/**
 * Every combination of the given parameter value lists, in the order
 * PVsyst's own files use: the last parameter varies fastest.
 * @param {Array<{param:object, values:number[]}>} axes
 */
export function sweepRows(axes) {
  const live = axes.filter((a) => a && a.param && a.values && a.values.length);
  if (!live.length) return [];
  let rows = [[]];
  for (const a of live) {
    const next = [];
    for (const r of rows) for (const v of a.values) next.push([...r, v]);
    rows = next;
  }
  return rows;
}

/**
 * Plan a preliminary sweep: the gap and the DC/AC target are converted
 * into the columns PVsyst actually has, and every case carries what it
 * was asked for beside what it achieved.
 *
 * Returns explicit columns and rows rather than axes, because the pitch
 * is not a value list — it depends on the tilt of the case it is in.
 */
export function buildSweep(spec = {}) {
  const {
    mount = "fixed", tilt = {}, spacing = {}, dcac = {},
    baseTilt = 20, sys = {}, extraAxes = [],
  } = spec;
  const m = mountById(mount);
  const warnings = [];

  const tiltVals = tilt.on ? range(tilt.from, tilt.to, tilt.step) : [];
  const spaceVals = spacing.on ? range(spacing.from, spacing.to, spacing.step) : [];
  /* Whole units, not ratios: strings when the AC is fixed, inverters
     when the DC is. Every value here is reachable by construction. */
  const dcMode = dcac.mode === "inverters" ? "inverters" : "strings";
  const unitVals = dcac.on
    ? range(dcac.from, dcac.to, Math.max(1, Math.round(dcac.step || 1)))
        .map((v) => Math.max(1, Math.round(v)))
    : [];
  const extras = extraAxes.filter((a) => a && a.param && a.values && a.values.length);

  /* The tilt that converts a gap to a pitch. On a swept tilt it is the
     case's own; otherwise the single value the variant is built at. */
  const tiltFor = (t) => (t === null || t === undefined ? baseTilt : t);

  const columns = [];
  if (tiltVals.length) columns.push(paramById("tilt"));
  if (spaceVals.length) columns.push(paramById("pitch"));
  if (unitVals.length) columns.push(paramById(dcMode === "inverters" ? "nInverter" : "nParallel"));
  for (const a of extras) columns.push(a.param);

  if (!columns.length) return { columns: [], rows: [], cases: [], warnings };

  if (m.spacing === "gap" && spaceVals.length && !(sys.collectorWidthM > 0)) {
    warnings.push("A collector width is needed to turn a clear gap into the pitch PVsyst "
      + "wants. Enter it, or switch the spacing to a pitch.");
    return { columns: [], rows: [], cases: [], warnings };
  }
  if (unitVals.length) {
    const probe = dcMode === "inverters"
      ? ratioFor({ ...sys, nInverter: unitVals[0] })
      : ratioFor({ ...sys, nParallel: unitVals[0] });
    if (!probe) {
      warnings.push("Working out the DC/AC of each step needs the module rating, the modules "
        + "in series, the inverter rating, and whichever of the string count or inverter "
        + "count is being held fixed.");
      return { columns: [], rows: [], cases: [], warnings };
    }
  }

  /* Nested loops rather than a cartesian helper, because the pitch of a
     case depends on the tilt of that same case. */
  const cases = [];
  const forEachTilt = tiltVals.length ? tiltVals : [null];
  const forEachSpace = spaceVals.length ? spaceVals : [null];
  const forEachUnit = unitVals.length ? unitVals : [null];
  const extraRows = extras.length ? sweepRows(extras) : [[]];

  for (const t of forEachTilt) {
    for (const sp of forEachSpace) {
      for (const d of forEachUnit) {
        for (const ex of extraRows) {
          const c = { tilt: t, extras: ex };
          if (sp !== null) {
            if (m.spacing === "gap") {
              c.gap = sp;
              c.pitch = pitchFromGap(sp, sys.collectorWidthM, tiltFor(t));
            } else {
              c.pitch = sp;
            }
            c.gcr = gcrFor(sys.collectorWidthM, c.pitch);
          }
          if (d !== null) {
            const cfg = dcMode === "inverters"
              ? { ...sys, nInverter: d } : { ...sys, nParallel: d };
            const r = ratioFor(cfg);
            c.dcMode = dcMode;
            c.unit = d;
            if (dcMode === "inverters") c.nInverter = d; else c.strings = d;
            c.dcac = r.ratio;
            c.dcKwp = r.dcKwp;
            c.acKw = r.acKw;
          }
          cases.push(c);
        }
      }
    }
  }

  /* A row is the values PVsyst sees. Two DC/AC targets that round to the
     same string count are the same simulation, so they collapse — and
     the duplicate is reported rather than silently dropped, because the
     user asked for both. */
  const rowOf = (c) => {
    const v = [];
    if (tiltVals.length) v.push(c.tilt);
    if (spaceVals.length) v.push(c.pitch);
    if (unitVals.length) v.push(c.unit);
    v.push(...c.extras);
    return v;
  };
  /* Whole units cannot collide the way rounded ratio targets did, so
     there is nothing to merge; the guard stays because an extra axis
     could still repeat a combination. */
  const seen = new Set();
  const rows = [];
  const kept = [];
  for (const c of cases) {
    const v = rowOf(c);
    const k = v.join("|");
    if (seen.has(k)) continue;
    seen.add(k);
    rows.push(v);
    kept.push(c);
  }

  if (unitVals.length) {
    const rs = kept.map((c) => c.dcac).filter((x) => Number.isFinite(x));
    if (rs.length) {
      const lo = Math.min(...rs), hi = Math.max(...rs);
      const [bl, bh] = m.dcac;
      if (hi < bl || lo > bh) {
        warnings.push(`This sweep covers DC/AC ${lo} to ${hi}, which is outside the `
          + `${bl} to ${bh} that is typical for ${m.label.toLowerCase()}. That may be `
          + "deliberate, but check the unit range.");
      }
      const steps = [...new Set(rs)].sort((a, b) => a - b);
      if (steps.length > 1) {
        const gap = Math.round((steps[1] - steps[0]) * 1000) / 1000;
        if (gap > 0.1) {
          warnings.push(`Each step moves the ratio by about ${gap}, because `
            + `${dcMode === "inverters" ? "an inverter" : "a string"} is an indivisible `
            + "block on this plant. Nothing between those values can be built, so nothing "
            + "between them is worth simulating.");
        }
      }
    }
  }

  return { columns, rows, cases: kept, warnings, mount: m };
}

/* ---------- writing the file --------------------------------------- */

/* PVsyst's own parameter template is comma separated and its results
   file is semicolon separated. Default to the comma, because the file
   written here is the one PVsyst reads. */
export const DELIMITERS = [
  { id: ",", label: "Comma (what PVsyst's own template uses)" },
  { id: ";", label: "Semicolon (what its results files use)" },
];

const cellFor = (delim) => (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  /* PVsyst does not quote, but a comment carrying the delimiter would
     add a column and shift every value after it. Quote only then. */
  return s.includes(delim) || s.includes('"') || s.includes("\n")
    ? `"${s.replace(/"/g, '""')}"` : s;
};

const pad = (row, width) => {
  const out = row.slice();
  while (out.length < width) out.push("");
  return out;
};

/** dd/mm/yy hh:mm, the format PVsyst stamps its own files with. */
export function pvsystStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${p(d.getFullYear() % 100)} `
    + `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* The lines PVsyst puts in its own template, verbatim. They are
   instructions to the person editing the file in Excel, and they are
   reproduced so the file PVhub writes looks like the one PVsyst would
   have written — including the warning not to touch the column titles,
   which is exactly why the headings above are copied rather than
   tidied. Written raw: the quotes around SIM_ are literal and must not
   be escaped into "" pairs. */
const PREAMBLE_NOTES = [
  "Please define the parameters to be varied for each run",
  "Do not modify the column titles!",
  'Only the lines beginning by "SIM_" will be executed',
];
const FOOTER_NOTE =
  "Do not forget to close this file in Excel before returning to PVsyst "
  + "to initiate the simulation !";

/**
 * Build the batch parameter CSV.
 *
 * The layout follows the template PVsyst generates: a labelled preamble,
 * its own instruction lines, three header rows (name, detail, unit),
 * then one SIM_n row per case, then a footer. PVsyst finds the header by
 * content, so the preamble length is not critical, but matching it keeps
 * the file recognisable to whoever opens it in Excel.
 *
 * Result columns are deliberately NOT written: PVsyst's own template has
 * none, and appends them when it writes the results file back.
 */
export function buildBatchParamsCsv({
  project = "", baseVariant = "", variantComment = "",
  axes = [], columns = null, rows: givenRows = null,
  comment = "", created = null, delimiter = ",",
} = {}) {
  const d = delimiter === ";" ? ";" : ",";
  const cell = cellFor(d);
  /* Either a set of independent axes to multiply out, or explicit
     columns and rows — the latter because a planned sweep computes some
     values per case rather than listing them (buildSweep). */
  let params, rows;
  if (columns && givenRows) {
    params = columns;
    rows = givenRows;
  } else {
    const live = axes.filter((a) => a && a.param && a.values && a.values.length);
    rows = sweepRows(live);
    params = live.map((a) => a.param);
  }

  const groups = ["Ident", ...params.map((p) => p.group), "Simul"];
  const subs = ["", ...params.map((p) => p.sub), "Comment"];
  const units = ["", ...params.map((p) => (p.unit ? (p.kind === "text" ? p.unit : `[${p.unit}]`) : "")), ""];
  const width = groups.length;

  const blank = () => pad([], width).join(d);
  /* A whole-row note sits in the first cell with the rest empty, and is
     written without quoting so PVsyst's own wording survives byte for
     byte. It contains no delimiter, which is why that is safe. */
  const note = (text) => pad([text], width).join(d);

  const out = [
    note("PVsyst simulations Batch mode"),
    note("Simulation parameters definition"),
    note(`File created on ${created || pvsystStamp()}`),
    blank(),
    pad(["Project", "", "", project], width).map(cell).join(d),
    pad(["Variants based on", "", baseVariant, variantComment], width).map(cell).join(d),
    blank(),
    ...PREAMBLE_NOTES.map(note),
    blank(),
    pad(groups, width).map(cell).join(d),
    pad(subs, width).map(cell).join(d),
    pad(units, width).map(cell).join(d),
    blank(),
    ...rows.map((vals, i) => pad([`SIM_${i + 1}`, ...vals, comment], width).map(cell).join(d)),
    /* Three blank rows before the footer, as PVsyst leaves — room to add
       a case by hand in Excel without disturbing the footer. */
    blank(), blank(), blank(),
    note(FOOTER_NOTE),
  ];

  return out.join("\r\n") + "\r\n";
}

/** Read one back, so a file written here survives a round trip and a
    file exported from PVsyst can be loaded as a starting point. */
export function parseBatchParamsCsv(text) {
  const lines = String(text || "").split(/\r?\n/);
  /* Detected, not assumed: PVsyst's template is comma separated and its
     results files are semicolon separated. Count on the header row
     rather than the whole file, because the preamble prose contains
     commas of its own. */
  const headLine = lines.find((l) => /^Ident[,;]/.test(l)) || "";
  const d = (headLine.match(/;/g) || []).length > (headLine.match(/,/g) || []).length ? ";" : ",";
  const rows = lines.map((l) => {
    const out = []; let cur = "", inQ = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (inQ) { if (c === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += c; }
      else if (c === '"') inQ = true;
      else if (c === d) { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  });

  const h = rows.findIndex((r) => (r[0] || "").toLowerCase() === "ident");
  if (h < 0) {
    return { ok: false, error: 'No header row found — a PVsyst batch file has a row whose first cell is "Ident".' };
  }
  const groups = rows[h] || [], subs = rows[h + 1] || [], units = rows[h + 2] || [];
  const preamble = rows.slice(0, h);
  const byLabel = (re) => {
    const r = preamble.find((q) => re.test(q[0] || ""));
    return r ? (r.slice(1).find((c) => c) || null) : null;
  };
  const variantRow = preamble.find((q) => /variants based on/i.test(q[0] || ""));

  const iSimul = groups.findIndex((g) => (g || "").toLowerCase() === "simul");
  const end = iSimul > 0 ? iSimul : groups.length;
  const params = [];
  for (let i = 1; i < end; i++) {
    const group = (groups[i] || "").trim();
    if (!group) continue;
    params.push({
      index: i, group, sub: (subs[i] || "").trim(),
      unit: (units[i] || "").replace(/^\[|\]$/g, "").trim(),
    });
  }

  const cases = [];
  for (let r = h + 3; r < rows.length; r++) {
    const id = (rows[r][0] || "").trim();
    if (!/^SIM_/i.test(id)) continue;
    cases.push({
      ident: id,
      values: params.map((p) => {
        const v = parseFloat(String(rows[r][p.index] || "").replace(",", "."));
        return Number.isFinite(v) ? v : null;
      }),
      comment: iSimul > 0 ? (rows[r][iSimul] || "").trim() : "",
    });
  }

  return {
    ok: true,
    project: byLabel(/^project$/i),
    baseVariant: variantRow ? (variantRow.slice(1).find((c) => c) || null) : null,
    variantComment: variantRow ? (variantRow.slice(1).filter((c) => c)[1] || null) : null,
    params, cases,
  };
}

/** What the user has to do in PVsyst, written out so it is not folklore. */
export function runInstructions({ project, baseVariant, fileName }) {
  return [
    `Open ${project || "the project"} in PVsyst and load the variant the sweep is based on`
      + `${baseVariant ? ` (${baseVariant})` : ""}.`,
    "Open the simulation dialog and tick “Batch simulation”.",
    `Point it at ${fileName || "this file"} as the parameter file.`,
    "Check that every swept column is matched to a parameter — PVsyst lists them, and an "
      + "unmatched heading simulates the base case unchanged rather than failing.",
    "Choose the output variables. ShdLoss, IL_Pmax, PR and E_Grid are what the analyser "
      + "here reads; E_Grid is the one it cannot work without.",
    "Run it, then drop the results file PVsyst writes back into the panel below.",
  ];
}
