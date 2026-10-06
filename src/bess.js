/* =====================================================================
   BATTERY SIZING  —  the arithmetic and the hourly dispatch

   Two questions, and they are not the same question.

   1.  "I need X MW for Y hours."  That is a capacity requirement, and
       it is answered by arithmetic: work back from the energy that must
       be deliverable at the meter, through depth of discharge, the
       round-trip losses, the auxiliary load and whatever degradation
       you are sizing for, to a nameplate figure, then divide by the
       size of a unit. No weather, no load profile, no simulation. This
       is how a utility tender is specified and it is what the source
       workbook does.

   2.  "I have this load and this array — how big a battery is worth
       buying?"  Arithmetic cannot answer that, because the answer
       depends on when the sun shines against when the load runs. It
       needs an hour-by-hour simulation over a year, which is what
       HOMER does and what the dispatch below does: step through 8,760
       hours, send PV to the load first, bank the surplus, draw on the
       bank when short, and count what the battery actually saved.

   The tool offers both, because both get asked, and it never presents
   the first as if it answered the second.

   Everything here is in kW and kWh regardless of project size. A
   residential battery is 10 kWh and a utility one is 200,000 kWh; the
   physics does not change and neither should the engine. The interface
   converts for display.

   No React, no dependencies — so it can be tested from node.
   ===================================================================== */

/* ---------------------------------------------------------------
   1.  NAMEPLATE FROM USABLE  —  the derate chain
   --------------------------------------------------------------- */

/**
 * Work back from the energy that must reach the meter to the nameplate
 * energy that has to be installed to deliver it.
 *
 *     nameplate = usable / (DoD × √RTE × (1 − aux) × retention)
 *
 * Each divisor is a real loss between the cells and the connection:
 *
 *   DoD        a cell is not emptied to zero. If the supplier quotes
 *              the container in USABLE kWh this is already in their
 *              number and should be left at 100 — double-counting it
 *              is the most common error in this calculation.
 *   √RTE       round-trip efficiency covers a charge and a discharge.
 *              Only the discharge half stands between stored energy
 *              and the meter, and the usual convention splits the
 *              round trip evenly, so the one-way figure is √RTE. A
 *              supplier quoting a one-way number directly should have
 *              it entered as RTE², or the loss is applied twice.
 *   aux        HVAC, controls and fire suppression run off the same
 *              connection and are a parasitic load on it.
 *   retention  only if sizing for end of life. Sizing a day-one system
 *              for year-25 capacity oversizes it by roughly a third,
 *              which is why most projects hold capacity by augmenting
 *              later instead. Beginning of life is the default here
 *              for that reason, and the choice is explicit.
 */
export function nameplateFromUsable({
  usableKWh, dodPct = 100, rtePct = 88, auxPct = 2, retentionPct = 70,
  sizeFor = "bol",
}) {
  const dod = dodPct / 100;
  const etaDischarge = Math.sqrt(rtePct / 100);
  const aux = 1 - auxPct / 100;
  const retention = sizeFor === "eol" ? retentionPct / 100 : 1;
  const chain = dod * etaDischarge * aux * retention;
  return {
    nameplateKWh: chain > 0 ? usableKWh / chain : null,
    dod, etaDischarge, aux, retention, chain,
    sizeFor,
  };
}

/** The same chain forwards: what a given nameplate actually delivers. */
export function usableFromNameplate({
  nameplateKWh, dodPct = 100, rtePct = 88, auxPct = 2, retentionPct = 70,
  sizeFor = "bol",
}) {
  const { chain } = nameplateFromUsable({
    usableKWh: 1, dodPct, rtePct, auxPct, retentionPct, sizeFor });
  return { usableKWh: nameplateKWh * chain, chain };
}

/* ---------------------------------------------------------------
   2.  UNIT COUNT  —  how many of the thing you are actually buying
   --------------------------------------------------------------- */

/**
 * Batteries are bought in units, so both requirements round up and the
 * larger one governs. Which one governs is worth saying out loud: if
 * energy binds, the extra power that comes with the units is free and a
 * cheaper lower-power PCS may suit; if power binds, the extra energy is
 * free and the duration is longer than asked for.
 */
export function unitCount({
  requiredKW, nameplateKWh, unitKWh, unitKW, pf = 1,
  dodPct = 100, rtePct = 88, auxPct = 2, retentionPct = 70, sizeFor = "bol",
}) {
  const requiredKVA = pf > 0 ? requiredKW / pf : requiredKW;
  const forPower = unitKW > 0 ? Math.ceil((requiredKVA * pf) / unitKW) : null;
  const forEnergy = unitKWh > 0 ? Math.ceil(nameplateKWh / unitKWh) : null;
  if (forPower === null || forEnergy === null) return { units: null };
  const units = Math.max(forPower, forEnergy);
  const installedKWh = units * unitKWh;
  const installedKW = units * unitKW;
  const { usableKWh: deliverableKWh } = usableFromNameplate({
    nameplateKWh: installedKWh, dodPct, rtePct, auxPct, retentionPct, sizeFor });
  return {
    units, forPower, forEnergy,
    governedBy: forEnergy >= forPower ? "energy" : "power",
    requiredKVA, installedKWh, installedKW, deliverableKWh,
    powerOk: installedKW >= requiredKVA * pf,
    spareKW: installedKW - requiredKVA * pf,
    spareKWh: deliverableKWh,
  };
}

/* ---------------------------------------------------------------
   3.  LOAD PROFILES
   --------------------------------------------------------------- */

/* Normalised 24-hour shapes, each summing to 1. These are stylised,
   not measured — a real half-hourly meter file beats any of them and
   the interface says so. They exist so the dispatch has something
   defensible to run on before a meter file exists. */
const DAY_SHAPES = {
  /* Two peaks, the evening one larger: people wake, leave, come back
     and cook. The classic domestic duck-curve load. */
  residential: [
    0.021, 0.018, 0.016, 0.015, 0.015, 0.018, 0.028, 0.040,
    0.045, 0.040, 0.035, 0.033, 0.033, 0.032, 0.033, 0.038,
    0.050, 0.068, 0.082, 0.085, 0.075, 0.060, 0.044, 0.030,
  ],
  /* Office hours: almost nothing overnight, a plateau through the
     working day. The best possible match to a PV profile. */
  commercial: [
    0.012, 0.011, 0.011, 0.011, 0.012, 0.016, 0.028, 0.045,
    0.062, 0.070, 0.072, 0.072, 0.068, 0.070, 0.070, 0.066,
    0.058, 0.045, 0.032, 0.024, 0.020, 0.017, 0.015, 0.013,
  ],
  /* Two or three shifts: nearly flat, which is the hardest profile for
     PV alone and the easiest to justify a battery against. */
  industrial: [
    0.037, 0.036, 0.036, 0.036, 0.037, 0.039, 0.043, 0.045,
    0.046, 0.046, 0.046, 0.045, 0.044, 0.045, 0.046, 0.046,
    0.045, 0.043, 0.042, 0.041, 0.040, 0.039, 0.038, 0.037,
  ],
  /* Genuinely flat — a data centre, a telecoms site, a water pump
     running continuously. */
  flat: new Array(24).fill(1 / 24),
};

/* Normalise each shape to sum to exactly 1, so a caller can scale a
   day's energy by it directly and get that energy back. loadProfile
   rescales the whole year anyway and would not notice, but the CSV
   daily branch multiplies through without a second normalisation, and a
   shape summing to 0.954 silently lost 4.6% of the year there. */
for (const k of Object.keys(DAY_SHAPES)) {
  const sum = DAY_SHAPES[k].reduce((a, b) => a + b, 0);
  if (sum > 0) DAY_SHAPES[k] = DAY_SHAPES[k].map((v) => v / sum);
}

export const LOAD_SHAPES = [
  { value: "residential", label: "Residential — morning and evening peaks" },
  { value: "commercial", label: "Commercial — daytime plateau" },
  { value: "industrial", label: "Industrial — shift work, nearly flat" },
  { value: "flat", label: "Flat — constant demand" },
];

/**
 * An 8,760-hour load in kW from an annual consumption and a shape.
 *
 * Two modulations on top of the daily shape, because both are real and
 * both change the answer: weekends run lighter on commercial and
 * industrial sites, and consumption swings with season — heating in a
 * cold climate puts the peak in winter, cooling in a hot one puts it in
 * summer, and which way it goes decides whether PV and load agree.
 */
export function loadProfile({
  annualKWh, shape = "residential", weekendFactor = 1, seasonalAmp = 0,
  seasonalPeak = "winter", startDay = 0,
}) {
  const day = DAY_SHAPES[shape] || DAY_SHAPES.residential;
  const out = new Float64Array(8760);
  /* Build the raw weighting first, then scale the whole year so the
     total is exactly the annual figure entered. Scaling afterwards is
     what keeps the modulations from quietly changing the total. */
  let total = 0;
  for (let h = 0; h < 8760; h++) {
    const doy = Math.floor(h / 24);
    const dow = (startDay + doy) % 7;
    const isWeekend = dow === 5 || dow === 6;
    /* Peak in winter means a maximum at the turn of the year; peak in
       summer shifts it half a year. */
    const phase = seasonalPeak === "winter" ? 0 : Math.PI;
    const season = 1 + (seasonalAmp / 100) * Math.cos((2 * Math.PI * doy) / 365 + phase);
    const w = day[h % 24] * (isWeekend ? weekendFactor : 1) * Math.max(0, season);
    out[h] = w;
    total += w;
  }
  const k = total > 0 ? annualKWh / total : 0;
  for (let h = 0; h < 8760; h++) out[h] *= k;
  return out;
}

/**
 * An 8,760-hour PV output in kW.
 *
 * Given real TMY irradiance this is a straightforward conversion. With
 * no TMY it falls back to a clear-sky shape scaled to a stated annual
 * yield, which gets the daily and seasonal SHAPE right — which is what
 * the dispatch is sensitive to — while the absolute runs high, exactly
 * as the pitch model's fallback does. The caller is told which it got.
 */
export function pvProfile({ tmy, kWp, specificYield = 1500, lat = 0, prRatio = 0.8 }) {
  if (tmy && tmy.length === 8760) {
    const out = new Float64Array(8760);
    let sum = 0;
    for (let h = 0; h < 8760; h++) { out[h] = Math.max(0, tmy[h]); sum += out[h]; }
    /* Scale the irradiance shape to the array's expected annual output,
       so the profile carries TMY's hour-to-hour behaviour and PVhub's
       own yield figure for the total. */
    const target = kWp * specificYield;
    const k = sum > 0 ? target / sum : 0;
    for (let h = 0; h < 8760; h++) out[h] *= k;
    return { pv: out, synthetic: false };
  }
  /* Clear-sky proxy: a sine day between sunrise and sunset, with the
     day length and peak elevation varying by declination. */
  const out = new Float64Array(8760);
  const phi = (lat * Math.PI) / 180;
  let sum = 0;
  for (let doy = 0; doy < 365; doy++) {
    const dec = (23.45 * Math.PI / 180) * Math.sin((2 * Math.PI * (284 + doy)) / 365);
    const cosH = -Math.tan(phi) * Math.tan(dec);
    if (cosH >= 1) continue;                       // polar night
    const H = cosH <= -1 ? Math.PI : Math.acos(cosH);
    const sunrise = 12 - (H * 12) / Math.PI;
    const sunset = 12 + (H * 12) / Math.PI;
    for (let hh = 0; hh < 24; hh++) {
      const t = hh + 0.5;
      if (t <= sunrise || t >= sunset) continue;
      const frac = (t - sunrise) / (sunset - sunrise);
      const v = Math.sin(Math.PI * frac) * Math.max(0, Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec));
      out[doy * 24 + hh] = Math.max(0, v);
      sum += out[doy * 24 + hh];
    }
  }
  const target = kWp * specificYield * prRatio;
  const k = sum > 0 ? target / sum : 0;
  for (let h = 0; h < 8760; h++) out[h] *= k;
  return { pv: out, synthetic: true };
}

/* ---------------------------------------------------------------
   4.  DISPATCH  —  the hour-by-hour simulation
   --------------------------------------------------------------- */

/**
 * Load-following dispatch over 8,760 hours.
 *
 * The rule each hour, in priority order, which is what HOMER calls
 * load following and is the sensible default for a PV-plus-storage
 * site:
 *
 *   1.  PV serves the load directly. This energy never enters the
 *       battery, so it suffers no round-trip loss, and it is usually
 *       the largest single benefit — worth seeing separately rather
 *       than buried in a total.
 *   2.  Surplus PV charges the battery, limited by the inverter's
 *       power and by the headroom left in the bank.
 *   3.  Surplus beyond that is exported if there is an export limit to
 *       take it, and curtailed otherwise.
 *   4.  A deficit is covered from the battery, limited by power and by
 *       what is actually in the bank.
 *   5.  Whatever is still short is imported from the grid, or, with no
 *       grid, recorded as unmet load. Unmet load is the number that
 *       decides an off-grid design and it is never silently absorbed.
 *
 * Efficiency is split as √RTE each way, the same convention the
 * nameplate chain uses, so the two halves of this file agree.
 *
 * Usable capacity is nameplate × DoD, and the state of charge here is
 * tracked in usable kWh — the bank is "empty" at the bottom of its
 * permitted window, not at zero cells.
 */
export function dispatch({
  pv, load, nameplateKWh, powerKW, rtePct = 88, dodPct = 100,
  socInitPct = 50, hasGrid = true, exportLimitKW = Infinity,
  auxPct = 0,
}) {
  const n = Math.min(pv.length, load.length);
  const usableKWh = nameplateKWh * (dodPct / 100);
  const eta = Math.sqrt(rtePct / 100);
  const aux = (auxPct / 100) * powerKW;     // standing parasitic draw, kW

  let soc = usableKWh * (socInitPct / 100);
  const socSeries = new Float64Array(n);

  let pvTotal = 0, loadTotal = 0, direct = 0, charged = 0, discharged = 0;
  let exported = 0, curtailed = 0, imported = 0, unmet = 0, auxTotal = 0;
  let peakImportKW = 0, peakExportKW = 0;
  const monthly = Array.from({ length: 12 }, () => ({
    pv: 0, load: 0, direct: 0, fromBattery: 0, imported: 0, exported: 0, unmet: 0 }));
  /* Hour 0 of the year is 1 January; cumulative hours at each month end
     for a non-leap year. */
  const MONTH_END = [744, 1416, 2160, 2880, 3624, 4344, 5088, 5832, 6552, 7296, 8016, 8760];
  let m = 0;

  for (let h = 0; h < n; h++) {
    while (h >= MONTH_END[m] && m < 11) m++;
    const p = pv[h];
    const l = load[h] + aux;
    pvTotal += p; loadTotal += load[h]; auxTotal += aux;
    monthly[m].pv += p; monthly[m].load += load[h];

    const d = Math.min(p, l);                 // PV straight to load
    direct += d; monthly[m].direct += d;
    let surplus = p - d;
    let deficit = l - d;

    if (surplus > 0) {
      const headroom = (usableKWh - soc) / eta;        // kWh of input to fill it
      const take = Math.min(surplus, powerKW, Math.max(0, headroom));
      soc += take * eta;
      charged += take;
      surplus -= take;
      if (surplus > 0) {
        const exp = Math.min(surplus, exportLimitKW);
        exported += exp; monthly[m].exported += exp;
        curtailed += surplus - exp;
        if (exp > peakExportKW) peakExportKW = exp;
      }
    } else if (deficit > 0) {
      const available = soc * eta;                     // kWh deliverable now
      const give = Math.min(deficit, powerKW, Math.max(0, available));
      soc -= give / eta;
      discharged += give;
      monthly[m].fromBattery += give;
      deficit -= give;
      if (deficit > 0) {
        if (hasGrid) { imported += deficit; monthly[m].imported += deficit;
          if (deficit > peakImportKW) peakImportKW = deficit; }
        else { unmet += deficit; monthly[m].unmet += deficit; }
      }
    }
    socSeries[h] = usableKWh > 0 ? (soc / usableKWh) * 100 : 0;
  }

  const servedOnSite = direct + discharged;
  return {
    hours: n, usableKWh, eta,
    pvTotal, loadTotal, auxTotal,
    direct, charged, discharged, exported, curtailed, imported, unmet,
    peakImportKW, peakExportKW,
    socSeries, monthly,
    /* Share of the load covered without the grid. The number an
       off-grid or resilience project lives or dies by. */
    selfSufficiencyPct: loadTotal > 0 ? (servedOnSite / loadTotal) * 100 : 0,
    /* Share of generation used on site rather than exported or thrown
       away. The number that matters where export is worth little. */
    selfConsumptionPct: pvTotal > 0 ? ((direct + charged) / pvTotal) * 100 : 0,
    unmetPct: loadTotal > 0 ? (unmet / loadTotal) * 100 : 0,
    /* Equivalent full cycles: throughput measured in whole emptyings of
       the usable bank, which is how warranties are written. */
    cycles: usableKWh > 0 ? discharged / usableKWh : 0,
    /* Round-trip loss actually incurred, as opposed to the nameplate
       figure — it differs because the bank is not always cycled fully. */
    roundTripLossKWh: charged - discharged > 0 ? charged - discharged : 0,
  };
}

/* ---------------------------------------------------------------
   5.  SWEEP  —  what another kilowatt-hour actually buys
   --------------------------------------------------------------- */

/**
 * Run the dispatch across a range of battery sizes.
 *
 * Self-sufficiency against battery size is a saturating curve: the
 * first kilowatt-hours displace the evening peak and earn their keep,
 * and later ones sit idle most of the year waiting for the few days
 * that need them. Reporting the maximum is therefore useless advice —
 * the maximum is always the largest battery offered. What is useful is
 * where the curve flattens.
 *
 * "Flattens" is defined explicitly rather than eyeballed: the knee is
 * the last size whose marginal gain per kWh added is still at least
 * `kneeFraction` of the gain the first increment delivered. The
 * default of a fifth is a judgement, it is stated in the interface,
 * and it is an input so it can be argued with.
 */
export function sweepBattery(params, sizesKWh, kneeFraction = 0.2) {
  const rows = sizesKWh.map((kwh) => {
    const r = dispatch({ ...params, nameplateKWh: kwh,
      powerKW: params.powerKW ?? Math.max(1, kwh / (params.cRate || 2)) });
    return {
      nameplateKWh: kwh,
      selfSufficiencyPct: r.selfSufficiencyPct,
      selfConsumptionPct: r.selfConsumptionPct,
      unmetPct: r.unmetPct,
      cycles: r.cycles,
      importedKWh: r.imported,
      exportedKWh: r.exported,
      curtailedKWh: r.curtailed,
    };
  });
  /* Marginal gain in self-sufficiency per kWh of battery added. */
  for (let i = 0; i < rows.length; i++) {
    if (i === 0) { rows[i].marginalPerKWh = null; continue; }
    const dKwh = rows[i].nameplateKWh - rows[i - 1].nameplateKWh;
    rows[i].marginalPerKWh = dKwh > 0
      ? (rows[i].selfSufficiencyPct - rows[i - 1].selfSufficiencyPct) / dKwh : null;
  }
  const first = rows.find((r) => r.marginalPerKWh !== null && r.marginalPerKWh > 0);
  const threshold = first ? first.marginalPerKWh * kneeFraction : null;
  let knee = null;
  if (threshold !== null) {
    for (let i = rows.length - 1; i >= 1; i--) {
      if (rows[i].marginalPerKWh !== null && rows[i].marginalPerKWh >= threshold) { knee = rows[i]; break; }
    }
  }
  return {
    rows, knee, threshold, kneeFraction,
    firstMarginal: first ? first.marginalPerKWh : null,
    /* The honest caveat: a curve whose last point is still climbing has
       not been swept far enough to show a knee at all. */
    bracketed: knee ? knee.nameplateKWh < rows[rows.length - 1].nameplateKWh : false,
  };
}

/** A reasonable sweep range for a given load, in kWh. */
export function suggestSizes(dailyLoadKWh, steps = 12) {
  const top = Math.max(1, dailyLoadKWh * 2);
  const out = [];
  for (let i = 1; i <= steps; i++) out.push(Math.round((top * i) / steps * 100) / 100);
  return out;
}

/* ---------------------------------------------------------------
   6.  REAL LOAD DATA
   --------------------------------------------------------------- */

/* Hours in each month of a non-leap year, and the cumulative index of
   the first hour of each month. */
const MONTH_HOURS = [744, 672, 744, 720, 744, 720, 744, 744, 720, 744, 720, 744];
const MONTH_START = MONTH_HOURS.reduce((a, h, i) => { a.push(a[i] + h); return a; }, [0]);

/**
 * Twelve monthly totals into 8,760 hours.
 *
 * This is the data people actually have. Nobody arriving at a battery
 * question has a meter file; everybody has twelve numbers off their
 * bills. Each month is scaled to its own total and the daily shape
 * distributes it within the month, so the annual and the monthly totals
 * are both exactly right and only the within-day distribution is
 * assumed. That is a much better position than assuming the lot.
 */
export function loadFromMonthly(monthlyKWh, shape = "residential", weekendFactor = 1, startDay = 0) {
  const day = DAY_SHAPES[shape] || DAY_SHAPES.residential;
  const out = new Float64Array(8760);
  for (let m = 0; m < 12; m++) {
    const from = MONTH_START[m], to = MONTH_START[m + 1];
    let w = 0;
    for (let h = from; h < to; h++) {
      const dow = (startDay + Math.floor(h / 24)) % 7;
      const v = day[h % 24] * (dow === 5 || dow === 6 ? weekendFactor : 1);
      out[h] = v; w += v;
    }
    const k = w > 0 ? (monthlyKWh[m] || 0) / w : 0;
    for (let h = from; h < to; h++) out[h] *= k;
  }
  return out;
}

/**
 * Pick the delimiter the file actually uses.
 *
 * Taking the first one that splits anything is wrong, and wrong in a way
 * that corrupts the data rather than failing: a semicolon-delimited
 * file with decimal commas splits happily on the comma, and every
 * reading comes out an order of magnitude too big. So choose by which
 * delimiter gives the same field count on most lines, preferring more
 * fields when two agree equally well.
 */
function pickDelimiter(lines) {
  const sample = lines.slice(0, Math.min(40, lines.length));
  let best = null;
  for (const d of [";", ",", "\t", "|"]) {
    const counts = sample.map((l) => l.split(d).length);
    const tally = new Map();
    for (const c of counts) tally.set(c, (tally.get(c) || 0) + 1);
    let mode = 1, modeN = 0;
    for (const [c, n] of tally) if (n > modeN || (n === modeN && c > mode)) { mode = c; modeN = n; }
    if (mode < 2) continue;
    const score = (modeN / sample.length) * 100 + mode;
    if (!best || score > best.score) best = { d, score };
  }
  return best ? best.d : null;
}

function splitRow(line, d) {
  const parts = d ? line.split(d) : [line];
  return parts.map((x) => x.trim().replace(/^"|"$/g, ""));
}

const numOf = (s) => {
  if (s === undefined || s === null) return NaN;
  /* A decimal comma and a thousands comma look identical until you count
     them, so decide by which separator appears last. */
  let t = String(s).trim().replace(/\s/g, "");
  if (/,\d{1,3}$/.test(t) && !/\.\d/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
  else t = t.replace(/,/g, "");
  const v = Number(t);
  return Number.isFinite(v) ? v : NaN;
};

/**
 * A meter export into an 8,760-hour load in kWh.
 *
 * Deliberately forgiving about format, because every utility exports
 * something different, and deliberately loud about what it decided,
 * because a silent misread here invalidates everything downstream.
 *
 * What it works out for itself:
 *   delimiter        comma, semicolon, tab or pipe
 *   header           present or not, by whether row one parses as numbers
 *   value column     named (kwh / kw / load / demand / consumption /
 *                    usage / import) if it can, otherwise the last
 *                    column that is numeric on most rows
 *   units            kW is power and must be multiplied by the interval
 *                    to become energy; kWh is already energy. Getting
 *                    this backwards at half-hourly resolution doubles
 *                    or halves the whole year, so it is reported and
 *                    can be overridden.
 *   resolution       from the row count — 35,040 is quarter-hourly,
 *                    17,520 half-hourly, 8,760 hourly, 365 daily, 12
 *                    monthly. Anything else is resampled onto 8,760 and
 *                    said so.
 */
export function parseLoadCsv(text, opts = {}) {
  const warnings = [];
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) throw new Error("the file is empty");

  const delim = pickDelimiter(lines);
  const rows = lines.map((l) => splitRow(l, delim));
  const width = Math.max(...rows.map((r) => r.length));

  /* A header is a first row whose cells are not numbers. */
  const firstNumeric = rows[0].filter((c) => Number.isFinite(numOf(c))).length;
  const hasHeader = firstNumeric < Math.max(1, Math.floor(rows[0].length / 2));
  const header = hasHeader ? rows[0].map((h) => h.toLowerCase()) : null;
  const body = hasHeader ? rows.slice(1) : rows;
  if (!body.length) throw new Error("no data rows under the header");

  /* Pick the value column. A named one beats a positional guess. */
  let col = -1, unitHint = null;
  if (header) {
    const named = [
      [/k?wh|m?wh|energy|consumption|usage|import/, "kwh"],
      [/\b[km]?w\b|power|demand|load/, "kw"],
    ];
    for (const [re, unit] of named) {
      const i = header.findIndex((h) => re.test(h));
      if (i >= 0) { col = i; unitHint = unit; break; }
    }
  }
  if (col < 0) {
    /* The last column that is numeric on most rows. Timestamps sit on
       the left and the reading on the right in almost every export. */
    for (let c = width - 1; c >= 0; c--) {
      const good = body.filter((r) => Number.isFinite(numOf(r[c]))).length;
      if (good > body.length * 0.8) { col = c; break; }
    }
    if (col >= 0) warnings.push(
      `No column was named as a load, so column ${col + 1} was used — the last one that is `
      + "numeric throughout. Check that is the reading and not a meter index or a cost.");
  }
  if (col < 0) throw new Error("no column in this file is numeric enough to be a load reading");
  /* Checked after the column is settled, however it was settled. */
  if (header && /\bm(w|wh)\b|megawatt/.test(header[col] || "")) warnings.push(
    "The column header mentions MW or MWh. Values are read as given and treated as kW or kWh — "
    + "multiply by 1,000 before importing if the file really is in megawatts.");

  const raw = [];
  for (const r of body) {
    const v = numOf(r[col]);
    if (Number.isFinite(v)) raw.push(v);
  }
  if (raw.length < 12) throw new Error(`only ${raw.length} numeric rows — too few to build a year`);
  if (raw.some((v) => v < 0)) warnings.push(
    "Some readings are negative, which usually means export is in the same column as import. "
    + "They are floored at zero here; a battery sized on a load that goes negative is being "
    + "sized on the wrong series.");

  /* Resolution from the count. */
  const n = raw.length;
  let perHour, resolution;
  if (n >= 34000 && n <= 36000) { perHour = 4; resolution = "quarter-hourly"; }
  else if (n >= 17000 && n <= 18000) { perHour = 2; resolution = "half-hourly"; }
  else if (n >= 8600 && n <= 8800) { perHour = 1; resolution = "hourly"; }
  else if (n >= 360 && n <= 370) { perHour = 1 / 24; resolution = "daily"; }
  else if (n === 12) { perHour = null; resolution = "monthly"; }
  else {
    perHour = n / 8760; resolution = `${n} rows`;
    warnings.push(
      `${n} rows is not a whole year at any usual resolution, so the series was resampled onto `
      + "8,760 hours. Check the file covers exactly one year and has no gaps — a missing day "
      + "shifts everything after it.");
  }

  /* kW is average power over the interval, so energy is power × hours.
     kWh is already energy and passes through. */
  const unit = opts.unit || unitHint || (perHour && perHour > 1 ? "kw" : "kwh");
  if (!opts.unit && !unitHint) warnings.push(
    `Nothing in the file says whether the readings are kW or kWh, so they are being treated as `
    + `${unit === "kw" ? "kW (power)" : "kWh (energy)"}. At ${resolution} resolution that choice `
    + "changes the annual total, so set it by hand if the total below looks wrong.");

  let load;
  if (resolution === "monthly") {
    load = loadFromMonthly(raw.map((v) => Math.max(0, v)), opts.shape || "residential",
      opts.weekendFactor ?? 1);
  } else {
    load = new Float64Array(8760);
    const intervalH = perHour >= 1 ? 1 / perHour : 24;
    for (let h = 0; h < 8760; h++) {
      if (perHour >= 1) {
        /* Sum the sub-hour readings that fall in this hour. */
        let acc = 0;
        for (let k = 0; k < perHour; k++) {
          const i = Math.min(raw.length - 1, Math.round(h * perHour + k));
          const v = Math.max(0, raw[i]);
          acc += unit === "kw" ? v * intervalH : v;
        }
        load[h] = acc;
      } else {
        /* Daily or coarser: spread the day's figure over its hours using
           the residential shape rather than flat, because a flat day
           would make the battery look useless. */
        const d = Math.min(raw.length - 1, Math.floor(h / 24));
        const day = DAY_SHAPES[opts.shape || "residential"] || DAY_SHAPES.residential;
        const v = Math.max(0, raw[d]);
        load[h] = (unit === "kw" ? v * 24 : v) * day[h % 24];
      }
    }
    if (perHour < 1) warnings.push(
      "The file is daily or coarser, so the within-day shape is assumed rather than measured. "
      + "The totals are real; when the load falls inside each day is not, and that is exactly "
      + "what decides whether a battery helps.");
  }

  let annualKWh = 0;
  for (let h = 0; h < 8760; h++) annualKWh += load[h];
  let peakKW = 0;
  for (let h = 0; h < 8760; h++) if (load[h] > peakKW) peakKW = load[h];

  return {
    load, annualKWh, peakKW, rows: n, resolution, unit,
    column: col + 1, columnName: header ? header[col] : null,
    hasHeader, warnings,
  };
}

/** Day-of-week and hour-of-day averages, for showing a profile back. */
export function profileSummary(load) {
  const byHour = new Array(24).fill(0);
  const byMonth = new Array(12).fill(0);
  for (let h = 0; h < 8760; h++) {
    byHour[h % 24] += load[h];
    let m = 0; while (m < 11 && h >= MONTH_START[m + 1]) m++;
    byMonth[m] += load[h];
  }
  return { byHour: byHour.map((v) => v / 365), byMonth };
}
