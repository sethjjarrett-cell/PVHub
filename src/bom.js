/* =====================================================================
   BILL OF MATERIALS
   ---------------------------------------------------------------------
   Quantities, not money. A rate per watt is a guess that ages badly and
   gets quoted back at you; a count of modules, tables, inverters and
   transformers is a fact about the design that a supplier can price.

   This follows the costing tool's refusal exactly: there are no prices
   in this file and none should be added. What it produces is the thing
   you send out to GET prices.

   Every line states how it was derived and what it assumed. A line that
   cannot be derived is listed as missing rather than estimated, because
   a BOM with an invented quantity on it is worse than a short one — the
   short one gets questioned.
   ================================================================== */

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Things a BOM needs that the rest of the flow does not ask for. */
export const BOM_INPUTS = [
  { key: "modulesPerTable", label: "Modules per table", unit: "", dp: 0,
    note: "One mounting structure's worth. A 2-high portrait table of 28 is common on "
      + "fixed tilt; a tracker row is far longer." },
  { key: "pilesPerTable", label: "Piles per table", unit: "", dp: 0,
    note: "Foundations. Leave at zero if the structural design is not settled — the line "
      + "is then left off rather than guessed." },
  { key: "transformerKva", label: "Transformer unit size", unit: "kVA", dp: 0,
    note: "The LV/MV unit. The count is the AC capacity divided by this, rounded up." },
];

/**
 * Build the bill of materials from a sized plant.
 * @returns {{lines: Array, missing: Array, assumptions: Array}}
 */
export function buildBom(p = {}) {
  const lines = [];
  const missing = [];
  const assumptions = [];

  const moduleCount = num(p.moduleCount);
  const moduleWp = num(p.moduleWp);
  const modulesInSeries = num(p.modulesInSeries);
  const nInverter = num(p.nInverter);
  const inverterKwac = num(p.inverterKwac);
  const modulesPerTable = num(p.modulesPerTable);
  const pilesPerTable = num(p.pilesPerTable);
  const transformerKva = num(p.transformerKva);

  const add = (item, qty, unit, how, spec) =>
    lines.push({ item, qty, unit, how, spec: spec || null });

  /* --- the array --- */
  if (moduleCount !== null && moduleCount > 0) {
    add("PV modules", moduleCount, "off",
      "the layout's own count, not a density assumption",
      moduleWp !== null ? `${moduleWp} Wp each` : null);
  } else missing.push("the module count, which comes from the layout");

  if (moduleCount !== null && modulesInSeries !== null && modulesInSeries > 0) {
    /* Floor, not round: a part-filled string is not a string. The
       remainder is reported because it is modules you have bought and
       cannot connect as planned. */
    const strings = Math.floor(moduleCount / modulesInSeries);
    const spare = moduleCount - strings * modulesInSeries;
    add("Strings", strings, "off",
      `${moduleCount} modules at ${modulesInSeries} in series`,
      spare > 0 ? `${spare} modules left over — short of a full string` : null);
    if (spare > 0) {
      assumptions.push(`${spare} module${spare > 1 ? "s" : ""} do not make up a full string. `
        + "Either the layout trims to a whole number of strings or those modules are spare.");
    }
  } else if (moduleCount !== null) {
    missing.push("the string length, for the string count");
  }

  /* --- the structures --- */
  if (moduleCount !== null && modulesPerTable !== null && modulesPerTable > 0) {
    /* Ceiling: a part-filled table is still a table you buy. */
    const tables = Math.ceil(moduleCount / modulesPerTable);
    add("Mounting tables", tables, "off",
      `${moduleCount} modules at ${modulesPerTable} per table, rounded up`,
      moduleCount % modulesPerTable !== 0
        ? `the last table carries ${moduleCount % modulesPerTable}` : "all tables full");
    if (pilesPerTable !== null && pilesPerTable > 0) {
      add("Piles", tables * pilesPerTable, "off",
        `${tables} tables at ${pilesPerTable} piles each`);
    } else {
      missing.push("piles per table, for the foundation count");
    }
  } else {
    missing.push("modules per table, for the structure count");
  }

  /* --- the electrical --- */
  const acKw = nInverter !== null && inverterKwac !== null ? nInverter * inverterKwac : null;
  if (nInverter !== null && nInverter > 0) {
    add("Inverters", nInverter, "off", "as configured",
      inverterKwac !== null ? `${inverterKwac} kWac each` : null);
  } else missing.push("the inverter count");

  if (acKw !== null && transformerKva !== null && transformerKva > 0) {
    /* Ceiling again, and the spare capacity is reported: a plant that
       needs 4.1 units buys 5 and runs them at 82%, which is worth
       seeing before it is ordered. */
    const units = Math.ceil(acKw / transformerKva);
    const loading = Math.round((acKw / (units * transformerKva)) * 1000) / 10;
    add("Transformers", units, "off",
      `${acKw} kW of inverters at ${transformerKva} kVA per unit, rounded up`,
      `${loading}% loaded`);
    if (loading < 70) {
      assumptions.push(`The transformers would run at ${loading}%, which is a lot of unit `
        + "doing nothing. A smaller unit size, or one fewer, may suit the design better.");
    }
  } else if (acKw !== null) {
    missing.push("a transformer unit size, for the transformer count");
  }

  return { lines, missing, assumptions };
}

/** What the BOM does NOT cover, said out loud rather than left to be
    discovered when a price comes back short. */
export const BOM_EXCLUSIONS = [
  "Cable, of any kind. The lengths come off a routed layout, not off a module count — the "
    + "Layout tool measures them and the Cable tabs size them.",
  "Civils: access tracks, fencing, drainage, the substation building. These follow the site "
    + "boundary and the ground conditions, neither of which a module count knows about.",
  "The grid connection, protection and metering, which are priced by the DNO or the "
    + "utility rather than by a supplier.",
  "Spares, commissioning, and anything that depends on the contract rather than the design.",
];

/** CSV for sending out to suppliers. */
/* The CSV goes to a procurement inbox, so it is written in pure ASCII. A
   BOM-less UTF-8 file opened in Excel on Windows is read as Windows-1252,
   which turns the em dashes this tool uses on screen into mojibake in the
   one column a bidder reads most closely. The same refusal the PVsyst batch
   writer makes, for the same reason. The screen text keeps its typography;
   only the file is folded down. */
const ASCII = [[/[\u2014\u2013]/g, "-"], [/[\u2018\u2019]/g, "'"], [/[\u201c\u201d]/g, '"'],
  [/\u00d7/g, "x"], [/\u00b2/g, "^2"], [/\u00b3/g, "^3"], [/\u00b0/g, " deg"],
  [/\u2264/g, "<="], [/\u2265/g, ">="], [/\u2192/g, "->"], [/\u00b7/g, "."],
  [/\u2026/g, "..."], [/\u00a0/g, " "]];
export function asciify(v) {
  let s = v === null || v === undefined ? "" : String(v);
  for (const [re, to] of ASCII) s = s.replace(re, to);
  /* Anything still outside ASCII would arrive as a question mark or worse,
     so it is dropped rather than guessed at. */
  return s.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, "");
}

export function bomToCsv(bom, meta = {}) {
  const esc = (v) => {
    const s = asciify(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [
    ["Bill of materials", meta.project || ""],
    ["Generated", new Date().toISOString().slice(0, 10)],
    [],
    ["Item", "Quantity", "Unit", "Specification", "How it was derived"],
    ...bom.lines.map((l) => [l.item, l.qty, l.unit, l.spec || "", l.how]),
  ];
  if (bom.missing.length) {
    rows.push([], ["Not included because an input is missing"]);
    for (const m of bom.missing) rows.push([m]);
  }
  rows.push([], ["Excluded by scope"]);
  for (const x of BOM_EXCLUSIONS) rows.push([x]);
  return rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
}
