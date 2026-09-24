/* =====================================================================
   PVSYST BATCH RESULTS  —  parsing and analysis

   Drop in a PVsyst batch results CSV, get back a tilt by pitch grid of
   E_Grid and a defensible answer to the question that actually decides
   the design: what is the tightest pitch at which the cheap structure
   angle is still within an acceptable energy penalty of the best option?

   No React in here and no DOM. Every number is computed by deterministic
   code, so the analysis can be read, argued with and tested on its own,
   and the same module works for any project's batch file.

   Three things about these files that catch people out:

   PVsyst writes them in Windows-1252, not UTF-8, because they carry ² and
   °. Decoding as UTF-8 throws. And on a locale with a decimal comma the
   numbers come out as 17,57 while the delimiter is still a semicolon, so
   the separator has to be detected rather than assumed.

   The header is three rows, not one: group names, then sub-names or
   units, then bracketed units. A column's identity comes from all three.

   The Error column is not only errors. "Warning: parameter X did not
   change" means the swept value happened to equal the base variant's, so
   the row is perfectly valid and must be kept; throwing it away silently
   would delete a whole pitch from the sweep.
   ===================================================================== */

/* ---------------------------------------------------------------
   Decoding
   --------------------------------------------------------------- */

/**
 * Decode the file, trying UTF-8 first and falling back to Windows-1252.
 * Accepts an ArrayBuffer/Uint8Array from a file input, or a string when
 * the caller has already decoded it.
 */
export function decodeBatchFile(input) {
  if (typeof input === "string") return { text: input, encoding: "already decoded" };
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "UTF-8" };
  } catch (e) {
    // Not valid UTF-8, so it is the Windows-1252 that PVsyst actually writes.
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "Windows-1252" };
  }
}

/* ---------------------------------------------------------------
   CSV splitting
   --------------------------------------------------------------- */

/* PVsyst does not quote its fields, but a comment can carry a quote mark,
   so the splitter honours quoting rather than doing a bare split. */
function splitRow(line, delim) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === delim) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Semicolon is what PVsyst writes; comma and tab are accepted anyway. */
function detectDelimiter(text) {
  const head = text.split(/\r?\n/).slice(0, 40).join("\n");
  const counts = [";", "\t", ","].map((d) => [d, (head.match(new RegExp(`\\${d}`, "g")) || []).length]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ";";
}

/**
 * Decimal comma detection. Only meaningful when the delimiter is not a
 * comma; a cell like 17,57 sitting in a semicolon-delimited file is a
 * number with a decimal comma, not two fields.
 */
function detectDecimalComma(rows, delim) {
  if (delim === ",") return false;
  let comma = 0, dot = 0;
  for (const r of rows) {
    for (const cell of r) {
      if (/^-?\d+,\d+$/.test(cell)) comma++;
      else if (/^-?\d+\.\d+$/.test(cell)) dot++;
    }
  }
  return comma > dot;
}

const toNumber = (cell, decimalComma) => {
  if (cell === null || cell === undefined) return null;
  let s = String(cell).trim();
  if (!s) return null;
  s = decimalComma ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
};

/* ---------------------------------------------------------------
   Energy normalisation
   --------------------------------------------------------------- */

/* Everything energy-like is held in MWh internally so that a file in GWh
   and a file in kWh can be compared without the unit travelling with
   every calculation. Display formatting picks a unit at the edge. */
const ENERGY_TO_MWH = { gwh: 1000, mwh: 1, kwh: 0.001 };
const energyFactor = (unit) => ENERGY_TO_MWH[String(unit || "").toLowerCase().trim()] ?? null;

/* ---------------------------------------------------------------
   Parsing
   --------------------------------------------------------------- */

/**
 * Parse a PVsyst batch results CSV.
 *
 * Returns { meta, columns, sweptKeys, outputKeys, rows, excluded, warnings,
 *           encoding, delimiter, decimalComma }
 * and throws only when the file cannot be used at all, which means no
 * Ident header or no E_Grid column.
 */
export function parseBatchCsv(input) {
  const { text, encoding } = decodeBatchFile(input);
  const lines = text.split(/\r?\n/);
  const delimiter = detectDelimiter(text);
  const rawRows = lines.map((l) => splitRow(l, delimiter));
  const decimalComma = detectDecimalComma(rawRows, delimiter);
  const warnings = [];

  // Header is found by content, never by row number: batch files carry a
  // varying number of preamble lines.
  const h = rawRows.findIndex((r) => (r[0] || "").toLowerCase() === "ident");
  if (h < 0) {
    throw new Error("No header row found. A PVsyst batch file has a row whose first cell is “Ident”.");
  }
  const groups = rawRows[h] || [];
  const subs = rawRows[h + 1] || [];
  const units = rawRows[h + 2] || [];

  /* Metadata from the preamble. Read by label rather than position. */
  const preamble = rawRows.slice(0, h);
  const findCell = (re) => {
    for (const r of preamble) {
      if (re.test(r[0] || "")) return r.slice(1).find((c) => c) || null;
    }
    return null;
  };
  const modifiedRow = preamble.find((r) => /file modified on/i.test(r[0] || ""));
  const variantRow = preamble.find((r) => /variants based on/i.test(r[0] || ""));
  const meta = {
    project: findCell(/^project$/i),
    baseVariant: variantRow ? (variantRow.slice(1).find((c) => c) || null) : null,
    variantDescription: variantRow ? (variantRow.slice(1).filter((c) => c)[1] || null) : null,
    modified: modifiedRow ? (modifiedRow[0].replace(/^file modified on\s*/i, "").trim() || null) : null,
  };

  /* Column model. A column's name comes from the group row, its detail
     from the sub row, and its unit from whichever of the two carries one. */
  const width = Math.max(groups.length, subs.length, units.length);
  const columns = [];
  for (let i = 0; i < width; i++) {
    const group = (groups[i] || "").trim();
    const sub = (subs[i] || "").trim();
    const bracket = (units[i] || "").replace(/^\[|\]$/g, "").trim();
    // Row H+1 holds a sub-name for swept columns (tilt, pitch) and a unit
    // for output columns (GWh, kWh/m²); the bracket row only ever holds a
    // unit. Treat a bracketed value as authoritative.
    const unit = bracket || (/^[A-Za-z]/.test(sub) && !/^(tilt|pitch|comment|azimuth)$/i.test(sub) ? sub : "");
    columns.push({ index: i, group, sub, unit, key: sub || group });
  }

  const idxOf = (name) => columns.findIndex((c) => c.group.toLowerCase() === name.toLowerCase());
  const iSimul = idxOf("Simul");
  const iError = idxOf("Error");
  if (iSimul < 0) warnings.push("No “Simul” column found, so the split between swept parameters and outputs is a guess.");

  /* Swept parameters sit between Ident and Simul; which ones, and how
     many, varies between batch files. */
  const sweptCols = columns.slice(1, iSimul > 0 ? iSimul : 3)
    .filter((c) => c.group || c.sub);
  const outputCols = columns.slice((iError >= 0 ? iError : 4) + 1)
    .filter((c) => c.group);

  const findSwept = (re) => sweptCols.find((c) => re.test(c.sub) || re.test(c.group));
  const tiltCol = findSwept(/^tilt$/i);
  const pitchCol = findSwept(/^pitch$/i);
  if (!tiltCol) warnings.push("No swept column named “tilt” was found.");
  if (!pitchCol) warnings.push("No swept column named “pitch” was found.");

  const extraSwept = sweptCols.filter((c) => c !== tiltCol && c !== pitchCol);
  if (extraSwept.length) {
    warnings.push(
      `This batch also sweeps ${extraSwept.map((c) => c.sub || c.group).join(", ")}. `
      + "The tilt by pitch analysis below assumes those are constant; if they are not, filter the file first or the grid will mix cases.",
    );
  }

  const eGridCol = outputCols.find((c) => /^e_?grid$/i.test(c.group));
  if (!eGridCol) {
    throw new Error(
      "No E_Grid column in this file. E_Grid is the yield the analysis is built on, so add it to the batch output variables in PVsyst and re-export.",
    );
  }
  const eFactor = energyFactor(eGridCol.unit);
  if (eFactor === null) {
    warnings.push(`E_Grid unit “${eGridCol.unit || "none"}” is not recognised, so values are treated as MWh.`);
  }

  /* Data rows. Stop at the trailing blank and separator rows. */
  const rows = [];
  const excluded = [];
  for (let r = h + 3; r < rawRows.length; r++) {
    const row = rawRows[r];
    const ident = (row[0] || "").trim();
    if (!/^SIM_/i.test(ident)) continue;

    const errText = (iError >= 0 ? row[iError] || "" : "").trim();
    const rec = {
      ident,
      tilt: tiltCol ? toNumber(row[tiltCol.index], decimalComma) : null,
      pitch: pitchCol ? toNumber(row[pitchCol.index], decimalComma) : null,
      error: errText,
      didNotChange: /did not change/i.test(errText),
      outputs: {},
      extras: {},
    };
    for (const c of extraSwept) rec.extras[c.sub || c.group] = toNumber(row[c.index], decimalComma);
    for (const c of outputCols) rec.outputs[c.group] = toNumber(row[c.index], decimalComma);

    const eRaw = rec.outputs[eGridCol.group];
    rec.eGridMwh = eRaw === null ? null : eRaw * (eFactor === null ? 1 : eFactor);

    // A row starting Error, or one with no yield at all, cannot be used.
    if (/^error/i.test(errText)) {
      excluded.push({ ...rec, reason: errText });
    } else if (rec.eGridMwh === null) {
      excluded.push({ ...rec, reason: "No E_Grid value in this row." });
    } else if (rec.tilt === null || rec.pitch === null) {
      excluded.push({ ...rec, reason: "Tilt or pitch could not be read." });
    } else {
      rows.push(rec);
    }
  }

  if (!rows.length) throw new Error("No usable SIM_ rows were found in this file.");

  /* Duplicates: the same tilt and pitch simulated twice. The later row
     wins, because a re-run is usually a correction, and both are listed. */
  const seen = new Map();
  const duplicates = [];
  for (const rec of rows) {
    const k = `${rec.tilt}|${rec.pitch}`;
    if (seen.has(k)) duplicates.push({ kept: rec.ident, replaced: seen.get(k).ident, tilt: rec.tilt, pitch: rec.pitch });
    seen.set(k, rec);
  }
  const deduped = [...seen.values()];
  if (duplicates.length) {
    warnings.push(
      `${duplicates.length} duplicate tilt and pitch combination(s); the later row was kept (`
      + duplicates.map((d) => `${d.tilt}°/${d.pitch} m: kept ${d.kept}, dropped ${d.replaced}`).join("; ") + ").",
    );
  }

  const changedCount = rows.filter((r) => r.didNotChange).length;
  if (changedCount) {
    warnings.push(
      `${changedCount} row(s) report “parameter did not change”, which means the swept value already equalled the base variant. They are valid results and have been kept.`,
    );
  }

  return {
    meta, columns, encoding, delimiter, decimalComma,
    sweptCols, outputCols, tiltCol, pitchCol, eGridCol, eGridUnit: eGridCol.unit || "MWh",
    extraSwept, rows: deduped, excluded, duplicates, warnings,
  };
}

/* ---------------------------------------------------------------
   Analysis
   --------------------------------------------------------------- */

export const ANALYSIS_DEFAULTS = {
  /* PVsyst results carry numerical noise: in the sample file 22 degrees
     beats 21 at 10 m, which is not physical. Anything within this
     fraction of the global maximum is treated as a tie rather than as a
     winner, and the interface has to say so. */
  tolerancePct: 0.2,

  /* The design bias. A shallow tilt is usually the cheapest structure, so
     the question is not which tilt wins but how tight a pitch keeps the
     cheap tilt close enough to the winner. */
  preferredTilt: 15,
  acceptablePenaltyPct: 1.0,

  /* Collector width along the slope, for GCR. Null until entered. */
  collectorWidthM: null,

  /* How many further sweep steps to suggest when the optimum is not
     bracketed. */
  suggestSteps: 3,
};

/* The shape the cost phase will fill in. Defined now so that adding it
   later is a matter of populating cells rather than reshaping the
   analysis. Nothing reads these yet. */
export const COST_SCHEMA = {
  structurePerMwpByTilt: null,   // { [tilt]: currency per MWp }
  land: null,                    // { mode: "perHectare" | "fixedBoundary", value }
  cablingPerMetre: null,         // { dc, lv }
  fencingAndRoadsPerArea: null,  // currency per hectare of site
  energy: null,                  // { pricePerMwh, discountRatePct, lifetimeYears, degradationPctPerYear }
};

const round = (v, dp) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(dp)));

/** Sorted unique numeric values. */
const uniqSorted = (xs) => [...new Set(xs)].sort((a, b) => a - b);

/**
 * Detect gaps in an evenly spaced sweep. Returns the inferred step and
 * the values that are missing from it, so the interface can say
 * "tilt steps: 15, 17, 18 ... (16 missing)" rather than leaving the user
 * to spot it.
 */
function findGaps(values) {
  if (values.length < 3) return { step: null, missing: [] };
  const diffs = values.slice(1).map((v, i) => round(v - values[i], 6));
  // The modal gap is the intended step; anything larger is a hole.
  const counts = new Map();
  for (const d of diffs) counts.set(d, (counts.get(d) || 0) + 1);
  const step = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  if (!(step > 0)) return { step: null, missing: [] };
  const missing = [];
  for (let i = 1; i < values.length; i++) {
    const gap = values[i] - values[i - 1];
    if (gap > step * 1.5) {
      for (let v = values[i - 1] + step; v < values[i] - step * 0.5; v += step) missing.push(round(v, 6));
    }
  }
  return { step, missing };
}

/**
 * Analyse a parsed batch file.
 *
 * Everything is derived from the grid; nothing is judged by eye and
 * nothing is guessed. Energy is in MWh throughout.
 */
export function analyseBatch(parsed, options = {}) {
  const opt = { ...ANALYSIS_DEFAULTS, ...options };
  const rows = parsed.rows;
  const tilts = uniqSorted(rows.map((r) => r.tilt));
  const pitches = uniqSorted(rows.map((r) => r.pitch));

  /* cell[tilt][pitch]. Each cell carries a costs slot so the later phase
     can attach an LCOE or NPV without the grid changing shape. */
  const cell = new Map();
  const key = (t, p) => `${t}|${p}`;
  for (const r of rows) {
    cell.set(key(r.tilt, r.pitch), {
      tilt: r.tilt, pitch: r.pitch, ident: r.ident,
      eGridMwh: r.eGridMwh, outputs: r.outputs, didNotChange: r.didNotChange,
      costs: null,
    });
  }
  const at = (t, p) => cell.get(key(t, p)) || null;

  const missingCells = [];
  for (const t of tilts) for (const p of pitches) if (!at(t, p)) missingCells.push({ tilt: t, pitch: p });

  /* 1. Global maximum. */
  const filled = [...cell.values()];
  const globalMax = filled.reduce((m, c) => (c.eGridMwh > m.eGridMwh ? c : m), filled[0]);

  /* 2. Noise tolerance: everything within the band ties with the winner. */
  const toleranceMwh = (opt.tolerancePct / 100) * globalMax.eGridMwh;
  const ties = filled
    .filter((c) => globalMax.eGridMwh - c.eGridMwh <= toleranceMwh)
    .sort((a, b) => b.eGridMwh - a.eGridMwh);

  /* 3. Best tilt at each pitch, and the envelope that traces. */
  const bestTiltPerPitch = pitches.map((p) => {
    const col = tilts.map((t) => at(t, p)).filter(Boolean);
    if (!col.length) return { pitch: p, tilt: null, eGridMwh: null };
    const best = col.reduce((m, c) => (c.eGridMwh > m.eGridMwh ? c : m), col[0]);
    return { pitch: p, tilt: best.tilt, eGridMwh: best.eGridMwh };
  });

  /* 4. Marginal gain per metre of pitch, along the envelope and along the
        preferred tilt. This is what makes diminishing returns visible. */
  const marginal = (series) => series.map((pt, i) => {
    if (i === 0 || pt.eGridMwh === null || series[i - 1].eGridMwh === null) {
      return { ...pt, dPitch: null, gainMwh: null, gainPct: null, perMetreMwh: null, perMetrePct: null };
    }
    const prev = series[i - 1];
    const dP = pt.pitch - prev.pitch;
    const gain = pt.eGridMwh - prev.eGridMwh;
    return {
      ...pt, dPitch: dP, gainMwh: gain,
      gainPct: (gain / prev.eGridMwh) * 100,
      perMetreMwh: dP ? gain / dP : null,
      perMetrePct: dP ? (gain / prev.eGridMwh) * 100 / dP : null,
    };
  });
  const envelopeMarginal = marginal(bestTiltPerPitch);

  /* 6. Preferred tilt. If the exact angle was not simulated, use the
        nearest one and say which, rather than interpolating a result the
        simulation never produced. */
  const preferredTiltActual = tilts.length
    ? tilts.reduce((m, t) => (Math.abs(t - opt.preferredTilt) < Math.abs(m - opt.preferredTilt) ? t : m), tilts[0])
    : null;
  const preferredExact = preferredTiltActual === opt.preferredTilt;

  const preferredSeries = pitches.map((p) => {
    const c = at(preferredTiltActual, p);
    const bestHere = bestTiltPerPitch.find((b) => b.pitch === p);
    if (!c) return { pitch: p, eGridMwh: null, penaltyVsMaxPct: null, penaltyVsBestHerePct: null, bestTiltHere: bestHere?.tilt ?? null };
    return {
      pitch: p,
      eGridMwh: c.eGridMwh,
      penaltyVsMaxPct: ((globalMax.eGridMwh - c.eGridMwh) / globalMax.eGridMwh) * 100,
      penaltyVsBestHerePct: bestHere && bestHere.eGridMwh
        ? ((bestHere.eGridMwh - c.eGridMwh) / bestHere.eGridMwh) * 100 : null,
      bestTiltHere: bestHere?.tilt ?? null,
    };
  });
  const preferredMarginal = marginal(preferredSeries);

  /* The recommendation: the tightest pitch that stays inside the
     acceptable penalty. Tightest, not best, because every extra metre
     costs land and cable that PVsyst does not model. */
  const withinThreshold = preferredSeries.filter(
    (s) => s.penaltyVsMaxPct !== null && s.penaltyVsMaxPct <= opt.acceptablePenaltyPct,
  );
  const recommended = withinThreshold.length
    ? withinThreshold.reduce((m, s) => (s.pitch < m.pitch ? s : m))
    : null;
  const nearestMiss = recommended ? null
    : preferredSeries.filter((s) => s.penaltyVsMaxPct !== null)
        .reduce((m, s) => (s.penaltyVsMaxPct < m.penaltyVsMaxPct ? s : m), preferredSeries.find((s) => s.penaltyVsMaxPct !== null));

  /* 5. Edge of range. If the winner sits on the boundary the sweep has
        not bracketed the optimum, and the honest answer is to extend it
        rather than to report the edge as an optimum. */
  const tiltGaps = findGaps(tilts);
  const pitchGaps = findGaps(pitches);
  const suggestBeyond = (values, step, dir) => {
    if (!step) return [];
    const from = dir > 0 ? values[values.length - 1] : values[0];
    return Array.from({ length: opt.suggestSteps }, (_, i) => round(from + dir * step * (i + 1), 6));
  };
  const edge = {
    pitchAtMax: globalMax.pitch === pitches[pitches.length - 1] ? "upper"
      : globalMax.pitch === pitches[0] ? "lower" : null,
    tiltAtMax: globalMax.tilt === tilts[tilts.length - 1] ? "upper"
      : globalMax.tilt === tilts[0] ? "lower" : null,
    suggestPitch: [], suggestTilt: [],
  };
  if (edge.pitchAtMax === "upper") edge.suggestPitch = suggestBeyond(pitches, pitchGaps.step, +1);
  if (edge.pitchAtMax === "lower") edge.suggestPitch = suggestBeyond(pitches, pitchGaps.step, -1);
  if (edge.tiltAtMax === "upper") edge.suggestTilt = suggestBeyond(tilts, tiltGaps.step, +1);
  if (edge.tiltAtMax === "lower") edge.suggestTilt = suggestBeyond(tilts, tiltGaps.step, -1);

  /* 7. Optional geometry. GCR and the clear gap between rows are what
        turn a pitch into something a civils contractor can picture. */
  const w = opt.collectorWidthM;
  const geometry = w > 0
    ? {
        collectorWidthM: w,
        byPitch: pitches.map((p) => ({ pitch: p, gcr: w / p })),
        clearGap: (tilt, pitch) => pitch - w * Math.cos((tilt * Math.PI) / 180),
      }
    : null;

  return {
    tilts, pitches, at, cells: filled, missingCells,
    globalMax, toleranceMwh, tolerancePct: opt.tolerancePct, ties,
    bestTiltPerPitch, envelopeMarginal,
    preferredTilt: opt.preferredTilt, preferredTiltActual, preferredExact,
    preferredSeries, preferredMarginal,
    acceptablePenaltyPct: opt.acceptablePenaltyPct,
    recommended, nearestMiss,
    tiltGaps, pitchGaps, edge, geometry,
    costSchema: COST_SCHEMA,
    options: opt,
  };
}

/* ---------------------------------------------------------------
   Reporting
   --------------------------------------------------------------- */

/** Energy in whichever unit reads best, from the MWh held internally. */
export function fmtEnergy(mwh, dp) {
  if (mwh === null || mwh === undefined || !Number.isFinite(mwh)) return "—";
  if (Math.abs(mwh) >= 1000) return `${(mwh / 1000).toFixed(dp ?? 2)} GWh`;
  return `${mwh.toFixed(dp ?? 0)} MWh`;
}

/**
 * The recommendation, as plain sentences from fixed templates. Generated
 * by the same deterministic code that did the analysis, so the words and
 * the numbers cannot drift apart.
 */
export function buildRecommendation(a, parsed) {
  const lines = [];
  const t = (x) => `${round(x, 2)}°`;
  const p = (x) => `${round(x, 2)} m`;

  lines.push({
    kind: "optimal",
    text: `Energy-optimal point is ${t(a.globalMax.tilt)} at ${p(a.globalMax.pitch)}, giving ${fmtEnergy(a.globalMax.eGridMwh)}.`
      + (a.ties.length > 1
        ? ` Within the ${a.tolerancePct}% noise tolerance (${fmtEnergy(a.toleranceMwh, 1)}) this ties with `
          + a.ties.slice(1).map((c) => `${t(c.tilt)} at ${p(c.pitch)} (${fmtEnergy(c.eGridMwh)})`).join(", ")
          + ", so treat those as equal rather than ranked."
        : ` Nothing else is within the ${a.tolerancePct}% noise tolerance, so the winner is clear.`),
  });

  if (a.recommended) {
    const r = a.recommended;
    const deltaMwh = a.globalMax.eGridMwh - r.eGridMwh;
    lines.push({
      kind: "recommend",
      text: `At the preferred ${t(a.preferredTiltActual)}${a.preferredExact ? "" : ` (nearest simulated angle to ${t(a.preferredTilt)})`}, `
        + `the tightest pitch meeting the ${a.acceptablePenaltyPct}% limit is ${p(r.pitch)}, `
        + `giving ${fmtEnergy(r.eGridMwh)}, which is ${round(r.penaltyVsMaxPct, 2)}% below the best case, `
        + `or ${fmtEnergy(deltaMwh, 1)} a year. `
        + (r.penaltyVsBestHerePct !== null
          ? `Against the best tilt at that same pitch (${t(r.bestTiltHere)}) the penalty is ${round(r.penaltyVsBestHerePct, 2)}%.`
          : ""),
    });
  } else if (a.nearestMiss) {
    const n = a.nearestMiss;
    lines.push({
      kind: "recommend",
      text: `The preferred ${t(a.preferredTiltActual)} never comes within ${a.acceptablePenaltyPct}% of the best case anywhere in this sweep. `
        + `The closest it gets is ${round(n.penaltyVsMaxPct, 2)}% at ${p(n.pitch)}. `
        + `Either widen the acceptable penalty, extend the pitch sweep, or accept a steeper tilt.`,
    });
  }

  if (a.edge.pitchAtMax) {
    lines.push({
      kind: "edge",
      text: `Optimum not bracketed: yield is still rising at the ${a.edge.pitchAtMax === "upper" ? "largest" : "smallest"} pitch tested `
        + `(${p(a.globalMax.pitch)}). Extend the sweep`
        + (a.edge.suggestPitch.length ? ` to ${a.edge.suggestPitch.map((v) => `${v} m`).join(", ")}` : "")
        + ` before treating this as the answer.`,
    });
  }
  if (a.edge.tiltAtMax) {
    lines.push({
      kind: "edge",
      text: `The best tilt is at the ${a.edge.tiltAtMax === "upper" ? "top" : "bottom"} of the range tested (${t(a.globalMax.tilt)}). `
        + `Extend the tilt sweep`
        + (a.edge.suggestTilt.length ? ` to ${a.edge.suggestTilt.map((v) => `${v}°`).join(", ")}` : "") + ".",
    });
  }

  if (a.tiltGaps.missing.length || a.pitchGaps.missing.length) {
    const bits = [];
    if (a.tiltGaps.missing.length) bits.push(`tilt ${a.tiltGaps.missing.map((v) => `${v}°`).join(", ")}`);
    if (a.pitchGaps.missing.length) bits.push(`pitch ${a.pitchGaps.missing.map((v) => `${v} m`).join(", ")}`);
    lines.push({
      kind: "gap",
      text: `The sweep has gaps: ${bits.join("; ")} missing from an otherwise even step. `
        + `The grid is read as-is, so a gap simply means less resolution there.`,
    });
  }
  if (a.missingCells.length) {
    lines.push({
      kind: "gap",
      text: `${a.missingCells.length} tilt and pitch combination(s) have no result, so those cells are blank in the grid.`,
    });
  }
  if (parsed?.excluded?.length) {
    lines.push({
      kind: "excluded",
      text: `${parsed.excluded.length} row(s) were excluded: `
        + parsed.excluded.map((e) => `${e.ident} (${e.reason})`).join("; ") + ".",
    });
  }

  lines.push({
    kind: "caveat",
    text: "Pitch is only truly optimised once costs are in. PVsyst holds capacity fixed, so a wider pitch always gains energy "
      + "and the curve never turns over; what turns it over is the land, cabling, fencing and roads that the extra metres cost. "
      + "Read the figures above as the energy half of that trade.",
  });

  return lines;
}

/* ---------------------------------------------------------------
   Export
   --------------------------------------------------------------- */

/** The grid and the analysis as CSV, for a spreadsheet or a report. */
export function toCsv(a, parsed) {
  const q = (s) => {
    const v = String(s ?? "");
    return /[",;\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  const out = [];
  out.push(["PVsyst batch analysis"]);
  out.push(["Project", parsed.meta.project || ""]);
  out.push(["Base variant", parsed.meta.baseVariant || ""]);
  out.push(["File modified", parsed.meta.modified || ""]);
  out.push(["Noise tolerance %", a.tolerancePct]);
  out.push(["Preferred tilt deg", a.preferredTilt]);
  out.push(["Acceptable penalty %", a.acceptablePenaltyPct]);
  out.push([]);
  out.push(["E_Grid grid, MWh per year"]);
  out.push(["tilt \\ pitch", ...a.pitches]);
  for (const t of a.tilts) out.push([t, ...a.pitches.map((p) => a.at(t, p)?.eGridMwh ?? "")]);
  out.push([]);
  out.push(["Best tilt per pitch"]);
  out.push(["pitch m", "best tilt deg", "E_Grid MWh"]);
  for (const b of a.bestTiltPerPitch) out.push([b.pitch, b.tilt ?? "", b.eGridMwh ?? ""]);
  out.push([]);
  out.push([`Preferred tilt ${a.preferredTiltActual} deg`]);
  out.push(["pitch m", "E_Grid MWh", "penalty vs global max %", "penalty vs best at this pitch %", "gain per metre MWh"]);
  a.preferredMarginal.forEach((s) => out.push([
    s.pitch, s.eGridMwh ?? "",
    s.penaltyVsMaxPct === null ? "" : round(s.penaltyVsMaxPct, 3),
    s.penaltyVsBestHerePct === null ? "" : round(s.penaltyVsBestHerePct, 3),
    s.perMetreMwh === null ? "" : round(s.perMetreMwh, 2),
  ]));
  out.push([]);
  out.push(["Recommendation"]);
  for (const l of buildRecommendation(a, parsed)) out.push([l.text]);
  return out.map((r) => r.map(q).join(",")).join("\r\n");
}
