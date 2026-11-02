/* ---------------------------------------------------------------
   Radial LV distribution network: fault levels, conductor withstand
   and protective-conductor sizing.

   The question this answers is the one a cable sized for load current
   and volt drop never asks: when a fault lands on it, does the
   conductor survive the time the breaker takes to clear? That is a
   thermal check, and it is invisible in normal operation — the cable
   runs perfectly right up until the day it does not.

   Three standards carry the work:

     IEC 60909-0   the fault current itself, and the c factor
     IEC 60364-5-54  the adiabatic equation, the k values (Annex A)
                     and Table 54.2 for the protective conductor
     IEC 60228     conductor resistance at 20 degrees C

   No React in here. The tables are reproduced verbatim from the
   standard so the interface can show the row a value was read from,
   which is the convention everywhere else in this application.
   --------------------------------------------------------------- */

import { CONDUCTOR, SIZES, AL_R20, CU_R20, adiabaticK, materialK } from "./cableData.js";

const num = (v) => (v === null || v === undefined || v === "" || Number.isNaN(+v) ? null : +v);
const r3 = (v) => Math.round(v * 1000) / 1000;

/* ---------------------------------------------------------------
   1.  IEC 60364-5-54 Annex A — the k tables
   ---------------------------------------------------------------

   k is the factor in S = sqrt(I^2 t) / k. It depends on the conductor
   material, what is around it and the two temperatures it travels
   between, which is why there are five tables rather than one: the
   same copper conductor is k = 143 loose in a conduit and k = 115 as a
   core inside a cable, because inside the cable it is already sitting
   at the line conductor's operating temperature when the fault starts.

   Each cell is [value at or below 300 mm2, value above 300 mm2]. The
   standard prints these as "143/133" with a footnote, and the footnote
   is the trap: a 400 mm2 PVC conductor taken at 143 is undersized by
   7%. Rows where the standard prints one number carry it twice. */

const K = (le300, gt300) => [le300, gt300 === undefined ? le300 : gt300];

export const K_TABLES = {
  a542: {
    id: "a542",
    ref: "IEC 60364-5-54 Table A.54.2",
    title: "Insulated protective conductor, not incorporated in a cable and not bunched with other cables",
    hint: "A separate CPC in its own insulation — a conduit or trunking run, or a loose earth core.",
    rows: [
      { ins: "pvc70",  name: "70 °C thermoplastic (PVC)",            ti: 30, tf: K(160, 140), copper: K(143, 133), aluminium: K(95, 88), steel: K(52, 49) },
      { ins: "pvc90",  name: "90 °C thermoplastic (PVC)",            ti: 30, tf: K(160, 140), copper: K(143, 133), aluminium: K(95, 88), steel: K(52, 49) },
      { ins: "xlpe",   name: "90 °C thermosetting (XLPE, EPR)",      ti: 30, tf: K(250),      copper: K(176),      aluminium: K(116),    steel: K(64) },
      { ins: "epr60",  name: "60 °C thermosetting (EPR rubber)",     ti: 30, tf: K(200),      copper: K(159),      aluminium: K(105),    steel: K(58) },
      { ins: "epr85",  name: "85 °C thermosetting (EPR rubber)",     ti: 30, tf: K(220),      copper: K(166),      aluminium: K(110),    steel: K(60) },
      { ins: "sil185", name: "185 °C thermosetting (silicone rubber)", ti: 30, tf: K(350),    copper: K(201),      aluminium: K(133),    steel: K(73) },
    ],
  },
  a543: {
    id: "a543",
    ref: "IEC 60364-5-54 Table A.54.3",
    title: "Bare protective conductor in contact with cable covering but not bunched with other cables",
    hint: "A bare earth laid against the sheath of the cable it protects.",
    rows: [
      { ins: "pvc200", name: "Thermoplastic (PVC) polyethylene, 200 °C final", ti: 30, tf: K(200), copper: K(159), aluminium: K(105), steel: K(58) },
      { ins: "pvc150", name: "Thermoplastic (PVC) polyethylene, 150 °C final", ti: 30, tf: K(150), copper: K(138), aluminium: K(91),  steel: K(50) },
      { ins: "csp",    name: "CSP (chloro-sulphonated polyethylene)",          ti: 30, tf: K(220), copper: K(166), aluminium: K(110), steel: K(60) },
    ],
  },
  a544: {
    id: "a544",
    ref: "IEC 60364-5-54 Table A.54.4",
    title: "Protective conductor as a core incorporated in a cable, or bunched with other cables or insulated conductors",
    hint: "The usual case for a distribution circuit: a four- or five-core cable, or an earth core run inside the same multicore.",
    rows: [
      { ins: "pvc70",  name: "70 °C thermoplastic (PVC)",             ti: 70,  tf: K(160, 140), copper: K(115, 103), aluminium: K(76, 68), steel: K(42, 37) },
      { ins: "pvc90",  name: "90 °C thermoplastic (PVC)",             ti: 90,  tf: K(160, 140), copper: K(100, 86),  aluminium: K(66, 57), steel: K(36, 31) },
      { ins: "xlpe",   name: "90 °C thermosetting (XLPE, EPR)",       ti: 90,  tf: K(250),      copper: K(143),      aluminium: K(94),     steel: K(52) },
      { ins: "epr60",  name: "60 °C thermosetting (rubber)",          ti: 60,  tf: K(200),      copper: K(141),      aluminium: K(93),     steel: K(51) },
      { ins: "epr85",  name: "85 °C thermosetting (rubber)",          ti: 85,  tf: K(220),      copper: K(134),      aluminium: K(89),     steel: K(48) },
      { ins: "sil185", name: "185 °C thermosetting (silicone rubber)", ti: 180, tf: K(350),     copper: K(132),      aluminium: K(87),     steel: K(47) },
    ],
  },
  a545: {
    id: "a545",
    ref: "IEC 60364-5-54 Table A.54.5",
    title: "Protective conductor as a metallic layer of a cable — armour, metallic sheath, concentric conductor",
    hint: "Using the steel wire armour or the sheath as the earth path. Note the much lower k for steel.",
    rows: [
      { ins: "pvc70",  name: "70 °C thermoplastic (PVC)",       ti: 60,  tf: K(200), copper: K(141), aluminium: K(93), steel: K(51) },
      { ins: "pvc90",  name: "90 °C thermoplastic (PVC)",       ti: 80,  tf: K(200), copper: K(128), aluminium: K(85), steel: K(46) },
      { ins: "xlpe",   name: "90 °C thermosetting (XLPE, EPR)", ti: 80,  tf: K(200), copper: K(128), aluminium: K(85), steel: K(46) },
      { ins: "epr60",  name: "60 °C thermosetting (rubber)",    ti: 55,  tf: K(200), copper: K(144), aluminium: K(95), steel: K(52) },
      { ins: "epr85",  name: "85 °C thermosetting (rubber)",    ti: 75,  tf: K(220), copper: K(140), aluminium: K(93), steel: K(51) },
      { ins: "minpvc", name: "Mineral, thermoplastic (PVC) covered", ti: 70, tf: K(200), copper: K(135), aluminium: null, steel: null },
      { ins: "minbare", name: "Mineral, bare sheath",           ti: 105, tf: K(250), copper: K(135), aluminium: null, steel: null },
    ],
  },
  a546: {
    id: "a546",
    ref: "IEC 60364-5-54 Table A.54.6",
    title: "Bare conductors where there is no risk of damage to neighbouring material by the temperature indicated",
    hint: "An exposed earth bar or tape. The final temperature is set by what it is allowed to touch, not by insulation.",
    perMaterialTf: true,
    rows: [
      { ins: "visible", name: "Visible and in a restricted area", ti: 30, tfBy: { copper: 500, aluminium: 300, steel: 500 }, copper: K(228), aluminium: K(125), steel: K(82) },
      { ins: "normal",  name: "Normal conditions",                ti: 30, tfBy: { copper: 200, aluminium: 200, steel: 200 }, copper: K(159), aluminium: K(105), steel: K(58) },
      { ins: "fire",    name: "Fire risk",                        ti: 30, tfBy: { copper: 150, aluminium: 150, steel: 150 }, copper: K(138), aluminium: K(91),  steel: K(50) },
    ],
  },
};

export const K_TABLE_LIST = ["a544", "a542", "a543", "a545", "a546"];

/**
 * Read k out of the tables, carrying the row it came from so the
 * interface can show it. The >300 mm² footnote is applied here rather
 * than left to the caller, because that is precisely the step that
 * gets skipped.
 */
export function kFor({ table = "a544", insulation = "xlpe", material = "copper", size = 0 } = {}) {
  const t = K_TABLES[table];
  if (!t) return { k: null, miss: `no table ${table}` };
  const row = t.rows.find((r) => r.ins === insulation);
  if (!row) return { k: null, miss: `${t.ref} does not tabulate ${insulation}` };
  const cell = row[material];
  if (!cell) return { k: null, miss: `${t.ref} does not tabulate ${material} for ${row.name}` };
  const big = num(size) !== null && size > 300;
  const k = big ? cell[1] : cell[0];
  const tf = row.tfBy ? row.tfBy[material] : (big ? row.tf[1] : row.tf[0]);
  return {
    k, source: "table", ref: t.ref, table, insulation, material,
    row: row.name, thetaI: row.ti, thetaF: tf,
    /* The footnote only bites where the two cells differ, so saying so
       unconditionally would be noise. */
    footnote: big && cell[0] !== cell[1]
      ? `Above 300 mm² the standard's lower value applies: ${cell[1]}, not ${cell[0]}.`
      : null,
  };
}

/**
 * k from the Annex A formula rather than the table, for a case the
 * tables do not cover — an initial temperature the installation
 * actually sits at, say. It is returned flagged as derived and with
 * its arithmetic, because a number that is not in the standard must
 * never read as though it were. Same convention as an extrapolated
 * cable rating elsewhere in this tool.
 */
export function kDerived({ material = "copper", thetaI = 90, thetaF = 250 } = {}) {
  const m = CONDUCTOR[material];
  if (!m) return { k: null, miss: `unknown material ${material}` };
  const k = adiabaticK(m, thetaI, thetaF);
  return {
    k: Math.round(k * 10) / 10, source: "derived",
    ref: "IEC 60364-5-54 Annex A, formula",
    material, thetaI, thetaF,
    arithmetic: `k = ${Math.round(materialK(m))} × √(ln((${m.beta} + ${thetaF}) / (${m.beta} + ${thetaI}))) `
      + `= ${Math.round(k * 10) / 10}`,
    note: "Derived from the Annex A formula, not read from a table. Check it against the "
      + "tabulated case before using it in an issued design.",
  };
}

/* ---------------------------------------------------------------
   2.  IEC 60364-5-54 Table 54.2 — minimum protective conductor size
   ---------------------------------------------------------------

   The alternative to calculating. It is a rule of thumb written into
   the standard, and it is generous at small sizes and tight at large
   ones, which is why 543.1.2 lets you calculate instead and why this
   tool reports both and takes the larger. */

export const PE_TABLE_54_2 = {
  ref: "IEC 60364-5-54 Table 54.2",
  rows: [
    { upTo: 16,       same: "S",    label: "S ≤ 16",       rule: (S) => S },
    { upTo: 35,       same: "16",   label: "16 < S ≤ 35",  rule: () => 16 },
    { upTo: Infinity, same: "S / 2", label: "S > 35",      rule: (S) => S / 2 },
  ],
};

/** The next standard cross-sectional area at or above a calculated one.
 *  543.1.2: "a conductor having at least the nearest larger standard
 *  cross-sectional area shall be used". Never round down. */
export const nextStandardSize = (s) =>
  num(s) === null ? null : (SIZES.find((x) => x >= s - 1e-9) ?? null);

/**
 * Table 54.2 applied, including the k1/k2 correction for a protective
 * conductor of a different material from the line conductor. Returns
 * the raw figure and the standard size above it, with the row.
 */
export function peFromTable54_2({ sLine, k1 = null, k2 = null } = {}) {
  const S = num(sLine);
  if (S === null || S <= 0) return { raw: null, miss: "a line conductor size" };
  const row = PE_TABLE_54_2.rows.find((r) => S <= r.upTo);
  const base = row.rule(S);
  const differing = num(k1) !== null && num(k2) !== null && k1 !== k2;
  const factor = differing ? k1 / k2 : 1;
  const raw = base * factor;
  return {
    raw: Math.round(raw * 100) / 100,
    standard: nextStandardSize(raw),
    row: row.label, same: row.same, ref: PE_TABLE_54_2.ref,
    differing, k1: num(k1), k2: num(k2),
    arithmetic: differing
      ? `${row.same.replace("S", String(S))} × k₁/k₂ = ${Math.round(base * 100) / 100} × ${r3(factor)} = ${Math.round(raw * 100) / 100} mm²`
      : `${row.same.replace("S", String(S))} = ${Math.round(raw * 100) / 100} mm²`,
  };
}

/* ---------------------------------------------------------------
   3.  Sources and conductors
   --------------------------------------------------------------- */

/* IEC 60909-0 voltage factor c. Two values matter here: cmax sizes
   equipment and sets the worst thermal stress, cmin decides whether a
   protective device sees enough current to operate. Running one number
   for both is the common spreadsheet error, and it errs unsafely in
   one direction or the other whichever value is chosen. */
export const C_FACTOR = { max: 1.05, min: 0.95 };

/** Temperature coefficient of resistance, per K, referred to 20 °C.
 *  α = 1 / (β + 20) with β from Table A.54.1, so it stays consistent
 *  with the k values rather than being a second set of constants. */
export const alphaFor = (material) => 1 / (CONDUCTOR[material].beta + 20);

/* IEC 60228 tabulates copper and aluminium conductors. It does not
   tabulate steel, because steel in a cable is armour or a sheath
   rather than a conductor, and its resistance depends on the wire
   count and lay that the cable maker chose. Falling through to the
   copper table would understate a steel earth path by roughly eight
   times and silently turn a circuit that will not disconnect into one
   that appears to. So the lookup returns nothing and the caller says
   so. The adiabatic check on steel still works, because that needs
   only the area and k. */
const rTableFor = (material) => (material === "aluminium" ? AL_R20
  : material === "copper" ? CU_R20 : null);

/**
 * Conductor resistance, ohms, at a stated temperature.
 *
 * IEC 60228 tabulates at 20 °C and the correction runs from there. The
 * temperature to use is not a detail: a maximum fault current is taken
 * with the conductor cold, because that is when its resistance is
 * lowest and the current highest, and a minimum fault current is taken
 * with it at its operating temperature. The two answers differ by about
 * a third on a long run, and they are used for opposite purposes.
 */
export function conductorR({ size, material = "copper", lengthM = 0, parallel = 1, tempC = 20 } = {}) {
  const S = num(size), L = num(lengthM), n = Math.max(1, num(parallel) || 1);
  if (S === null || L === null) return null;
  const table = rTableFor(material);
  if (!table) return null;
  const row = table.find((r) => r.size === S);
  if (!row) return null;
  const r20 = row.r;                                   // Ω/m
  const f = 1 + alphaFor(material) * (tempC - 20);
  return (r20 * f * L) / n;
}

/** Whether IEC 60228 carries this size for this material at all. The
 *  tool says so rather than silently interpolating a resistance. */
export const hasR = (size, material) => {
  const t = rTableFor(material);
  return !!t && !!t.find((r) => r.size === num(size));
};
/** Whether IEC 60228 covers this material as a conductor at all. */
export const hasRTable = (material) => !!rTableFor(material);

/* Reactance is set by the spacing between conductor centres far more
   than by the conductor area, so one figure per arrangement is honest
   where a table per size would be false precision. Multicore cores sit
   close together; single-cores in trefoil a little further apart. */
export const X_PER_M = { multicore: 0.00008, trefoil: 0.00009, flat: 0.00013 };

/**
 * Transformer source impedance referred to its secondary.
 *
 * Z = (uk/100) × U² / S is the whole of it. Splitting that into R and X
 * needs a second figure: either the load loss, which a nameplate
 * carries, or an X/R ratio. X/R rises with rating — roughly 5 at
 * 500 kVA, 10 at 1 MVA, 15 at 2 MVA — and the default here is stated
 * rather than hidden, because on a short run it changes the answer by
 * only a per cent or two and on a long one not at all.
 */
export function transformerSource({ kva, ukPct, uSecV, xOverR = 10, c = 1.0 } = {}) {
  const S = num(kva), uk = num(ukPct), U = num(uSecV);
  if (!S || !uk || !U) return { miss: "transformer rating, impedance and secondary voltage" };
  const z = ((uk / 100) * U * U) / (S * 1000);
  const phi = Math.atan(xOverR);
  const r = z * Math.cos(phi), x = z * Math.sin(phi);
  const ik3 = (c * U) / (Math.sqrt(3) * z);
  return {
    z, r, x, ik3, c, xOverR,
    iRated: (S * 1000) / (Math.sqrt(3) * U),
    arithmetic: `Z = (${uk}/100) × ${U}² / ${S * 1000} = ${z.toExponential(3)} Ω; `
      + `Ik = ${c === 1 ? "" : `${c} × `}${U} / (√3 × ${z.toExponential(3)}) = ${Math.round(ik3)} A`,
  };
}

/**
 * An upstream network, given as a fault level in MVA at the point of
 * supply. Referred through to the voltage asked for.
 */
export function gridSource({ skMva, uV, c = 1.0 } = {}) {
  const S = num(skMva), U = num(uV);
  if (!S || !U) return { miss: "a fault level and a voltage" };
  const z = (c * U * U) / (S * 1e6);
  return { z, r: z * 0.1, x: z * 0.995, ik3: (c * U) / (Math.sqrt(3) * z), c };
}

/* ---------------------------------------------------------------
   4.  The network
   ---------------------------------------------------------------

   A radial tree: one source, then nodes each hanging off a parent by a
   cable. Flat list with parent ids rather than nested objects, because
   a flat list is trivial to edit in a form and the tree is rebuilt in
   one pass.

   Each node carries the cable feeding it and, optionally, the device
   protecting that cable. */

export const NODE_KINDS = {
  board: { name: "Distribution board", feeds: true },
  load:  { name: "Load / final circuit", feeds: false },
};

/** Complex magnitude of a series chain, kept as R and X to the end so
 *  the phase angle is not thrown away halfway. */
const mag = (r, x) => Math.hypot(r, x);

/**
 * Walk the tree from the source and work out, at every node, the fault
 * current available there.
 *
 * Two currents per node, and they are not interchangeable:
 *
 *   ik3max  three-phase symmetrical, cmax, conductors at 20 °C. The
 *           number that equipment must be rated to break and that the
 *           conductor must survive thermally.
 *   ik1min  line to protective conductor, cmin, conductors at their
 *           operating temperature. The number that decides whether the
 *           protective device actually operates. It is the smaller by
 *           a wide margin, and a design checked only on ik3max can
 *           carry a circuit that never trips.
 */
export function solveNetwork(net = {}) {
  const nodes = Array.isArray(net.nodes) ? net.nodes : [];
  const src = net.source || {};
  const U = num(src.uSecV) || 400;
  const u0 = num(src.u0V) || Math.round((U / Math.sqrt(3)) * 10) / 10;

  const mk = (c) => src.kind === "grid"
    ? gridSource({ skMva: src.skMva, uV: U, c })
    : transformerSource({ kva: src.kva, ukPct: src.ukPct, uSecV: U, xOverR: num(src.xOverR) ?? 10, c });

  const sMax = mk(C_FACTOR.max), sMin = mk(C_FACTOR.min);
  const sourceMiss = sMax.miss || null;

  /* Zero sequence of a Dyn transformer is close enough to its positive
     sequence that treating the earth loop as source + line + PE is the
     usual simplification. It is stated in the interface rather than
     buried, because on an impedance-earthed or a delta secondary it is
     simply wrong. */
  const base = sourceMiss
    ? { r: 0, x: 0 }
    : { r: sMax.r, x: sMax.x };
  const baseMin = sourceMiss ? { r: 0, x: 0 } : { r: sMin.r, x: sMin.x };

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map();
  const orphans = [];

  const resolve = (node, seen = new Set()) => {
    if (out.has(node.id)) return out.get(node.id);
    if (seen.has(node.id)) return null;                 // a loop; radial only
    seen.add(node.id);

    const parent = node.parent ? byId.get(node.parent) : null;
    if (node.parent && !parent) { orphans.push(node.id); return null; }
    const up = parent ? resolve(parent, seen) : {
      rMax: base.r, xMax: base.x, rMin: baseMin.r, xMin: baseMin.x,
      rLoopMin: baseMin.r, xLoopMin: baseMin.x, depth: 0,
    };
    if (!up) return null;

    const c = node.cable || {};
    const mat = c.material || "copper";
    const opC = num(c.operatingC) ?? 90;
    const xPer = X_PER_M[c.arrangement || "multicore"];
    const n = Math.max(1, num(c.parallel) || 1);
    const L = num(c.lengthM) || 0;

    const rLine20 = conductorR({ size: c.size, material: mat, lengthM: L, parallel: n, tempC: 20 });
    const rLineOp = conductorR({ size: c.size, material: mat, lengthM: L, parallel: n, tempC: opC });
    const peMat = c.peMaterial || mat;
    const rPeOp = conductorR({ size: c.peSize, material: peMat, lengthM: L, parallel: n, tempC: opC });
    const xCab = (xPer * L) / n;

    const noTable = (m) => `IEC 60228 does not tabulate ${m} as a conductor, so the loop `
      + "impedance through it is unknown — take the resistance from the cable maker. The "
      + "adiabatic check below is unaffected, because that needs only the area and k";
    const miss = [];
    if (num(c.size) === null) miss.push("a line conductor size");
    else if (rLine20 === null) {
      miss.push(hasRTable(mat) ? `IEC 60228 has no ${c.size} mm² ${mat} row` : noTable(mat));
    }
    if (num(c.lengthM) === null) miss.push("a run length");
    if (num(c.peSize) === null) miss.push("a protective conductor size");
    else if (rPeOp === null) {
      miss.push(hasRTable(peMat) ? `IEC 60228 has no ${c.peSize} mm² ${peMat} row` : noTable(peMat));
    }

    const rec = {
      id: node.id, depth: up.depth + 1, miss,
      rMax: up.rMax + (rLine20 ?? 0), xMax: up.xMax + xCab,
      rMin: up.rMin + (rLineOp ?? 0), xMin: up.xMin + xCab,
      /* The earth loop carries the PE conductor's resistance as well as
         the line's, which is why a halved PE roughly trebles the loop
         resistance of that leg and is the usual reason a long final
         circuit fails to disconnect in time. */
      rLoopMin: up.rLoopMin + (rLineOp ?? 0) + (rPeOp ?? 0),
      xLoopMin: up.xLoopMin + 2 * xCab,
      cableR20: rLine20, cableROp: rLineOp, cablePeR: rPeOp, cableX: xCab,
    };
    rec.zMax = mag(rec.rMax, rec.xMax);
    rec.zLoopMin = mag(rec.rLoopMin, rec.xLoopMin);
    rec.ik3max = rec.zMax > 0 ? (C_FACTOR.max * U) / (Math.sqrt(3) * rec.zMax) : null;
    rec.ik1min = rec.zLoopMin > 0 ? (C_FACTOR.min * u0) / rec.zLoopMin : null;
    out.set(node.id, rec);
    return rec;
  };

  for (const n of nodes) resolve(n);

  const source = {
    ...sMax, u: U, u0, miss: sourceMiss,
    ik3max: sMax.ik3 ?? null,
    /* At the source terminals the earth loop is the source impedance
       alone, so cmin over the phase voltage is the floor. */
    ik1min: sMin.z ? (C_FACTOR.min * u0) / mag(baseMin.r, baseMin.x) : null,
  };
  return { source, nodes: out, orphans, u: U, u0 };
}

/* ---------------------------------------------------------------
   5.  The checks
   --------------------------------------------------------------- */

/**
 * Will the device clear this fault, and how fast?
 *
 * Kept deliberately crude: a rating, a magnetic multiple and an
 * instantaneous clearing time. The question that matters is binary and
 * a full time-current curve does not change it — does the minimum
 * fault current reach the instantaneous threshold? If it does, the
 * cable is stressed for milliseconds. If it does not, the device falls
 * back on its thermal element and the cable is stressed for seconds,
 * which is two orders of magnitude more energy and the usual way a
 * conductor that "passed" the adiabatic check fails in service.
 */
export function deviceCheck({ device = {}, ik1min = null, ik3max = null } = {}) {
  const rating = num(device.ratingA);
  const mult = num(device.magneticMultiple) ?? 10;
  const tInst = num(device.clearingS) ?? 0.1;
  const tBackup = num(device.backupS) ?? 5;
  const icu = num(device.icuKa);

  const trip = rating === null ? null : rating * mult;
  const reaches = trip !== null && ik1min !== null ? ik1min >= trip : null;
  const t = reaches === false ? tBackup : tInst;

  const breaking = icu !== null && ik3max !== null
    ? { pass: icu * 1000 >= ik3max, icuA: icu * 1000, ik3max }
    : null;

  return {
    rating, mult, trip, reaches, t, tInst, tBackup, breaking,
    why: reaches === null
      ? "No device rating given, so the clearing time below is an assumption rather than a result."
      : reaches
        ? `${Math.round(ik1min)} A of earth-fault current clears the ${Math.round(trip)} A instantaneous `
          + `threshold, so the cable is stressed for ${tInst} s.`
        : `${Math.round(ik1min)} A of earth-fault current does not reach the ${Math.round(trip)} A `
          + `instantaneous threshold. The device falls back on its thermal element, so the fault `
          + `persists for seconds, not milliseconds — the adiabatic check below is run at ${tBackup} s `
          + `and the real fix is a larger protective conductor or a shorter run, not a bigger cable.`,
  };
}

/**
 * The adiabatic check itself: S ≥ √(I²t) / k, per IEC 60364-5-54
 * 543.1.2, applied to a conductor carrying I for t seconds.
 */
export function adiabatic({ current, t, k, size, parallel = 1 }) {
  const I = num(current), T = num(t), kk = num(k), S = num(size);
  const n = Math.max(1, num(parallel) || 1);
  if (I === null || T === null || kk === null || !kk) return { miss: true };
  const perCond = I / n;
  const sMin = (perCond * Math.sqrt(T)) / kk;
  return {
    perCond, sMin: Math.round(sMin * 100) / 100, sMinRaw: sMin,
    standard: nextStandardSize(sMin),
    installed: S, parallel: n,
    pass: S === null ? null : S >= sMin,
    margin: S === null ? null : Math.round((S / sMin) * 100) / 100,
    /* Inverting the equation gives the time the installed conductor can
       actually hold the current, which is a more useful thing to read
       than a pass chip: it says how much room there is. */
    tWithstand: S === null ? null : Math.round(Math.pow((kk * S) / perCond, 2) * 1000) / 1000,
    arithmetic: `S = √(${Math.round(perCond)}² × ${T}) / ${kk} = ${Math.round(sMin * 100) / 100} mm²`,
  };
}

/**
 * Everything that has to be true about one cable, in one call: the
 * line conductor survives the fault, the protective conductor survives
 * it, the protective conductor is at least Table 54.2's size, and the
 * device both clears the fault and can break it.
 */
export function checkCable({ node, solved, source }) {
  const c = node.cable || {};
  const rec = solved.nodes.get(node.id);
  if (!rec) return { miss: ["this node does not connect to the source"] };

  const lineK = kFor({ table: c.kTable || "a544", insulation: c.insulation || "xlpe",
                       material: c.material || "copper", size: c.size });
  const peK = kFor({ table: c.peKTable || c.kTable || "a544", insulation: c.insulation || "xlpe",
                     material: c.peMaterial || c.material || "copper", size: c.peSize });

  const dev = deviceCheck({ device: node.device || {}, ik1min: rec.ik1min, ik3max: rec.ik3max });

  /* The current through this cable is the fault current at its load
     end — a fault any further downstream passes through more impedance
     and draws less. Taking the source fault level instead is the
     conservative reading and the tool shows it alongside, because that
     is what a hand calculation usually does and the difference is
     worth seeing. */
  const iDesign = rec.ik3max;
  const iConservative = source.ik3max ?? null;

  const line = adiabatic({ current: iDesign, t: dev.t, k: lineK.k, size: c.size, parallel: c.parallel });
  const lineConservative = iConservative === null ? null
    : adiabatic({ current: iConservative, t: dev.t, k: lineK.k, size: c.size, parallel: c.parallel });
  /* The protective conductor is sized on the earth-fault current, not
     the three-phase one, because that is the fault it carries. */
  const pe = adiabatic({ current: rec.ik1min, t: dev.t, k: peK.k, size: c.peSize, parallel: c.parallel });
  const table = peFromTable54_2({ sLine: c.size, k1: lineK.k, k2: peK.k });

  const peRequired = Math.max(pe.sMin ?? 0, table.raw ?? 0);
  const governedBy = (pe.sMin ?? 0) >= (table.raw ?? 0) ? "adiabatic" : "table";

  return {
    rec, lineK, peK, dev, line, lineConservative, pe, table,
    peRequired: Math.round(peRequired * 100) / 100,
    peStandard: nextStandardSize(peRequired),
    governedBy,
    peOk: num(c.peSize) === null ? null : c.peSize >= peRequired - 1e-9,
    miss: rec.miss,
  };
}

/* A starting network, so the tab opens on something that computes
   rather than on an empty form. The figures are the worked example
   that prompted this tool: a 1250 kVA transformer at 5%. */
export function defaultNetwork() {
  return {
    source: { kind: "tx", kva: 1250, ukPct: 5, uSecV: 400, u0V: 230, xOverR: 10 },
    nodes: [
      { id: "db1", name: "Main LV board", kind: "board", parent: null,
        cable: { size: 185, material: "aluminium", insulation: "xlpe", kTable: "a544",
                 peSize: 95, peMaterial: "aluminium", lengthM: 10, parallel: 1,
                 arrangement: "multicore", operatingC: 90 },
        device: { ratingA: 250, magneticMultiple: 10, clearingS: 0.1, backupS: 5, icuKa: 50 } },
    ],
  };
}
