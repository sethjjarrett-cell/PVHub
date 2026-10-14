/* =====================================================================
   COSTING  —  a quote library, and what it does to LCOE

   The money in this tool comes from quotes you have actually received.
   Nothing here ships with a price in it.

   That is a deliberate refusal rather than an omission. Module prices,
   EPC rates and grid connection charges move faster than any figure
   could be embedded and stay true, and a plausible-looking default
   gets used — it ends up in a board paper with nobody remembering
   where it came from. A tool that holds your real numbers and tells
   you how old they are is worth more than one that invents fresh ones.

   So the unit of this module is the QUOTE: a set of costs, for a named
   project, in a named country, in a stated currency, priced on a
   stated date, from a stated source. Everything else follows from
   that.

   Three consequences that shape the design:

     AGE IS A PROPERTY, NOT A FOOTNOTE.  A quote carries the date it
     was priced and the tool reports its age everywhere it is used. A
     2023 module price and a 2026 module price are different numbers
     and the difference is larger than most of the engineering.

     ESCALATION NEVER OVERWRITES.  An old quote can be indexed forward
     to a stated date, and the escalated figure is marked as escalated
     with the original kept beside it — the same convention the cable
     tools use for an overridden derating factor. You can always see
     what was quoted and what was assumed.

     INDICES ARE DERIVED, NOT ASSUMED.  If you want to know what a
     German price implies for Kenya, the answer comes from dividing one
     of your quotes by another, per line. That is a real observation
     from your own data. Any number I made up would not be.

   No React, no dependencies — testable from node.
   ===================================================================== */

/* ---------------------------------------------------------------
   1.  REGIONS  —  what is knowable without a price list
   --------------------------------------------------------------- */

/**
 * The physical and structural facts of a market. No money.
 *
 * Soiling, degradation and availability follow climate and are
 * defensible as bands. The notes are context, not data. The
 * cost-of-capital band is a judgement and is labelled as one — it is
 * here because it moves LCOE more than any line in the capex does, so
 * leaving it out would be the bigger distortion.
 */
export const REGIONS = [
  { id: "eu", name: "Europe (general)", ccy: "EUR", sym: "€",
    soilingPct: 2.0, degradationPct: 0.45, availabilityPct: 99.0,
    discountRate: 6.0, discountBand: [4, 8],
    gridNote: "Connection charge and queue position usually bind before cost does; "
      + "reinforcement can be levied on the project.",
    note: "Low soiling, low irradiance. The small denominator means capex per watt "
      + "matters more here than in a sunny market." },
  { id: "de", name: "Germany", ccy: "EUR", sym: "€",
    soilingPct: 1.5, degradationPct: 0.40, availabilityPct: 99.2,
    discountRate: 5.0, discountBand: [3.5, 6.5],
    gridNote: "Well-defined connection process; land and permitting usually bind first.",
    note: "Cheap capital and a predictable process. Rain keeps modules clean." },
  { id: "uk", name: "United Kingdom", ccy: "GBP", sym: "£",
    soilingPct: 1.5, degradationPct: 0.40, availabilityPct: 99.0,
    discountRate: 6.0, discountBand: [4.5, 8],
    gridNote: "Connection queues and reinforcement are frequently the largest single "
      + "uncertainty in a budget. Get a budget estimate early.",
    note: "Ground conditions often drive piling cost — worth a separate line in a quote." },
  { id: "cl", name: "Chile / South America", ccy: "USD", sym: "$",
    soilingPct: 4.0, degradationPct: 0.55, availabilityPct: 98.5,
    discountRate: 8.0, discountBand: [6, 11],
    gridNote: "Long transmission distances and real curtailment risk in the north.",
    note: "Atacama irradiance is exceptional and so is the soiling — washing is an "
      + "operating cost line, not a rounding error." },
  { id: "af-e", name: "Africa East", ccy: "USD", sym: "$",
    soilingPct: 5.0, degradationPct: 0.60, availabilityPct: 97.5,
    discountRate: 12.0, discountBand: [9, 16],
    gridNote: "A dedicated line and substation is common rather than exceptional; weak "
      + "grids bring curtailment and sometimes a grid-forming requirement.",
    note: "Inland haulage from the coast can rival the sea freight, so a quote's delivery "
      + "terms matter as much as its unit rates. Record the Incoterm." },
  { id: "af-w", name: "Africa West", ccy: "USD", sym: "$",
    soilingPct: 6.0, degradationPct: 0.65, availabilityPct: 97.0,
    discountRate: 13.0, discountBand: [10, 18],
    gridNote: "Grid stability is frequently the binding constraint; hybrid with storage "
      + "or back-up generation is common.",
    note: "Harmattan dust gives the highest soiling here and it is seasonal rather than "
      + "steady, so an annual average understates the worst months badly." },
  { id: "af-s", name: "Africa South (excl. South Africa)", ccy: "USD", sym: "$",
    soilingPct: 4.5, degradationPct: 0.60, availabilityPct: 97.5,
    discountRate: 12.0, discountBand: [9, 16],
    gridNote: "Interconnection to the regional pool varies widely by country; single-buyer "
      + "offtake is the norm and shapes the financing.",
    note: "Mining loads are a large part of the market, and a captive plant is sized "
      + "against a load profile rather than a tariff." },
  { id: "za", name: "South Africa", ccy: "ZAR", sym: "R",
    soilingPct: 3.5, degradationPct: 0.55, availabilityPct: 98.5,
    discountRate: 11.0, discountBand: [9, 14],
    gridNote: "Curtailment and transmission capacity in the Cape provinces are the live "
      + "issue; wheeling arrangements are increasingly common.",
    note: "Local content requirements apply to public procurement and change the supply "
      + "chain, not only the price. Currency volatility matters as much as the rate." },
];

export const regionById = (id) => REGIONS.find((r) => r.id === id) || REGIONS[0];

/* ---------------------------------------------------------------
   2.  THE QUOTE
   --------------------------------------------------------------- */

/* Per-watt lines scale with plant size; lump lines do not. Keeping them
   apart is what stops a 5 MW substation quote being multiplied by
   fifty when it is applied to a 250 MW plant. */
export const COST_LINES = [
  { id: "modules", label: "PV modules", unit: "perWp" },
  { id: "structure", label: "Mounting structure or tracker", unit: "perWp" },
  { id: "inverters", label: "Inverters", unit: "perWp" },
  { id: "dcCable", label: "DC cable and combiners", unit: "perWp" },
  { id: "acCable", label: "AC and MV cable", unit: "perWp" },
  { id: "transformers", label: "Transformers and switchgear", unit: "perWp" },
  { id: "civil", label: "Civil, roads, drainage, fencing", unit: "perWp" },
  { id: "install", label: "Installation labour", unit: "perWp" },
  { id: "scada", label: "SCADA, monitoring, security", unit: "perWp" },
  { id: "epc", label: "EPC margin and preliminaries", unit: "perWp" },
  { id: "freight", label: "Freight, duty and clearance", unit: "perWp" },
  { id: "substation", label: "Substation and grid connection", unit: "lump" },
  { id: "dev", label: "Development, permits, studies", unit: "lump" },
  { id: "land", label: "Land purchase, if bought", unit: "lump" },
];

export const SOURCES = [
  { value: "supplier", label: "Supplier quotation" },
  { value: "epc", label: "EPC tender return" },
  { value: "contracted", label: "Contracted price" },
  { value: "internal", label: "Internal estimate" },
  { value: "benchmark", label: "Published benchmark" },
];

export const emptyQuote = (over = {}) => ({
  id: `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
  name: "", project: "", country: "", regionId: "eu",
  datePriced: new Date().toISOString().slice(0, 10),
  currency: "EUR", symbol: "€",
  source: "supplier", status: "budget",
  kWpBasis: 0, incoterm: "", notes: "",
  lines: Object.fromEntries(COST_LINES.map((l) => [l.id, 0])),
  ...over,
});

/* ---------------------------------------------------------------
   3.  AGE
   --------------------------------------------------------------- */

/** Whole months between a quote's pricing date and a reference date. */
export function quoteAgeMonths(quote, asOf = new Date()) {
  if (!quote?.datePriced) return null;
  const d = new Date(quote.datePriced);
  if (Number.isNaN(d.getTime())) return null;
  const ref = asOf instanceof Date ? asOf : new Date(asOf);
  return (ref.getFullYear() - d.getFullYear()) * 12 + (ref.getMonth() - d.getMonth())
    + (ref.getDate() >= d.getDate() ? 0 : -1);
}

/* Thresholds are stated rather than hidden because they are a
   judgement, not a standard. Six months is roughly how long a module
   quotation is normally held open; two years is long enough that the
   supply chain has usually moved underneath it. */
export const STALENESS = [
  { id: "fresh", maxMonths: 6, label: "current", tone: "ok" },
  { id: "ageing", maxMonths: 18, label: "ageing", tone: "warn" },
  { id: "stale", maxMonths: Infinity, label: "stale", tone: "bad" },
];

export function stalenessOf(quote, asOf = new Date()) {
  const m = quoteAgeMonths(quote, asOf);
  if (m === null) return { id: "unknown", label: "no date", tone: "bad", months: null };
  const band = STALENESS.find((s) => m < s.maxMonths) || STALENESS[STALENESS.length - 1];
  return { ...band, months: m };
}

/**
 * Index a quote forward to a date, without losing what was quoted.
 *
 * Returns a copy whose lines are escalated and which carries
 * `escalatedFrom` — the original date, the rate used and the original
 * lines. Nothing about the original is destroyed, so the interface can
 * always show the quoted figure beside the escalated one, and a reader
 * can tell the difference between a price someone gave you and a price
 * you assumed.
 */
export function escalate(quote, ratePctPerYear, toDate = new Date()) {
  const months = quoteAgeMonths(quote, toDate);
  if (months === null || months <= 0 || !(ratePctPerYear !== 0)) {
    return { ...quote, escalatedFrom: null };
  }
  const f = Math.pow(1 + ratePctPerYear / 100, months / 12);
  return {
    ...quote,
    lines: Object.fromEntries(Object.entries(quote.lines).map(([k, v]) => [k, (Number(v) || 0) * f])),
    escalatedFrom: {
      datePriced: quote.datePriced, months, ratePctPerYear, factor: f,
      lines: { ...quote.lines },
      toDate: (toDate instanceof Date ? toDate : new Date(toDate)).toISOString().slice(0, 10),
    },
  };
}

/* ---------------------------------------------------------------
   4.  WHAT A QUOTE COSTS AT A GIVEN SIZE
   --------------------------------------------------------------- */

/**
 * Apply a quote to a plant size.
 *
 * Lump sums are the trap. A quote priced at 5 MW carries a substation
 * and a development cost that belong to a 5 MW plant; applying them
 * unchanged to 100 MW understates, and scaling them per watt
 * overstates. Neither is right, so the caller chooses, and the choice
 * is reported: `lumpMode` is "asQuoted" (keep the lump), "perWp"
 * (scale it linearly, which is usually too harsh) or "scaled" (apply a
 * power law, the usual engineering rule of thumb for plant of this
 * kind, with the exponent as an input).
 */
export function quoteAt(quote, kWp, { lumpMode = "scaled", lumpExponent = 0.7 } = {}) {
  const basisKWp = Number(quote.kWpBasis) || 0;
  const lines = [];
  let perWpTotal = 0, lumpTotal = 0;
  for (const l of COST_LINES) {
    const v = Number(quote.lines?.[l.id]) || 0;
    if (l.unit === "perWp") {
      lines.push({ ...l, quoted: v, applied: v, amount: v * kWp * 1000, scaling: null });
      perWpTotal += v;
    } else {
      let applied = v, scaling = "as quoted";
      if (basisKWp > 0 && kWp > 0 && basisKWp !== kWp) {
        if (lumpMode === "perWp") { applied = v * (kWp / basisKWp); scaling = "linear with size"; }
        else if (lumpMode === "scaled") {
          applied = v * Math.pow(kWp / basisKWp, lumpExponent);
          scaling = `size^${lumpExponent}`;
        }
      }
      lines.push({ ...l, quoted: v, applied, amount: applied, scaling });
      lumpTotal += applied;
    }
  }
  const capex = perWpTotal * kWp * 1000 + lumpTotal;
  return { lines, capex, perWp: kWp > 0 ? capex / (kWp * 1000) : 0,
    perWpLines: perWpTotal, lumpTotal, basisKWp, lumpMode, lumpExponent };
}

/**
 * What one of your quotes implies about another market, per line.
 *
 * This is the only honest way to get a regional index: divide a real
 * quote by a real quote. It reports the ratio for every line that both
 * carry, and says which lines one of them is missing rather than
 * treating a zero as a price.
 */
export function deriveIndices(base, other) {
  const out = [];
  for (const l of COST_LINES) {
    const a = Number(base.lines?.[l.id]) || 0;
    const b = Number(other.lines?.[l.id]) || 0;
    out.push({ ...l, base: a, other: b,
      ratio: a > 0 && b > 0 ? b / a : null,
      missing: a > 0 && b === 0 ? "other" : b > 0 && a === 0 ? "base" : a === 0 && b === 0 ? "both" : null });
  }
  const usable = out.filter((x) => x.ratio !== null);
  return {
    lines: out, usable: usable.length,
    sameCurrency: base.currency === other.currency,
    monthsApart: Math.abs((quoteAgeMonths(base, new Date()) ?? 0) - (quoteAgeMonths(other, new Date()) ?? 0)),
  };
}

/* ---------------------------------------------------------------
   5.  ENERGY, OPEX, LCOE
   --------------------------------------------------------------- */

export function energySeries({ kWp, specificYield, soilingPct = 0, availabilityPct = 100,
  degradationPct = 0.5, years = 25 }) {
  const gross = kWp * specificYield;
  const net1 = gross * (1 - soilingPct / 100) * (availabilityPct / 100);
  const out = [];
  for (let t = 1; t <= years; t++) out.push(net1 * Math.pow(1 - degradationPct / 100, t - 1));
  return out;
}

/**
 * Operating cost each year.
 *
 * Inverter replacement is a lump in a stated year rather than smeared
 * across the life, because that is how it is spent and because
 * discounting a lump in year twelve gives a materially different answer
 * from the equivalent annuity.
 */
export function opexSeries({ kWp, omPerKWpYr = 0, landLeaseYr = 0, insurancePctCapex = 0,
  capex = 0, assetMgmtYr = 0, inflationPct = 0, years = 25,
  inverterReplaceYear = 0, inverterReplacePerWp = 0 }) {
  const base = kWp * omPerKWpYr + landLeaseYr + assetMgmtYr + capex * (insurancePctCapex / 100);
  const out = [];
  for (let t = 1; t <= years; t++) {
    let v = base * Math.pow(1 + inflationPct / 100, t - 1);
    if (inverterReplaceYear > 0 && t === inverterReplaceYear) v += inverterReplacePerWp * kWp * 1000;
    out.push(v);
  }
  return out;
}

const disc = (series, rate) =>
  series.reduce((a, v, i) => a + v / Math.pow(1 + rate / 100, i + 1), 0);

/**
 * Levelised cost of energy.
 *
 *     LCOE = [ Capex + Σ Opex_t/(1+r)^t ] / [ Σ E_t/(1+r)^t ]
 *
 * The energy is discounted as well as the money. That looks wrong the
 * first time — discounting kilowatt-hours has no physical meaning — but
 * it is what makes LCOE the price at which discounted revenue exactly
 * covers discounted cost, which is the only thing LCOE is for. Leaving
 * the denominator undiscounted gives a smaller number that cannot be
 * compared with anything, including another LCOE.
 */
export function lcoe({ capex, opex, energy, discountRate }) {
  const dOpex = disc(opex, discountRate);
  const dEnergy = disc(energy, discountRate);
  if (!(dEnergy > 0)) return { lcoe: null, dOpex, dEnergy, totalDiscountedCost: capex + dOpex };
  return { lcoe: (capex + dOpex) / dEnergy, dOpex, dEnergy,
    totalDiscountedCost: capex + dOpex, capexShare: capex / (capex + dOpex) };
}

export function npv(cashflows, rate) {
  return cashflows.reduce((a, v, i) => a + v / Math.pow(1 + rate / 100, i), 0);
}

/**
 * Internal rate of return by bisection.
 *
 * Bisection rather than Newton because it cannot diverge, and a bracket
 * with no sign change is reported as no solution rather than as a
 * number. A cash flow that never turns positive has no IRR, and saying
 * so beats returning the edge of the search.
 */
export function irr(cashflows, lo = -90, hi = 200, iterations = 200) {
  const f = (r) => npv(cashflows, r);
  let a = lo, b = hi, fa = f(a), fb = f(b);
  if (!(Number.isFinite(fa) && Number.isFinite(fb)) || fa * fb > 0) return null;
  for (let i = 0; i < iterations; i++) {
    const m = (a + b) / 2, fm = f(m);
    if (fa * fm <= 0) { b = m; fb = fm; } else { a = m; fa = fm; }
  }
  return (a + b) / 2;
}

/** The whole model, from one quote. */
export function evaluate({
  quote, kWp, specificYield, region = null,
  years = 25, discountRate = null, inflationPct = 0,
  soilingPct = null, availabilityPct = null, degradationPct = null,
  lumpMode = "scaled", lumpExponent = 0.7,
  omPerKWpYr = 0, landLeaseYr = 0, insurancePctCapex = 0, assetMgmtYr = 0,
  inverterReplaceYear = 0, inverterReplacePerWp = 0,
  tariff = null, tariffEscalationPct = 0, asOf = new Date(),
}) {
  const r = region || regionById(quote?.regionId);
  const rate = discountRate ?? r.discountRate;
  const soil = soilingPct ?? r.soilingPct;
  const avail = availabilityPct ?? r.availabilityPct;
  const deg = degradationPct ?? r.degradationPct;

  const cap = quoteAt(quote, kWp, { lumpMode, lumpExponent });
  const energy = energySeries({ kWp, specificYield, soilingPct: soil,
    availabilityPct: avail, degradationPct: deg, years });
  const opex = opexSeries({ kWp, omPerKWpYr, landLeaseYr, insurancePctCapex,
    capex: cap.capex, assetMgmtYr, inflationPct, years,
    inverterReplaceYear, inverterReplacePerWp });
  const l = lcoe({ capex: cap.capex, opex, energy, discountRate: rate });

  let revenue = null, cash = null, projectNpv = null, projectIrr = null, payback = null;
  if (tariff !== null && tariff !== undefined && tariff > 0) {
    revenue = energy.map((e, i) => e * tariff * Math.pow(1 + tariffEscalationPct / 100, i));
    cash = [-cap.capex, ...revenue.map((rv, i) => rv - opex[i])];
    projectNpv = npv(cash, rate);
    projectIrr = irr(cash);
    let run = -cap.capex;
    for (let i = 0; i < revenue.length; i++) {
      const net = revenue[i] - opex[i];
      if (run + net >= 0 && net > 0) { payback = i + (-run) / net; break; }
      run += net;
    }
  }

  return {
    quote, region: r, staleness: stalenessOf(quote, asOf), capex: cap,
    energy, opex, revenue, cash, rate,
    soilingPct: soil, availabilityPct: avail, degradationPct: deg,
    lcoe: l.lcoe, discountedEnergy: l.dEnergy, discountedOpex: l.dOpex, capexShare: l.capexShare,
    lifetimeEnergy: energy.reduce((a, b) => a + b, 0), year1Energy: energy[0] ?? 0,
    npv: projectNpv, irr: projectIrr, payback,
  };
}

/**
 * Rank a set of quotes.
 *
 * The comparison is only as good as the quotes are comparable, so it
 * carries the warnings rather than leaving them to be noticed: mixed
 * currencies cannot be ranked on money at all without a rate, and
 * quotes priced far apart in time are being compared across a market
 * that moved in between.
 */
export function compareQuotes(quotes, params) {
  const rows = quotes.map((q) => {
    const r = evaluate({ ...params, quote: q, region: regionById(q.regionId) });
    return { quote: q, region: r.region, staleness: r.staleness, lcoe: r.lcoe,
      perWp: r.capex.perWp, capex: r.capex.capex, rate: r.rate,
      year1Energy: r.year1Energy, currency: q.currency, symbol: q.symbol };
  });
  const currencies = [...new Set(quotes.map((q) => q.currency))];
  const months = quotes.map((q) => quoteAgeMonths(q, params.asOf || new Date()))
    .filter((m) => m !== null);
  const warnings = [];
  if (currencies.length > 1) warnings.push(
    `These quotes are in ${currencies.length} currencies (${currencies.join(", ")}). `
    + "Money is not converted anywhere in this tool, so the cost columns are not comparable "
    + "until you bring them to one currency yourself.");
  if (months.length > 1) {
    const spread = Math.max(...months) - Math.min(...months);
    if (spread >= 12) warnings.push(
      `The oldest and newest of these were priced ${spread} months apart. Over that spread the `
      + "supply chain has usually moved, so a difference between them is partly a difference in "
      + "date rather than in market. Escalate the older ones to a common date before reading too "
      + "much into the ranking.");
  }
  const stale = rows.filter((r) => r.staleness.id === "stale");
  if (stale.length) warnings.push(
    `${stale.length} of these ${stale.length === 1 ? "is" : "are"} over 18 months old `
    + `(${stale.map((r) => r.quote.name || "unnamed").join(", ")}).`);
  return { rows: rows.sort((a, b) => (a.lcoe ?? Infinity) - (b.lcoe ?? Infinity)), warnings, currencies };
}

/* ---------------------------------------------------------------
   6.  CSV, so the library can live outside this tool
   --------------------------------------------------------------- */

const csvEscape = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function quotesToCsv(quotes) {
  const head = ["name", "project", "country", "regionId", "datePriced", "currency", "symbol",
    "source", "status", "kWpBasis", "incoterm", "notes", ...COST_LINES.map((l) => l.id)];
  const rows = quotes.map((q) => [
    q.name, q.project, q.country, q.regionId, q.datePriced, q.currency, q.symbol,
    q.source, q.status, q.kWpBasis, q.incoterm, q.notes,
    ...COST_LINES.map((l) => q.lines?.[l.id] ?? 0),
  ]);
  return [head, ...rows].map((r) => r.map(csvEscape).join(",")).join("\n");
}

/** Split a CSV line, honouring quoted fields with commas in them. */
function splitCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

export function quotesFromCsv(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) throw new Error("the file needs a header row and at least one quote");
  const head = splitCsvLine(lines[0]).map((h) => h.trim());
  const idx = (k) => head.indexOf(k);
  if (idx("datePriced") < 0) throw new Error("no datePriced column — a quote without a date is not usable");
  const warnings = [];
  const quotes = lines.slice(1).map((l, n) => {
    const c = splitCsvLine(l);
    const get = (k, d = "") => { const i = idx(k); return i >= 0 ? c[i].trim() : d; };
    const num = (k) => { const v = Number(get(k, "0")); return Number.isFinite(v) ? v : 0; };
    const date = get("datePriced");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) warnings.push(
      `Row ${n + 2}: "${date}" is not an ISO date (YYYY-MM-DD), so its age cannot be worked out.`);
    return emptyQuote({
      name: get("name"), project: get("project"), country: get("country"),
      regionId: get("regionId", "eu"), datePriced: date,
      currency: get("currency", "EUR"), symbol: get("symbol", ""),
      source: get("source", "supplier"), status: get("status", "budget"),
      kWpBasis: num("kWpBasis"), incoterm: get("incoterm"), notes: get("notes"),
      lines: Object.fromEntries(COST_LINES.map((x) => [x.id, num(x.id)])),
    });
  });
  return { quotes, warnings };
}
