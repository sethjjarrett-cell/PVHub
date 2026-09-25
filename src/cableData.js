/* =====================================================================
   CABLE REFERENCE DATA  —  IEC 60364-5-52 (LV), IEC 60502-2 (MV),
   IEC 60228 (conductor resistance), IEC 60949 / 60364-5-54 (adiabatic
   short-circuit withstand), IEC 60909 (fault levels).

   Everything the cable tools need that is *tabulated* rather than
   derived lives here, so the tool code stays readable and the numbers
   can be checked against the standard line by line.

   Conventions, and why they matter:

   - Two different soil-resistivity bases are in play. The LV standard
     IEC 60364-5-52 references its factors to 2.5 K·m/W; IEC 60502-2
     references its own to 1.5 K·m/W. They are NOT interchangeable and
     are kept in separate tables for that reason.
   - Base ampacities are for the stated conductor material, insulation
     and arrangement only. Swapping copper for aluminium, or a 2-core
     for three single-cores in trefoil, changes the base rating — which
     is why the DC, AC and MV tools each carry their own table.
   - Continuous derating variables (temperature, burial depth, soil
     resistivity) are interpolated between tabulated points. At a
     tabulated point interpolation returns the tabulated value exactly,
     so results agree with a spreadsheet that only ever looks up whole
     rows; between points it is closer to the truth than stepping down
     to the row below, which is optimistic.
   - Grouping factors are interpolated on circuit count for the same
     reason. Spacing is a discrete choice and is never interpolated.
   ===================================================================== */

/* ---------------------------------------------------------------
   Lookups
   --------------------------------------------------------------- */

/** Linear interpolation in a sorted [x, y] table; clamps at both ends. */
export function interp(table, x) {
  if (!table.length) return null;
  if (x <= table[0][0]) return table[0][1];
  if (x >= table[table.length - 1][0]) return table[table.length - 1][1];
  for (let i = 1; i < table.length; i++) {
    const [x0, y0] = table[i - 1];
    const [x1, y1] = table[i];
    if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
  }
  return table[table.length - 1][1];
}

/**
 * Interpolate, and say which rows it came from.
 *
 * The interface has to show the reader the table and highlight the value
 * in use, and for a continuous variable that value usually sits between
 * two tabulated rows rather than on one. Returning the bracket lets the
 * table highlight both rows and state the interpolated result, instead of
 * pretending a number came from a row it did not.
 */
export function interpBracket(table, x) {
  if (!table.length) return { value: null, lo: null, hi: null, exact: false, clamped: null };
  const first = table[0], last = table[table.length - 1];
  if (x <= first[0]) {
    return { value: first[1], lo: first, hi: first, exact: x === first[0], clamped: x < first[0] ? "lo" : null };
  }
  if (x >= last[0]) {
    return { value: last[1], lo: last, hi: last, exact: x === last[0], clamped: x > last[0] ? "hi" : null };
  }
  for (let i = 1; i < table.length; i++) {
    const lo = table[i - 1], hi = table[i];
    if (x === hi[0]) return { value: hi[1], lo: hi, hi, exact: true, clamped: null };
    if (x < hi[0]) {
      const f = (x - lo[0]) / (hi[0] - lo[0]);
      return { value: lo[1] + (hi[1] - lo[1]) * f, lo, hi, exact: x === lo[0], clamped: null };
    }
  }
  return { value: last[1], lo: last, hi: last, exact: false, clamped: null };
}

/** The same, for the grouping tables, which are rows of objects. */
export function groupFactorBracket(rows, circuits, col) {
  const pts = rows
    .filter((r) => r[col] !== null && r[col] !== undefined)
    .map((r) => [r.circuits, r[col]]);
  if (!pts.length) return { value: null, lo: null, hi: null, exact: false, beyond: false };
  if (circuits > pts[pts.length - 1][0]) {
    return { value: null, lo: null, hi: null, exact: false, beyond: true };
  }
  return { ...interpBracket(pts, circuits), beyond: false };
}

/** True when x sits outside the tabulated range — the caller warns. */
export const outsideRange = (table, x) =>
  table.length ? x < table[0][0] || x > table[table.length - 1][0] : true;

/** Exact row from a keyed table of objects, or null. */
export const rowFor = (rows, size) => rows.find((r) => r.size === size) || null;

/**
 * Interpolate a grouping factor on circuit count for one spacing column.
 * Rows where that spacing is not tabulated by IEC are skipped, and if the
 * requested count sits past the last tabulated row the result is null so
 * the tool can say "not tabulated" instead of inventing a factor.
 */
export function groupFactor(rows, circuits, col) {
  const pts = rows
    .filter((r) => r[col] !== null && r[col] !== undefined)
    .map((r) => [r.circuits, r[col]]);
  if (!pts.length) return null;
  if (circuits > pts[pts.length - 1][0]) return null;
  return interp(pts, circuits);
}

/* ---------------------------------------------------------------
   1.  LV DC — copper XLPE, 2 loaded conductors
       Base ampacities: IEC 60364-5-52 Table B.52.12 (reference method
       E, in free air) and Table B.52.4 columns D1 (in buried duct) and
       D2 (direct buried).
   --------------------------------------------------------------- */

export const DC_CCC = [
  { size: 1.5, air: 26, duct: 25, ground: 27 },
  { size: 2.5, air: 36, duct: 33, ground: 35 },
  { size: 4, air: 49, duct: 43, ground: 46 },
  { size: 6, air: 63, duct: 53, ground: 58 },
  { size: 10, air: 86, duct: 71, ground: 77 },
  { size: 16, air: 115, duct: 91, ground: 100 },
  { size: 25, air: 149, duct: 116, ground: 129 },
  { size: 35, air: 185, duct: 139, ground: 155 },
  { size: 50, air: 225, duct: 164, ground: 183 },
  { size: 70, air: 289, duct: 203, ground: 225 },
  { size: 95, air: 352, duct: 239, ground: 270 },
  { size: 120, air: 410, duct: 271, ground: 306 },
  { size: 150, air: 473, duct: 306, ground: 343 },
  { size: 185, air: 542, duct: 343, ground: 387 },
  { size: 240, air: 641, duct: 395, ground: 448 },
  { size: 300, air: 741, duct: 446, ground: 502 },
  // IEC 60364-5-52 does not tabulate 2-core copper above 300 mm². These are
  // offered so a run can be sized past it, and every value for them is
  // extrapolated and flagged as such wherever it appears.
  { size: 400, air: null, duct: null, ground: null },
  { size: 500, air: null, duct: null, ground: null },
  { size: 630, air: null, duct: null, ground: null },
];

/**
 * Maximum conductor resistance at 20 °C, Ω/m, IEC 60228 class 5 tinned
 * copper — the flexible fine-strand conductor EN 50618 specifies for
 * H1Z2Z2-K solar DC cable. Noticeably higher than solid or class 2
 * stranded copper of the same nominal area (6 mm² is 3.39 mΩ/m against
 * about 2.87 mΩ/m of bulk copper), because the strands are finer and
 * tinned. Using bulk resistivity here under-reads the voltage drop.
 */
export const DC_R20 = [
  { size: 1.5, r: 0.0137 }, { size: 2.5, r: 0.00821 }, { size: 4, r: 0.00509 },
  { size: 6, r: 0.00339 }, { size: 10, r: 0.00195 }, { size: 16, r: 0.00124 },
  { size: 25, r: 0.000795 }, { size: 35, r: 0.000565 }, { size: 50, r: 0.000393 },
  { size: 70, r: 0.000277 }, { size: 95, r: 0.00021 }, { size: 120, r: 0.000164 },
  { size: 150, r: 0.000132 }, { size: 185, r: 0.000108 }, { size: 240, r: 0.0000817 },
  { size: 300, r: 0.0000654 },
];

/* ---------------------------------------------------------------
   2.  LV AC — aluminium XLPE, three single-cores in trefoil
       Base ampacities: IEC 60364-5-52 Table B.52.13 (free air) and
       Table B.52.4 D1 / D2 for buried duct and direct burial. IEC does
       not tabulate buried aluminium single-cores above 300 mm², which
       is why those cells are null rather than extrapolated.
   --------------------------------------------------------------- */

export const AC_CCC = [
  { size: 25, air: 103, duct: 75, ground: 82 },
  { size: 35, air: 129, duct: 90, ground: 98 },
  { size: 50, air: 159, duct: 106, ground: 117 },
  { size: 70, air: 206, duct: 130, ground: 144 },
  { size: 95, air: 253, duct: 154, ground: 172 },
  { size: 120, air: 296, duct: 174, ground: 197 },
  { size: 150, air: 343, duct: 197, ground: 220 },
  { size: 185, air: 395, duct: 220, ground: 250 },
  { size: 240, air: 471, duct: 253, ground: 290 },
  { size: 300, air: 547, duct: 286, ground: 326 },
  { size: 400, air: 663, duct: null, ground: null },
  { size: 500, air: 770, duct: null, ground: null },
  { size: 630, air: 899, duct: null, ground: null },
];

/** IEC 60228 class 2 stranded aluminium, maximum R at 20 °C, Ω/m. */
export const AL_R20 = [
  { size: 16, r: 0.00191 }, { size: 25, r: 0.00122 }, { size: 35, r: 0.000868 },
  { size: 50, r: 0.000641 }, { size: 70, r: 0.000443 }, { size: 95, r: 0.00032 },
  { size: 120, r: 0.000253 }, { size: 150, r: 0.000206 }, { size: 185, r: 0.000164 },
  { size: 240, r: 0.000125 }, { size: 300, r: 0.0001 }, { size: 400, r: 0.0000778 },
  { size: 500, r: 0.0000605 }, { size: 630, r: 0.0000469 },
];

/**
 * Reactance, Ω/m, three single-cores in trefoil at 50 Hz. Reactance is
 * set by the spacing between conductor centres far more than by the
 * conductor area, so this varies little down the table — but it stops
 * being a small term once the power factor drops away from unity.
 */
export const AL_X_TREFOIL = [
  { size: 16, x: 0.000102 }, { size: 25, x: 0.000099 }, { size: 35, x: 0.000096 },
  { size: 50, x: 0.000094 }, { size: 70, x: 0.000091 }, { size: 95, x: 0.00009 },
  { size: 120, x: 0.000089 }, { size: 150, x: 0.000088 }, { size: 185, x: 0.000087 },
  { size: 240, x: 0.000086 }, { size: 300, x: 0.000085 }, { size: 400, x: 0.000085 },
  { size: 500, x: 0.000084 }, { size: 630, x: 0.000084 },
];

/**
 * A base current-carrying capacity for a size that the standard does not
 * tabulate for that installation method.
 *
 * IEC stops where it stops: 2-core copper above 300 mm², and buried
 * aluminium single-cores above 300 mm², are simply not in the tables.
 * Rather than refuse to size the run, the last two tabulated sizes are
 * extended in a straight line and a safety reduction is taken off.
 *
 * This is a placeholder for a manufacturer rating, not a standard value,
 * and it is never returned without the flag that says so. Real ratings
 * flatten off as size grows, because skin and proximity effects rise, so
 * a straight line over-predicts and the reduction only partly offsets it.
 */
export function ratingFor(table, size, col, safetyPct = 5) {
  const row = rowFor(table, size);
  if (!row) return { value: null, extrapolated: false, reason: `${size} mm² is not in this table.` };
  if (row[col] !== null && row[col] !== undefined) {
    return { value: row[col], extrapolated: false, reason: null };
  }
  // The last two sizes that do have a rating in this column set the slope.
  const known = table.filter((r) => r[col] !== null && r[col] !== undefined);
  if (known.length < 2) {
    return { value: null, extrapolated: false, reason: "Not enough tabulated rows to extend from." };
  }
  const a = known[known.length - 2], b = known[known.length - 1];
  const slope = (b[col] - a[col]) / (b.size - a.size);
  const raw = b[col] + slope * (size - b.size);
  const value = raw * (1 - safetyPct / 100);
  return {
    value: value > 0 ? value : null,
    extrapolated: true,
    basis: { from: a.size, to: b.size, slope, raw, safetyPct },
    reason: `IEC does not tabulate ${size} mm² for this method. Extended from the `
      + `${a.size} and ${b.size} mm² rows, less ${safetyPct}%.`,
  };
}

/* ---------------------------------------------------------------
   3.  LV derating — IEC 60364-5-52 Annex B
   --------------------------------------------------------------- */

/** Table B.52.14 (air, base 30 °C) and B.52.15 (ground, base 20 °C), XLPE. */
export const LV_TEMP_AIR = [
  [10, 1.15], [15, 1.12], [20, 1.08], [25, 1.04], [30, 1.0], [35, 0.96],
  [40, 0.91], [45, 0.87], [50, 0.82], [55, 0.76], [60, 0.71], [65, 0.65],
  [70, 0.58], [75, 0.5], [80, 0.41],
];
export const LV_TEMP_GROUND = [
  [10, 1.07], [15, 1.04], [20, 1.0], [25, 0.96], [30, 0.93], [35, 0.89],
  [40, 0.85], [45, 0.8], [50, 0.76], [55, 0.71], [60, 0.65], [65, 0.6],
  [70, 0.53], [75, 0.46], [80, 0.38],
];

/** Table B.52.17 item 1 — bunched in air or on a tray, touching. */
export const LV_GROUP_AIR = [
  [1, 1.0], [2, 0.8], [3, 0.7], [4, 0.65], [5, 0.6], [6, 0.57], [7, 0.54],
  [8, 0.52], [9, 0.5], [12, 0.45], [16, 0.41], [20, 0.38],
];

/** Table B.52.19A — circuits in buried ducts, by clear spacing. */
export const LV_GROUP_DUCT = [
  { circuits: 1, touching: 1, s025: 1, s05: 1, s10: 1 },
  { circuits: 2, touching: 0.85, s025: 0.9, s05: 0.95, s10: 0.95 },
  { circuits: 3, touching: 0.75, s025: 0.85, s05: 0.9, s10: 0.95 },
  { circuits: 4, touching: 0.7, s025: 0.8, s05: 0.85, s10: 0.9 },
  { circuits: 5, touching: 0.65, s025: 0.8, s05: 0.85, s10: 0.9 },
  { circuits: 6, touching: 0.6, s025: 0.8, s05: 0.8, s10: 0.9 },
  { circuits: 7, touching: 0.57, s025: 0.76, s05: 0.8, s10: 0.88 },
  { circuits: 8, touching: 0.54, s025: 0.74, s05: 0.78, s10: 0.88 },
  { circuits: 9, touching: 0.52, s025: 0.73, s05: 0.77, s10: 0.87 },
  { circuits: 10, touching: 0.49, s025: 0.72, s05: 0.76, s10: 0.86 },
  { circuits: 11, touching: 0.47, s025: 0.7, s05: 0.75, s10: 0.86 },
  { circuits: 12, touching: 0.45, s025: 0.69, s05: 0.74, s10: 0.85 },
  { circuits: 13, touching: 0.44, s025: 0.68, s05: 0.73, s10: 0.85 },
  { circuits: 14, touching: 0.42, s025: 0.68, s05: 0.72, s10: 0.84 },
  { circuits: 15, touching: 0.41, s025: 0.67, s05: 0.72, s10: 0.84 },
  { circuits: 16, touching: 0.39, s025: 0.66, s05: 0.71, s10: 0.83 },
  { circuits: 17, touching: 0.38, s025: 0.65, s05: 0.7, s10: 0.83 },
  { circuits: 18, touching: 0.37, s025: 0.65, s05: 0.7, s10: 0.83 },
  { circuits: 19, touching: 0.35, s025: 0.64, s05: 0.69, s10: 0.82 },
  { circuits: 20, touching: 0.34, s025: 0.63, s05: 0.68, s10: 0.82 },
];
export const LV_DUCT_SPACINGS = [
  { value: "touching", label: "Touching" }, { value: "s025", label: "0.25 m" },
  { value: "s05", label: "0.5 m" }, { value: "s10", label: "1.0 m" },
];

/** Table B.52.18 — direct-buried circuits, by clear spacing. */
export const LV_GROUP_DIRECT = [
  { circuits: 1, touching: 1, dia: 1, s0125: 1, s025: 1, s05: 1 },
  { circuits: 2, touching: 0.75, dia: 0.8, s0125: 0.85, s025: 0.9, s05: 0.9 },
  { circuits: 3, touching: 0.65, dia: 0.7, s0125: 0.75, s025: 0.8, s05: 0.85 },
  { circuits: 4, touching: 0.6, dia: 0.6, s0125: 0.7, s025: 0.75, s05: 0.8 },
  { circuits: 5, touching: 0.55, dia: 0.55, s0125: 0.65, s025: 0.7, s05: 0.8 },
  { circuits: 6, touching: 0.5, dia: 0.55, s0125: 0.6, s025: 0.7, s05: 0.8 },
  { circuits: 7, touching: 0.45, dia: 0.51, s0125: 0.59, s025: 0.67, s05: 0.76 },
  { circuits: 8, touching: 0.43, dia: 0.48, s0125: 0.57, s025: 0.65, s05: 0.75 },
  { circuits: 9, touching: 0.41, dia: 0.46, s0125: 0.55, s025: 0.63, s05: 0.74 },
  { circuits: 12, touching: 0.36, dia: 0.42, s0125: 0.51, s025: 0.59, s05: 0.71 },
  { circuits: 16, touching: 0.32, dia: 0.38, s0125: 0.47, s025: 0.56, s05: 0.68 },
  { circuits: 20, touching: 0.29, dia: 0.35, s0125: 0.44, s025: 0.53, s05: 0.66 },
];
export const LV_DIRECT_SPACINGS = [
  { value: "touching", label: "Touching" }, { value: "dia", label: "1 diameter" },
  { value: "s0125", label: "0.125 m" }, { value: "s025", label: "0.25 m" },
  { value: "s05", label: "0.5 m" },
];

/** Table B.52.16 — soil thermal resistivity, LV base 2.5 K·m/W. */
export const LV_SOIL_DUCT = [
  [0.5, 1.28], [0.7, 1.2], [1.0, 1.18], [1.5, 1.1], [2.0, 1.05], [2.5, 1.0], [3.0, 0.96],
];
export const LV_SOIL_DIRECT = [
  [0.5, 1.88], [0.7, 1.62], [1.0, 1.5], [1.5, 1.28], [2.0, 1.12], [2.5, 1.0], [3.0, 0.9],
];

/** Burial depth, base 0.8 m (IEC 60287 derived, as used in the workbook). */
export const DEPTH_DIRECT_LE185 = [
  [0.5, 1.04], [0.6, 1.02], [0.8, 1.0], [1.0, 0.98], [1.25, 0.96], [1.5, 0.95],
  [1.75, 0.94], [2.0, 0.93], [2.5, 0.91], [3.0, 0.9],
];
export const DEPTH_DIRECT_GT185 = [
  [0.5, 1.06], [0.6, 1.04], [0.8, 1.0], [1.0, 0.97], [1.25, 0.95], [1.5, 0.93],
  [1.75, 0.91], [2.0, 0.9], [2.5, 0.88], [3.0, 0.86],
];
export const DEPTH_DUCT_LE185 = [
  [0.5, 1.04], [0.6, 1.02], [0.8, 1.0], [1.0, 0.98], [1.25, 0.96], [1.5, 0.95],
  [1.75, 0.94], [2.0, 0.93], [2.5, 0.91], [3.0, 0.9],
];
export const DEPTH_DUCT_GT185 = [
  [0.5, 1.05], [0.6, 1.03], [0.8, 1.0], [1.0, 0.97], [1.25, 0.95], [1.5, 0.93],
  [1.75, 0.92], [2.0, 0.91], [2.5, 0.89], [3.0, 0.88],
];

/* ---------------------------------------------------------------
   4.  MV — 3 × 1c aluminium XLPE 19/33 kV, trefoil, IEC 60502-2
       Annex B. Base ratings tabulated to 400 mm² only; 500 and 630 are
       linearly extrapolated from the 300 and 400 mm² rows with a
       safety reduction, and are flagged as such wherever they appear.
   --------------------------------------------------------------- */

export const MV_BASE = [
  { size: 16, buried: 84, duct: 80, air: 97, r: 0.00191, x: 0.000141 },
  { size: 25, buried: 108, duct: 102, air: 127, r: 0.00122, x: 0.000135 },
  { size: 35, buried: 129, duct: 122, air: 154, r: 0.000868, x: 0.000131 },
  { size: 50, buried: 152, duct: 144, air: 184, r: 0.000641, x: 0.000127 },
  { size: 70, buried: 186, duct: 176, air: 230, r: 0.000443, x: 0.000123 },
  { size: 95, buried: 221, duct: 210, air: 280, r: 0.00032, x: 0.000121 },
  { size: 120, buried: 252, duct: 240, air: 324, r: 0.000253, x: 0.00012 },
  { size: 150, buried: 281, duct: 267, air: 368, r: 0.000206, x: 0.000116 },
  { size: 185, buried: 317, duct: 303, air: 424, r: 0.000164, x: 0.000113 },
  { size: 240, buried: 367, duct: 351, air: 502, r: 0.000125, x: 0.00011 },
  { size: 300, buried: 414, duct: 397, air: 577, r: 0.0001, x: 0.000108 },
  { size: 400, buried: 470, duct: 451, air: 673, r: 0.0000778, x: 0.000106 },
  { size: 500, buried: null, duct: null, air: null, r: 0.0000605, x: 0.000104, extrap: true },
  { size: 630, buried: null, duct: null, air: null, r: 0.0000469, x: 0.000102, extrap: true },
];

/**
 * Fill the extrapolated rows. Straight-line extrapolation of the last
 * two tabulated sizes over-predicts, because real ratings flatten off
 * above 400 mm² as skin and proximity effects grow, so a safety
 * reduction is subtracted. It is a placeholder for a manufacturer
 * rating, not a standard value.
 */
export function mvTable(safetyPct = 5) {
  const at = (s, col) => MV_BASE.find((r) => r.size === s)[col];
  return MV_BASE.map((r) => {
    if (!r.extrap) return { ...r };
    const out = { ...r };
    for (const col of ["buried", "duct", "air"]) {
      const i400 = at(400, col), i300 = at(300, col);
      out[col] = (i400 + ((i400 - i300) / 100) * (r.size - 400)) * (1 - safetyPct / 100);
    }
    return out;
  });
}

/** Table B.11 — ground temperature, base 20 °C. */
export const MV_TEMP_GROUND = [
  [10, 1.07], [15, 1.04], [20, 1.0], [25, 0.96], [30, 0.93], [35, 0.89],
  [40, 0.85], [45, 0.8], [50, 0.76],
];

/** Tables B.14 (direct) and B.15 (ducts) — soil resistivity, base 1.5 K·m/W. */
export const MV_SOIL_DIRECT = [
  { size: 16, f: [[0.7, 1.29], [0.8, 1.24], [0.9, 1.19], [1, 1.15], [1.5, 1], [2, 0.89], [2.5, 0.82], [3, 0.75]] },
  { size: 25, f: [[0.7, 1.3], [0.8, 1.25], [0.9, 1.2], [1, 1.16], [1.5, 1], [2, 0.89], [2.5, 0.81], [3, 0.75]] },
  { size: 35, f: [[0.7, 1.3], [0.8, 1.25], [0.9, 1.21], [1, 1.16], [1.5, 1], [2, 0.89], [2.5, 0.81], [3, 0.75]] },
  { size: 50, f: [[0.7, 1.32], [0.8, 1.26], [0.9, 1.21], [1, 1.16], [1.5, 1], [2, 0.89], [2.5, 0.81], [3, 0.74]] },
  { size: 70, f: [[0.7, 1.33], [0.8, 1.27], [0.9, 1.22], [1, 1.17], [1.5, 1], [2, 0.89], [2.5, 0.81], [3, 0.74]] },
  { size: 95, f: [[0.7, 1.34], [0.8, 1.28], [0.9, 1.22], [1, 1.18], [1.5, 1], [2, 0.89], [2.5, 0.8], [3, 0.74]] },
  { size: 120, f: [[0.7, 1.34], [0.8, 1.28], [0.9, 1.22], [1, 1.18], [1.5, 1], [2, 0.88], [2.5, 0.8], [3, 0.74]] },
  { size: 150, f: [[0.7, 1.35], [0.8, 1.28], [0.9, 1.23], [1, 1.18], [1.5, 1], [2, 0.88], [2.5, 0.8], [3, 0.74]] },
  { size: 185, f: [[0.7, 1.35], [0.8, 1.29], [0.9, 1.23], [1, 1.18], [1.5, 1], [2, 0.88], [2.5, 0.8], [3, 0.74]] },
  { size: 240, f: [[0.7, 1.36], [0.8, 1.29], [0.9, 1.23], [1, 1.18], [1.5, 1], [2, 0.88], [2.5, 0.8], [3, 0.73]] },
  { size: 300, f: [[0.7, 1.36], [0.8, 1.3], [0.9, 1.24], [1, 1.19], [1.5, 1], [2, 0.88], [2.5, 0.8], [3, 0.73]] },
  { size: 400, f: [[0.7, 1.37], [0.8, 1.3], [0.9, 1.24], [1, 1.19], [1.5, 1], [2, 0.88], [2.5, 0.79], [3, 0.73]] },
  { size: 500, f: [[0.7, 1.37], [0.8, 1.3], [0.9, 1.24], [1, 1.19], [1.5, 1], [2, 0.88], [2.5, 0.79], [3, 0.73]] },
  { size: 630, f: [[0.7, 1.37], [0.8, 1.3], [0.9, 1.24], [1, 1.19], [1.5, 1], [2, 0.88], [2.5, 0.79], [3, 0.73]] },
];
export const MV_SOIL_DUCT = [
  { size: 16, f: [[0.7, 1.2], [0.8, 1.17], [0.9, 1.14], [1, 1.11], [1.5, 1], [2, 0.92], [2.5, 0.85], [3, 0.79]] },
  { size: 25, f: [[0.7, 1.21], [0.8, 1.17], [0.9, 1.14], [1, 1.12], [1.5, 1], [2, 0.91], [2.5, 0.85], [3, 0.79]] },
  { size: 35, f: [[0.7, 1.21], [0.8, 1.18], [0.9, 1.15], [1, 1.12], [1.5, 1], [2, 0.91], [2.5, 0.84], [3, 0.79]] },
  { size: 50, f: [[0.7, 1.21], [0.8, 1.18], [0.9, 1.15], [1, 1.12], [1.5, 1], [2, 0.91], [2.5, 0.84], [3, 0.78]] },
  { size: 70, f: [[0.7, 1.22], [0.8, 1.19], [0.9, 1.15], [1, 1.12], [1.5, 1], [2, 0.91], [2.5, 0.84], [3, 0.78]] },
  { size: 95, f: [[0.7, 1.23], [0.8, 1.19], [0.9, 1.16], [1, 1.13], [1.5, 1], [2, 0.91], [2.5, 0.84], [3, 0.78]] },
  { size: 120, f: [[0.7, 1.23], [0.8, 1.2], [0.9, 1.16], [1, 1.13], [1.5, 1], [2, 0.91], [2.5, 0.84], [3, 0.78]] },
  { size: 150, f: [[0.7, 1.24], [0.8, 1.2], [0.9, 1.16], [1, 1.13], [1.5, 1], [2, 0.91], [2.5, 0.83], [3, 0.78]] },
  { size: 185, f: [[0.7, 1.24], [0.8, 1.2], [0.9, 1.17], [1, 1.13], [1.5, 1], [2, 0.91], [2.5, 0.83], [3, 0.78]] },
  { size: 240, f: [[0.7, 1.25], [0.8, 1.21], [0.9, 1.17], [1, 1.14], [1.5, 1], [2, 0.9], [2.5, 0.83], [3, 0.77]] },
  { size: 300, f: [[0.7, 1.25], [0.8, 1.21], [0.9, 1.17], [1, 1.14], [1.5, 1], [2, 0.9], [2.5, 0.83], [3, 0.77]] },
  { size: 400, f: [[0.7, 1.25], [0.8, 1.21], [0.9, 1.17], [1, 1.14], [1.5, 1], [2, 0.9], [2.5, 0.83], [3, 0.77]] },
  { size: 500, f: [[0.7, 1.25], [0.8, 1.21], [0.9, 1.17], [1, 1.14], [1.5, 1], [2, 0.9], [2.5, 0.83], [3, 0.77]] },
  { size: 630, f: [[0.7, 1.25], [0.8, 1.21], [0.9, 1.17], [1, 1.14], [1.5, 1], [2, 0.9], [2.5, 0.83], [3, 0.77]] },
];

/** Tables B.19 (direct) and B.21 (ducts) — grouping by centre spacing, mm. */
export const MV_GROUP_DIRECT = [
  { circuits: 1, touching: 1, s200: 1, s400: 1, s600: 1, s800: 1 },
  { circuits: 2, touching: 0.73, s200: 0.83, s400: 0.88, s600: 0.9, s800: 0.92 },
  { circuits: 3, touching: 0.6, s200: 0.73, s400: 0.79, s600: 0.83, s800: 0.86 },
  { circuits: 4, touching: 0.54, s200: 0.68, s400: 0.75, s600: 0.8, s800: 0.84 },
  { circuits: 5, touching: 0.49, s200: 0.63, s400: 0.72, s600: 0.78, s800: 0.82 },
  { circuits: 6, touching: 0.46, s200: 0.61, s400: 0.7, s600: 0.76, s800: 0.81 },
  { circuits: 7, touching: 0.43, s200: 0.58, s400: 0.68, s600: 0.75, s800: 0.8 },
  { circuits: 8, touching: 0.41, s200: 0.57, s400: 0.67, s600: 0.74, s800: null },
  { circuits: 9, touching: 0.39, s200: 0.55, s400: 0.66, s600: 0.73, s800: null },
  { circuits: 10, touching: 0.37, s200: 0.54, s400: 0.65, s600: null, s800: null },
  { circuits: 11, touching: 0.36, s200: 0.53, s400: 0.64, s600: null, s800: null },
  { circuits: 12, touching: 0.35, s200: 0.52, s400: 0.64, s600: null, s800: null },
];
export const MV_GROUP_DUCT = [
  { circuits: 1, touching: 1, s200: 1, s400: 1, s600: 1, s800: 1 },
  { circuits: 2, touching: 0.78, s200: 0.85, s400: 0.89, s600: 0.91, s800: 0.93 },
  { circuits: 3, touching: 0.66, s200: 0.75, s400: 0.81, s600: 0.85, s800: 0.88 },
  { circuits: 4, touching: 0.59, s200: 0.7, s400: 0.77, s600: 0.82, s800: 0.86 },
  { circuits: 5, touching: 0.55, s200: 0.66, s400: 0.74, s600: 0.8, s800: 0.84 },
  { circuits: 6, touching: 0.51, s200: 0.64, s400: 0.72, s600: 0.78, s800: 0.83 },
  { circuits: 7, touching: 0.48, s200: 0.61, s400: 0.71, s600: 0.77, s800: 0.82 },
  { circuits: 8, touching: 0.46, s200: 0.6, s400: 0.7, s600: 0.76, s800: null },
  { circuits: 9, touching: 0.44, s200: 0.58, s400: 0.69, s600: 0.76, s800: null },
  { circuits: 10, touching: 0.43, s200: 0.57, s400: 0.68, s600: null, s800: null },
  { circuits: 11, touching: 0.42, s200: 0.56, s400: 0.67, s600: null, s800: null },
  { circuits: 12, touching: 0.4, s200: 0.55, s400: 0.67, s600: null, s800: null },
];
export const MV_SPACINGS = [
  { value: "touching", label: "Touching" }, { value: "s200", label: "200 mm" },
  { value: "s400", label: "400 mm" }, { value: "s600", label: "600 mm" },
  { value: "s800", label: "800 mm" },
];

/* ---------------------------------------------------------------
   5.  Short-circuit withstand — IEC 60949 / IEC 60364-5-54
   --------------------------------------------------------------- */

/**
 * Conductor constants for the adiabatic equation.
 *   Qc   volumetric heat capacity at 20 °C, J/(K·mm³)
 *   beta reciprocal of the temperature coefficient of resistance at
 *        0 °C, K  (β = 1/α₀, so copper 234.5 K)
 *   rho20 electrical resistivity at 20 °C, Ω·mm
 * K = √(Qc·(β+20)/ρ20) is the material constant; the insulation only
 * enters through the initial and final temperatures.
 */
export const CONDUCTOR = {
  copper: { name: "Copper", Qc: 3.45e-3, beta: 234.5, rho20: 17.241e-6 },
  aluminium: { name: "Aluminium", Qc: 2.5e-3, beta: 228, rho20: 28.264e-6 },
  steel: { name: "Steel (armour)", Qc: 3.8e-3, beta: 202, rho20: 138e-6 },
  lead: { name: "Lead (sheath)", Qc: 1.45e-3, beta: 230, rho20: 214e-6 },
};

/**
 * Insulation systems: continuous conductor limit (also the assumed
 * temperature at the instant the fault starts, i.e. the cable was fully
 * loaded) and the short-circuit limit the insulation can take for up to
 * five seconds. Taking the initial temperature as the full-load limit is
 * the pessimistic and conventional assumption; a lightly loaded cable
 * starts colder and withstands more.
 */
export const INSULATION = {
  xlpe: { name: "XLPE / EPR", cont: 90, sc: 250 },
  pvc300: { name: "PVC ≤ 300 mm²", cont: 70, sc: 160 },
  pvc300plus: { name: "PVC > 300 mm²", cont: 70, sc: 140 },
  pvc90: { name: "PVC 90 °C", cont: 90, sc: 160 },
  rubber60: { name: "Rubber 60 °C", cont: 60, sc: 200 },
  h1z2z2: { name: "H1Z2Z2-K (XLPO, DC)", cont: 90, sc: 250 },
};

/** Material constant K, A·√s/mm². */
export const materialK = (m) => Math.sqrt((m.Qc * (m.beta + 20)) / m.rho20);

/**
 * Adiabatic k for a conductor of material m heated from θi to θf.
 *   k = K · √( ln((β+θf)/(β+θi)) )
 * Copper in XLPE from 90 °C to 250 °C gives 143, aluminium 94 — the
 * familiar tabulated values in IEC 60364-5-54, reproduced rather than
 * hard-coded so any temperature pair can be evaluated.
 */
export function adiabaticK(m, thetaI, thetaF) {
  return materialK(m) * Math.sqrt(Math.log((m.beta + thetaF) / (m.beta + thetaI)));
}

/**
 * IEC 60909-0 peak factor. R/X is the ratio at the fault location; a
 * stiff, largely inductive source gives κ near 2 and a peak close to
 * 2.8 times the r.m.s. symmetrical current.
 */
export const peakFactor = (rOverX) => 1.02 + 0.98 * Math.exp(-3 * rOverX);

/**
 * Heat contributed by the decaying d.c. component, IEC 60909-0 §4.7.
 * n is taken as 1 (far-from-generator fault, no a.c. decay), which is
 * the right assumption for a utility infeed and slightly conservative
 * for an inverter-dominated fault.
 */
export function dcHeatFactor(kappa, f, tk) {
  if (!(kappa > 1) || !(tk > 0)) return 0;
  const a = 2 * f * tk * Math.log(kappa - 1);
  // κ = 2 exactly (a purely inductive source) makes ln(κ−1) vanish; the
  // limit of the expression there is 2, not a division by zero.
  if (Math.abs(a) < 1e-9) return 2;
  return (Math.exp(2 * a) - 1) / a;
}

/** Standard metric conductor sizes, for the size pickers. */
export const SIZES = [
  1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70, 95, 120, 150, 185, 240, 300, 400, 500, 630,
];

/* ---------------------------------------------------------------
   6.  Trenches and physical arrangement

   Grouping factors assume the circuits share one thermal environment.
   A real trench has a width limit, usually about 2 m for a machine-dug
   trench that a person can still work in, so twenty circuits at half a
   metre apart is not one trench, it is several. Splitting them is not
   only a civils question: it changes the grouping factor, because the
   lookup is on circuits per trench rather than circuits in total.
   --------------------------------------------------------------- */

/** Clear spacing between circuits, in metres, for the LV grouping tables. */
export const LV_DUCT_SPACING_M = { touching: 0, s025: 0.25, s05: 0.5, s10: 1.0 };
export const LV_DIRECT_SPACING_M = { touching: 0, dia: "oneDiameter", s0125: 0.125, s025: 0.25, s05: 0.5 };
/** IEC 60502-2 states MV spacing centre to centre, not clear. */
export const MV_SPACING_CENTRE_M = { touching: "touching", s200: 0.2, s400: 0.4, s600: 0.6, s800: 0.8 };

/**
 * Indicative overall width of one circuit, in millimetres: a two-core or
 * a trefoil bundle, not a single core. Enough to size a trench to the
 * nearest sensible width; replace with the manufacturer's figure before
 * anything is dug.
 */
export const CIRCUIT_WIDTH_MM = {
  dc: [[1.5, 11], [2.5, 12], [4, 13], [6, 14], [10, 17], [16, 20], [25, 24], [35, 27],
    [50, 31], [70, 35], [95, 40], [120, 44], [150, 48], [185, 54], [240, 60], [300, 66],
    [400, 76], [500, 85], [630, 95]],
  ac: [[25, 36], [35, 39], [50, 43], [70, 48], [95, 54], [120, 58], [150, 62], [185, 68],
    [240, 76], [300, 82], [400, 92], [500, 102], [630, 114]],
  mv: [[16, 66], [25, 70], [35, 74], [50, 80], [70, 86], [95, 94], [120, 100], [150, 106],
    [185, 114], [240, 124], [300, 132], [400, 146], [500, 160], [630, 176]],
};
export const circuitWidthMm = (kind, size) => interp(CIRCUIT_WIDTH_MM[kind] || CIRCUIT_WIDTH_MM.dc, size);

/**
 * Work out how the circuits divide between trenches and whether each one
 * is diggable. Returns the minimum number of trenches that fits as well,
 * so the interface can recommend rather than only complain.
 *
 * Separate trenches are assumed far enough apart to be thermally
 * independent. That is the whole point of splitting, but it is an
 * assumption the interface has to state: two trenches a metre apart are
 * still one thermal group and the grouping factor should be looked up on
 * the total, not on the half.
 */
export function trenchPlan({
  ownCircuits, auxCircuits = 0, trenches = 1,
  clearSpacingM = 0, circuitWidthM = 0.05, maxWidthM = 2, edgeM = 0.15, centreSpacingM = null,
}) {
  const total = Math.max(0, Math.round(ownCircuits + auxCircuits));
  const n = Math.max(1, Math.round(trenches));
  const perTrench = Math.ceil(total / n);
  const centre = centreSpacingM !== null
    ? Math.max(centreSpacingM, circuitWidthM)
    : (clearSpacingM === "oneDiameter" ? circuitWidthM * 2 : clearSpacingM + circuitWidthM);
  const widthOf = (k) => (k <= 0 ? 0 : (k - 1) * centre + circuitWidthM + 2 * edgeM);
  const width = widthOf(perTrench);

  let minTrenches = 1;
  while (minTrenches < 200 && widthOf(Math.ceil(total / minTrenches)) > maxWidthM) minTrenches++;

  return {
    total, trenches: n, perTrench, centreSpacingM: centre, widthM: width,
    fits: width <= maxWidthM, maxWidthM, minTrenches,
    spare: n * perTrench - total,
  };
}

/* ---------------------------------------------------------------
   7.  The LV derating chain, and sizing against it
   --------------------------------------------------------------- */

/**
 * Derate one candidate size, returning not just the answer but every
 * lookup that produced it, so the interface can show the reader the
 * table each factor came from and highlight the row in use.
 */
/**
 * Apply a manual override to a bracket object without destroying what
 * the table said. The auto value stays on the result as `auto`, so the
 * interface can keep highlighting the row it would have used and show
 * the two side by side. An override is a deliberate act — a
 * manufacturer figure, a client's standard, a factor from a different
 * edition — not an error, so it is reported as its own state rather
 * than folded in with interpolation or extrapolation.
 */
export function applyOverride(bracket, value) {
  if (value === null || value === undefined || value === "" || !isFinite(value)) {
    return { ...bracket, manual: false, auto: bracket.value };
  }
  return { ...bracket, value: Number(value), manual: true, auto: bracket.value };
}

export function derateLV({
  table, install, size, tAir, tGnd, soil, depth, circuits, spacing, safetyPct = 5,
  ov = {},
}) {
  const notes = [];
  const rating = ratingFor(table, size, install, safetyPct);
  if (rating.reason && !rating.extrapolated) notes.push(rating.reason);

  const tempTable = install === "air" ? LV_TEMP_AIR : LV_TEMP_GROUND;
  const fTemp = applyOverride(
    interpBracket(tempTable, install === "air" ? tAir : tGnd), ov.fTemp);

  let fGroup, groupRows, groupCol;
  if (circuits <= 1) {
    fGroup = { value: 1, lo: null, hi: null, exact: true, beyond: false };
    groupRows = null; groupCol = null;
  } else if (install === "air") {
    groupRows = LV_GROUP_AIR.map(([c, f]) => ({ circuits: c, f }));
    groupCol = "f";
    fGroup = groupFactorBracket(groupRows, circuits, groupCol);
  } else {
    groupRows = install === "duct" ? LV_GROUP_DUCT : LV_GROUP_DIRECT;
    groupCol = spacing;
    fGroup = groupFactorBracket(groupRows, circuits, groupCol);
  }
  fGroup = applyOverride(fGroup, ov.fGroup);
  if (fGroup.beyond && !fGroup.manual) {
    notes.push(`${circuits} circuits in one group is past the last row IEC tabulates at this spacing. `
      + "Split the run across more trenches, or widen the spacing.");
  }

  const soilTable = install === "duct" ? LV_SOIL_DUCT : LV_SOIL_DIRECT;
  const fSoil = applyOverride(install === "air"
    ? { value: 1, lo: null, hi: null, exact: true, clamped: null }
    : interpBracket(soilTable, soil), ov.fSoil);

  const depthTable = install === "air" ? null
    : install === "duct" ? (size <= 185 ? DEPTH_DUCT_LE185 : DEPTH_DUCT_GT185)
      : (size <= 185 ? DEPTH_DIRECT_LE185 : DEPTH_DIRECT_GT185);
  const fDepth = applyOverride(install === "air"
    ? { value: 1, lo: null, hi: null, exact: true, clamped: null }
    : interpBracket(depthTable, depth), ov.fDepth);

  /* A manual base rating replaces the table lookup outright, and with it
     the extrapolation warning — an entered figure is presumably the
     manufacturer rating the warning was asking for. */
  const baseManual = ov.base !== null && ov.base !== undefined && ov.base !== ""
    && isFinite(ov.base) && Number(ov.base) > 0;
  const base = baseManual ? Number(ov.base) : rating.value;

  const ok = base !== null && fGroup.value !== null;
  const df = ok ? fTemp.value * fGroup.value * fSoil.value * fDepth.value : null;
  return {
    size, install,
    base, baseAuto: rating.value, baseManual,
    extrapolated: rating.extrapolated && !baseManual, extrapBasis: rating.basis || null,
    extrapReason: rating.extrapolated && !baseManual ? rating.reason : null,
    fTemp, fGroup, fSoil, fDepth,
    anyManual: baseManual || fTemp.manual || fGroup.manual || fSoil.manual || fDepth.manual,
    tempTable, groupRows, groupCol, soilTable, depthTable,
    df, derated: ok ? base * df : null,
    notes,
  };
}

/**
 * The smallest size in the table that carries the current, given the
 * same installation. Returns the whole chain for the winner so the
 * interface can show why, plus how far the current choice misses by.
 *
 * Sizing up is only one of three ways out of a failing check, so the
 * alternatives are returned too: more cables in parallel spreads the
 * current, and more trenches improves the grouping factor. Which is
 * cheapest is a site question, not one this can answer.
 */
export function recommendSize(params, designCurrent, parallel = 1) {
  const { table } = params;
  const perCable = designCurrent / Math.max(1, parallel);
  /* Factor overrides are properties of the installation, so they carry
     across every candidate size. A base-rating override is a property of
     one specific cable and must not, or every size would be scanned with
     the same rating and the recommendation would be nonsense. */
  const scanOv = { ...(params.ov || {}) };
  delete scanOv.base;
  const candidates = [];
  for (const row of table) {
    const d = derateLV({ ...params, ov: scanOv, size: row.size });
    candidates.push({ size: row.size, derated: d.derated, extrapolated: d.extrapolated, chain: d });
    if (d.derated !== null && perCable <= d.derated) {
      return {
        found: true, size: row.size, derated: d.derated, extrapolated: d.extrapolated,
        chain: d, perCable, candidates,
        headroomA: d.derated - perCable,
        utilPct: (perCable / d.derated) * 100,
      };
    }
  }
  return { found: false, perCable, candidates };
}

/** How far a failing check misses by, in the terms a designer thinks in. */
export function shortfall(perCable, derated) {
  if (derated === null || derated === undefined || !(derated > 0)) return null;
  const overA = perCable - derated;
  return {
    overA,
    overPct: (overA / derated) * 100,
    utilPct: (perCable / derated) * 100,
    /* Parallel cables needed at this size to bring it inside the rating. */
    parallelNeeded: Math.ceil(perCable / derated),
  };
}
