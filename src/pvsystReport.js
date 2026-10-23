/* =====================================================================
   PVSYST SIMULATION REPORT READER
   ---------------------------------------------------------------------
   Reads the text of an exported PVsyst "Simulation report" PDF into one
   project record, so a run of preliminary designs can be compared on
   what they actually yielded rather than on memory.

   Two rules shape the whole file.

   FIRST: nothing is defaulted. A report for a tracker plant, a different
   PVsyst version, or a grid-feed variant rather than a self-consumption
   one carries a different set of rows, and a reader that quietly
   substitutes a zero for a row it could not find produces a tracker
   whose comparisons are fiction. Every field that is looked for and not
   found is listed in `missing`, and the interface says so.

   SECOND: every value carries the line it was read from, in `src`. The
   same convention as the derating tools — a number you cannot trace is
   a number you cannot defend in a review.

   The loss diagram is read generically rather than against a list of
   known rows: any "-3.00% Soiling loss factor" line becomes an entry.
   That is deliberate, because it is the one part of the report whose
   row set varies most between system types, and an unknown row is far
   more useful captured than dropped.
   ================================================================== */

/* ---------- small helpers ------------------------------------------ */

const num = (s) => {
  if (s === undefined || s === null) return null;
  const v = parseFloat(String(s).replace(/\s+/g, "").replace(",", "."));
  return Number.isFinite(v) ? v : null;
};

/** PVsyst writes dates as dd/mm/yy. Parsed to ISO so records sort, with
    the window pinned: a two-digit year is 2000-2099 here, because these
    are simulation reports and none of them predate PVsyst itself. */
export function parsePvsystDate(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{2})(?:\s+(\d{2}):(\d{2}))?/.exec(String(s || "").trim());
  if (!m) return null;
  const [, d, mo, y, hh, mi] = m;
  const yr = 2000 + Number(y);
  const iso = `${yr}-${mo}-${d}`;
  const dt = new Date(`${iso}T${hh || "00"}:${mi || "00"}:00Z`);
  if (Number.isNaN(dt.getTime())) return null;
  return { iso, at: `${iso} ${hh || "00"}:${mi || "00"}`, ms: dt.getTime() };
}

/* ---------- the field catalogue ------------------------------------
   One entry per tracked parameter: how to display it, and whether it is
   a headline worth a column in the comparison table. `dp` is the
   decimal count for the shared rounding helper — stated, never guessed
   at render time. */
export const REPORT_FIELDS = [
  { key: "project", label: "Project", group: "id", kind: "text", headline: true },
  { key: "variant", label: "Variant", group: "id", kind: "text" },
  { key: "author", label: "Author", group: "id", kind: "text" },
  { key: "pvsystVersion", label: "PVsyst version", group: "id", kind: "text" },
  { key: "simulatedAt", label: "Simulated", group: "id", kind: "text" },
  { key: "systemKind", label: "System", group: "id", kind: "text" },
  { key: "mounting", label: "Mounting", group: "id", kind: "text" },

  { key: "siteName", label: "Site", group: "site", kind: "text" },
  { key: "country", label: "Country", group: "site", kind: "text", headline: true },
  { key: "lat", label: "Latitude", group: "site", unit: "°", dp: 4 },
  { key: "lon", label: "Longitude", group: "site", unit: "°", dp: 4 },
  { key: "altitude", label: "Altitude", group: "site", unit: "m", dp: 0 },
  { key: "timezone", label: "Time zone", group: "site", kind: "text" },
  { key: "albedo", label: "Albedo", group: "site", dp: 2 },
  { key: "weatherSource", label: "Weather data", group: "site", kind: "text" },

  { key: "pnomDc", label: "DC capacity", group: "size", unit: "kWp", dp: 0, headline: true },
  { key: "pnomAc", label: "AC capacity", group: "size", unit: "kWac", dp: 0, headline: true },
  { key: "pnomRatio", label: "DC/AC ratio", group: "size", dp: 2, headline: true },
  { key: "moduleCount", label: "Modules", group: "size", unit: "units", dp: 0 },
  { key: "inverterCount", label: "Inverters", group: "size", unit: "units", dp: 0 },
  { key: "moduleArea", label: "Module area", group: "size", unit: "m²", dp: 0 },
  { key: "moduleMfr", label: "Module make", group: "size", kind: "text" },
  { key: "moduleModel", label: "Module model", group: "size", kind: "text" },
  { key: "moduleWp", label: "Module rating", group: "size", unit: "Wp", dp: 0 },
  { key: "moduleEffPct", label: "Module efficiency", group: "size", unit: "%", dp: 2 },
  { key: "inverterMfr", label: "Inverter make", group: "size", kind: "text" },
  { key: "inverterModel", label: "Inverter model", group: "size", kind: "text" },
  { key: "inverterKwac", label: "Inverter rating", group: "size", unit: "kWac", dp: 0 },
  { key: "modulesInSeries", label: "Modules in series", group: "size", unit: "", dp: 0 },
  { key: "stringCount", label: "Strings", group: "size", unit: "", dp: 0 },

  { key: "tilt", label: "Tilt", group: "geom", unit: "°", dp: 1, headline: true },
  { key: "azimuth", label: "Azimuth", group: "geom", unit: "°", dp: 1 },
  { key: "orientationCount", label: "Orientations", group: "geom", unit: "", dp: 0 },
  { key: "gcr", label: "GCR", group: "geom", unit: "%", dp: 1 },
  { key: "pitch", label: "Row pitch", group: "geom", unit: "m", dp: 2 },
  { key: "nearShadingModel", label: "Near shading model", group: "geom", kind: "text" },
  { key: "ucConst", label: "Thermal Uc", group: "geom", unit: "W/m\u00B2K", dp: 1 },
  { key: "uvWind", label: "Thermal Uv", group: "geom", unit: "W/m\u00B2K/m/s", dp: 1 },
  { key: "arrayResMohm", label: "Array resistance", group: "geom", unit: "m\u03A9", dp: 0 },

  { key: "producedKwh", label: "Produced energy", group: "yield", unit: "kWh/yr", dp: 0, headline: true },
  { key: "specificYield", label: "Specific yield", group: "yield", unit: "kWh/kWp/yr", dp: 0, headline: true },
  { key: "pr", label: "Performance ratio", group: "yield", unit: "%", dp: 2, headline: true },
  { key: "usedKwh", label: "Used energy", group: "yield", unit: "kWh/yr", dp: 0 },
  { key: "solarFraction", label: "Solar fraction", group: "yield", unit: "%", dp: 2 },
  { key: "globHor", label: "Global horizontal", group: "yield", unit: "kWh/m²", dp: 1 },
  { key: "globInc", label: "Global incident", group: "yield", unit: "kWh/m²", dp: 1 },
  { key: "globEff", label: "Effective global", group: "yield", unit: "kWh/m²", dp: 1 },
  { key: "tAmb", label: "Ambient temperature", group: "yield", unit: "°C", dp: 1 },
];

export const FIELD_BY_KEY = Object.fromEntries(REPORT_FIELDS.map((f) => [f.key, f]));

export const FIELD_GROUPS = [
  ["id", "Identity"], ["site", "Site"], ["size", "Size and equipment"],
  ["geom", "Geometry and shading"], ["yield", "Yield"],
];

/* Loss rows worth naming in the interface. Anything not listed is still
   captured from the diagram and shown under its PVsyst wording — the
   point of the generic reader. */
export const LOSS_ALIASES = [
  [/global incident in coll/i, "Transposition gain"],
  [/near shading/i, "Near shading"],
  [/soiling/i, "Soiling"],
  [/^IAM/i, "IAM (incidence)"],
  [/irradiance level/i, "Irradiance level"],
  [/due to temperature/i, "Temperature"],
  [/module quality/i, "Module quality"],
  [/LID/i, "LID"],
  [/mismatch loss, modules/i, "Mismatch"],
  [/ohmic wiring/i, "DC wiring"],
  [/mixed orientation/i, "Mixed orientation"],
  [/inverter loss during operation/i, "Inverter efficiency"],
  [/inverter loss over nominal inv\. power/i, "Inverter clipping"],
  [/inverter loss due to max\. input current/i, "Inverter current limit"],
  [/inverter loss over nominal inv\. voltage/i, "Inverter voltage limit"],
  [/night consumption/i, "Night consumption"],
  [/AC ohmic/i, "AC wiring"],
  [/unused energy/i, "Unused energy"],
];

const aliasFor = (label) => {
  for (const [re, name] of LOSS_ALIASES) if (re.test(label)) return name;
  return null;
};

/* ---------- the reader --------------------------------------------- */

/**
 * Parse the extracted text of a PVsyst simulation report.
 * @param {string} text  output of extractPdfText
 * @returns {object} record with `fields`, `src`, `losses`, `monthly`,
 *   `orientations`, `missing`, `warnings` and `ok`.
 */
export function parsePvsystReport(text) {
  const raw = String(text || "");
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length);
  const fields = {};
  const src = {};
  const missing = [];
  const warnings = [];

  /* Find the first line matching `re` and pull a capture out of it.
     Records the source line on success and the field name on failure,
     which is the whole honesty mechanism. */
  const grab = (key, re, pick = 1, cast = (s) => s.trim()) => {
    for (const l of lines) {
      const m = re.exec(l);
      if (m && m[pick] !== undefined) {
        const v = cast(m[pick]);
        if (v !== null && v !== "" && !(typeof v === "number" && Number.isNaN(v))) {
          fields[key] = v;
          src[key] = l;
          return v;
        }
      }
    }
    missing.push(key);
    return null;
  };
  const grabNum = (key, re, pick = 1) => grab(key, re, pick, num);

  const isReport = /PVsyst/i.test(raw) && /Simulation report|Project:/i.test(raw);
  if (!isReport) {
    return { ok: false, fields, src, losses: [], monthly: [], orientations: [],
      missing, warnings,
      error: "This does not look like a PVsyst simulation report — no PVsyst header found." };
  }

  /* --- identity --- */
  grab("pvsystVersion", /^PVsyst\s+V([\d.]+)/);
  grab("project", /^Project:\s*(.+)$/);
  grab("variant", /^Variant:\s*(.+)$/);
  grab("simulatedAt", /^(\d{2}\/\d{2}\/\d{2}\s+\d{2}:\d{2})$/);
  grab("author", /Licensed to\s+(.+?)\s+Page\s+\d+\/\d+/);
  grab("systemKind", /^(Grid-Connected System|Stand alone system|Pumping system)\b/);
  /* The mounting phrase sits beside the system type on the summary line
     ("Grid-Connected System Tables on a building"), which is also where
     a ground plant says "Ground-based" or names its tracker. */
  grab("mounting", /^(?:Grid-Connected System|Stand alone system)\s+(.+)$/);

  /* --- site --- */
  grabNum("lat", /Latitude\s+(-?[\d.]+)\s*°/);
  grabNum("lon", /Longitude\s+(-?[\d.]+)\s*°/);
  grabNum("altitude", /Altitude\s+(-?[\d.]+)\s*m\b/);
  grab("timezone", /Time zone\s+(UTC[+\-]?[\d.]*)/);
  grabNum("albedo", /Albedo\s+([\d.]+)/);
  /* The site name shares its line with Latitude, and the country sits on
     the Longitude line — a quirk of the two-column summary block. */
  grab("siteName", /^(.+?)\s+Latitude\s+-?[\d.]+/);
  grab("country", /^(.+?)\s+Longitude\s+-?[\d.]+/);
  grab("weatherSource", /^((?:Solargis|Meteonorm|PVGIS|NASA|TMY|SolarAnywhere|Custom)\b.*)$/i);

  /* --- size and equipment --- */
  grabNum("moduleCount", /Nb\. of modules\s+([\d\s]+)\s*units/);
  grabNum("pnomDc", /Pnom total\s+([\d\s.]+)\s*kWp/);
  grabNum("inverterCount", /Nb\. of units\s+([\d\s]+)\s*units/);
  grabNum("pnomAc", /Total power\s+([\d\s.]+)\s*kWac/);
  grabNum("pnomRatio", /Pnom ratio\s+([\d.]+)\s*$/);
  grabNum("moduleArea", /Module area\s+([\d\s.]+)\s*m²/);
  grabNum("moduleWp", /Unit Nom\. Power\s+([\d\s.]+)\s*Wp\b/);
  grabNum("inverterKwac", /Unit Nom\. Power\s+([\d\s.]+)\s*kWac\b/);
  /* "Modules 56 units x 18 In series" — strings first, then the series
     count. Both matter: the series count is what the string-sizing tool
     would have produced, so a disagreement is worth seeing. */
  grabNum("stringCount", /Modules\s+([\d\s]+)\s*units\s*x\s*[\d\s]+\s*In series/);
  grabNum("modulesInSeries", /Modules\s+[\d\s]+\s*units\s*x\s*([\d\s]+)\s*In series/);

  /* Manufacturer and Model appear twice on one physical line, PV array
     column first and inverter column second, because the report sets
     them side by side. Take them in that order, and fall back to a lone
     occurrence for reports that break the columns apart. */
  const twoCol = (key1, key2, word) => {
    const both = lines.find((l) => new RegExp(`${word}\\s+\\S.*\\s${word}\\s+\\S`).test(l));
    if (both) {
      const m = new RegExp(`${word}\\s+(.+?)\\s+${word}\\s+(.+)$`).exec(both);
      if (m) {
        fields[key1] = m[1].trim(); src[key1] = both;
        fields[key2] = m[2].trim(); src[key2] = both;
        return;
      }
    }
    const one = lines.find((l) => new RegExp(`^${word}\\s+\\S`).test(l));
    if (one) {
      fields[key1] = new RegExp(`^${word}\\s+(.+)$`).exec(one)[1].trim();
      src[key1] = one;
      missing.push(key2);
    } else { missing.push(key1); missing.push(key2); }
  };
  twoCol("moduleMfr", "inverterMfr", "Manufacturer");
  twoCol("moduleModel", "inverterModel", "Model");

  /* --- geometry --- */
  const orientations = [];
  for (const l of lines) {
    const m = /Tilt\/Azimuth\s+(-?[\d.]+)\s*\/\s*(-?[\d.]+)\s*°/.exec(l);
    if (!m) continue;
    const o = { tilt: num(m[1]), azimuth: num(m[2]), line: l };
    /* A line can carry both orientations side by side. */
    const second = /Tilt\/Azimuth\s+-?[\d.]+\s*\/\s*-?[\d.]+\s*°\s+Tilt\/Azimuth\s+(-?[\d.]+)\s*\/\s*(-?[\d.]+)/.exec(l);
    orientations.push(o);
    if (second) orientations.push({ tilt: num(second[1]), azimuth: num(second[2]), line: l });
  }
  /* The same orientation is restated on the general-parameters page, so
     collapse duplicates rather than reporting a two-plane roof as four. */
  const seen = new Set();
  const uniqOrient = orientations.filter((o) => {
    const k = `${o.tilt}|${o.azimuth}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  if (uniqOrient.length) {
    fields.tilt = uniqOrient[0].tilt; src.tilt = uniqOrient[0].line;
    fields.azimuth = uniqOrient[0].azimuth; src.azimuth = uniqOrient[0].line;
    fields.orientationCount = uniqOrient.length;
    src.orientationCount = uniqOrient[0].line;
  } else { missing.push("tilt", "azimuth", "orientationCount"); }

  grabNum("gcr", /GCR Shading\s+([\d.]+)\s*%/);
  grabNum("pitch", /Sheds spacing\s+([\d.]+)\s*m\b/);
  grab("nearShadingModel", /^Near Shadings\s+(.+)$|Linear shadings\s*:\s*(.+)$/,
    0, (s) => s.replace(/^Near Shadings\s+/, "").trim());

  /* --- results --- */
  grabNum("producedKwh", /Produced Energy\s+([\d\s.]+)\s*kWh\/year/);
  grabNum("specificYield", /Specific production\s+([\d\s.]+)\s*kWh\/kWp\/year/);
  grabNum("pr", /Perf\. Ratio PR\s+([\d.]+)\s*%/);
  grabNum("usedKwh", /Used Energy\s+([\d\s.]+)\s*kWh\/year/);
  grabNum("solarFraction", /Solar Fraction SF\s+([\d.]+)\s*%/);

  /* --- the monthly balance table ---
     Read off its own header rather than by position, because the column
     set changes with the system type: a self-consumption run carries
     EFrGrid columns a plain grid-feed run does not have, and reading
     E_Grid out of a fixed slot would silently return the wrong series. */
  const monthly = [];
  const MONTHS = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const headIdx = lines.findIndex((l) => /\bGlobHor\b/.test(l) && /\bT_Amb\b/.test(l));
  let cols = [];
  if (headIdx >= 0) {
    cols = lines[headIdx].split(/\s+/).filter(Boolean);
    const readRow = (label, l) => {
      const nums = l.slice(label.length).trim().split(/\s+/).map(num).filter((v) => v !== null);
      if (!nums.length) return null;
      const row = { month: label };
      cols.forEach((c, i) => { if (nums[i] !== undefined) row[c] = nums[i]; });
      if (nums.length !== cols.length) {
        warnings.push(`Monthly row "${label}" has ${nums.length} numbers against `
          + `${cols.length} column headings — values are matched left to right.`);
      }
      return row;
    };
    for (const mn of MONTHS) {
      const l = lines.find((q) => q.startsWith(mn + " ") && /\d/.test(q));
      if (l) { const r = readRow(mn, l); if (r) monthly.push(r); }
    }
    const yl = lines.find((q) => /^Year\s+[\d.]/.test(q));
    if (yl) {
      const yr = readRow("Year", yl);
      if (yr) {
        fields.globHor = yr.GlobHor ?? null; src.globHor = yl;
        fields.globInc = yr.GlobInc ?? null; src.globInc = yl;
        fields.globEff = yr.GlobEff ?? null; src.globEff = yl;
        fields.tAmb = yr.T_Amb ?? null; src.tAmb = yl;
        for (const k of ["globHor", "globInc", "globEff", "tAmb"]) {
          if (fields[k] === null || fields[k] === undefined) {
            delete fields[k]; delete src[k]; missing.push(k);
          }
        }
        fields.yearRow = yr;
      }
    }
  } else {
    missing.push("globHor", "globInc", "globEff", "tAmb");
    warnings.push("No monthly balance table found, so the annual irradiation figures "
      + "are not available.");
  }
  if (monthly.length && monthly.length !== 12) {
    warnings.push(`Only ${monthly.length} of 12 months were read from the balance table.`);
  }

  /* --- the loss diagram ---
     Generic by design: any "<signed percent>% <label>" line becomes an
     entry, so a row this reader has never seen still lands in the record
     under PVsyst's own wording instead of being dropped. */
  const losses = [];
  const lossSeen = new Set();
  /* Scoped to the loss-diagram page. The array-loss *parameters* page
     carries lines in the same shape — "Loss Fraction 2.00 % at STC" and
     "efficiency at STC = 23.03% PV conversion" — and an unscoped scan
     turned those into loss rows called "at STC" and "PV conversion",
     junk that would then sit in every comparison. */
  const lossStart = lines.findIndex((l) => /^Loss diagram$/i.test(l));
  const lossLines = lossStart >= 0 ? lines.slice(lossStart) : [];
  if (lossStart < 0) {
    warnings.push("No loss-diagram page found, so the loss breakdown is not available.");
  }
  for (const l of lossLines) {
    /* Signed, or zero. Every genuine diagram row carries an explicit
       + or - ("+0.2% Global incident", "-3.00% Soiling loss factor")
       or is a flat 0.00%. The module efficiency on the same page
       ("efficiency at STC = 23.03% PV conversion") is unsigned, and
       without this it arrived as a +23% loss row. */
    const m = /([+-]\d+(?:\.\d+)?|0(?:\.0+)?)\s*%\s+([A-Za-z][^%]*)$/.exec(l);
    if (!m) continue;
    const label = m[2].trim();
    /* Guard against the balance-table legend and other prose: a loss row
       is a short phrase, not a sentence, and never a bare unit. */
    if (label.length < 3 || label.length > 70) continue;
    if (/^(ratio|kWh|units?)\b/i.test(label)) continue;
    const key = label.toLowerCase();
    if (lossSeen.has(key)) continue;
    lossSeen.add(key);
    losses.push({ label, alias: aliasFor(label), pct: num(m[1]), line: l });
  }
  if (!losses.length) warnings.push("No loss diagram rows were found.");

  /* Energy milestones down the diagram, which is what makes the
     percentages mean something absolute. */
  const milestones = [];
  for (const l of lines) {
    const m = /^([\d\s]+)\s*kWh\s+(Array nominal energy|Array virtual energy|Available Energy)(.*)$/i.exec(l);
    if (m) milestones.push({ kwh: num(m[1]), label: (m[2] + m[3]).trim(), line: l });
  }

  /* --- array loss parameters (the inputs, not the outcome) ---
     Only the ones that sit alone on a line. The soiling, LID, quality
     and mismatch fractions share a line in a three-column block
     ("Loss Fraction 1.00 % Loss Fraction -0.60 % Loss Fraction 2.00 %")
     and flattened text has lost which column is which — a reader taking
     the first match returns the strings-mismatch figure as the soiling
     loss, which is what this one did. They are deliberately not read
     here: the loss diagram carries the realised value of each of them,
     correctly, and one right number beats two plausible ones. */
  grabNum("moduleEffPct", /efficiency at STC\s*=\s*([\d.]+)\s*%/);
  grabNum("ucConst", /Uc \(const\)\s+([\d.]+)/);
  grabNum("uvWind", /Uv \(wind\)\s+([\d.]+)/);
  grabNum("arrayResMohm", /Global array res\.\s+([\d.]+)\s*m\u03A9/);

  const date = parsePvsystDate(fields.simulatedAt);
  if (date) { fields.simulatedIso = date.iso; fields.simulatedMs = date.ms; }

  /* A record with no project name and no yield is not a report we
     understood, whatever the header said. */
  const ok = Boolean(fields.project) && (fields.producedKwh != null || fields.specificYield != null);
  if (!ok) {
    warnings.push("The header looked like a PVsyst report but neither a project name nor an "
      + "annual yield could be read — check it is the simulation report rather than a "
      + "parameter sheet.");
  }

  return { ok, fields, src, losses, milestones, monthly, monthlyCols: cols,
    orientations: uniqOrient, missing: [...new Set(missing)], warnings };
}

/* ---------- the record the tracker stores --------------------------- */

let _seq = 0;
/** Wrap a parse into a stored project. `id` is generated rather than
    derived from the content, so re-importing a corrected report makes a
    new row instead of silently overwriting the old one — which is the
    behaviour a tracker wants, because the change is the information. */
export function recordFromReport(parsed, meta = {}) {
  const f = parsed.fields || {};
  _seq += 1;
  return {
    id: `${Date.now().toString(36)}-${_seq.toString(36)}`,
    addedAt: new Date().toISOString().slice(0, 10),
    fileName: meta.fileName || "",
    note: "",
    fields: f,
    src: parsed.src || {},
    losses: parsed.losses || [],
    milestones: parsed.milestones || [],
    monthly: parsed.monthly || [],
    monthlyCols: parsed.monthlyCols || [],
    orientations: parsed.orientations || [],
    missing: parsed.missing || [],
    warnings: parsed.warnings || [],
  };
}

/** Project and variant together, because one project carries several
    variants and comparing them is the point. */
export function recordTitle(r) {
  const p = r.fields.project || r.fileName || "Untitled";
  const v = r.fields.variant;
  return v ? `${p} — ${v}` : p;
}

/** Two records of the same project and variant are a re-import. Flagged,
    never merged: which one is current is the user's call. */
export function findDuplicates(records) {
  const byKey = new Map();
  for (const r of records) {
    const k = `${(r.fields.project || "").toLowerCase()}|${(r.fields.variant || "").toLowerCase()}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  return [...byKey.values()].filter((g) => g.length > 1);
}

/** The loss rows present across a set of records, in the order the first
    record lists them, with later records' unseen rows appended. A record
    missing a row reads as absent, never as zero. */
export function lossMatrix(records) {
  const order = [];
  const seen = new Set();
  for (const r of records) {
    for (const l of r.losses) {
      const k = l.alias || l.label;
      if (!seen.has(k)) { seen.add(k); order.push({ key: k, label: k }); }
    }
  }
  return order.map((row) => ({
    ...row,
    values: records.map((r) => {
      const hit = r.losses.find((l) => (l.alias || l.label) === row.key);
      return hit ? hit.pct : null;
    }),
  }));
}

/** Spread of a numeric field across records — min, max, mean and the
    records holding the extremes. Records without the field are excluded
    and counted, rather than dragging the mean towards zero. */
export function fieldSpread(records, key) {
  const pts = records
    .map((r) => ({ r, v: r.fields[key] }))
    .filter((p) => typeof p.v === "number" && Number.isFinite(p.v));
  if (!pts.length) return { n: 0, absent: records.length };
  const vals = pts.map((p) => p.v);
  const min = Math.min(...vals), max = Math.max(...vals);
  return {
    n: pts.length,
    absent: records.length - pts.length,
    min, max,
    mean: vals.reduce((a, b) => a + b, 0) / vals.length,
    lowest: pts.find((p) => p.v === min).r,
    highest: pts.find((p) => p.v === max).r,
  };
}

/* ---------- import and export --------------------------------------- */

const csvCell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per project, one column per tracked field, plus a column per
    loss row found anywhere in the set. Opens in a spreadsheet, which is
    where this kind of comparison usually ends up. */
export function projectsToCsv(records) {
  const lossRows = lossMatrix(records);
  const head = ["id", "addedAt", "fileName", "note",
    ...REPORT_FIELDS.map((f) => f.label),
    ...lossRows.map((l) => `Loss: ${l.label} (%)`)];
  const body = records.map((r, i) => [
    r.id, r.addedAt, r.fileName, r.note,
    ...REPORT_FIELDS.map((f) => r.fields[f.key] ?? ""),
    ...lossRows.map((l) => (l.values[i] === null ? "" : l.values[i])),
  ]);
  return [head, ...body].map((row) => row.map(csvCell).join(",")).join("\n");
}

/** The round trip. JSON rather than CSV, because a record carries the
    loss diagram, the monthly table and the source lines, and a flat CSV
    cannot hold them without losing the provenance. */
export function projectsToJson(records) {
  return JSON.stringify({ format: "pvhub.tracker.v1", saved: new Date().toISOString(), records }, null, 2);
}

export function projectsFromJson(text) {
  let data;
  try { data = JSON.parse(text); }
  catch (e) { return { ok: false, error: "That file is not valid JSON.", records: [] }; }
  const records = Array.isArray(data) ? data : data.records;
  if (!Array.isArray(records)) {
    return { ok: false, error: "No project list found in that file.", records: [] };
  }
  const clean = records.filter((r) => r && typeof r === "object" && r.fields);
  return {
    ok: true,
    records: clean.map((r) => ({ losses: [], milestones: [], monthly: [], monthlyCols: [],
      orientations: [], missing: [], warnings: [], src: {}, note: "", ...r })),
    skipped: records.length - clean.length,
  };
}
