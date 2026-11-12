/* ---------------------------------------------------------------
   Transformer stations: which inverters share one.

   There used to be two answers to that in the layout and they did not
   agree. The outlines drawn round each transformer group came from
   "inverters per transformer"; the stations actually placed, routed
   to and counted came from a fixed catalogue of 10, 14 and 20-way
   units that ignored the input altogether. A site set to four
   inverters per transformer drew groups of four and then cabled them
   to fourteen-way stations.

   This file is the one place that decides, so the outline, the
   station marker, the cable routes and the count on the summary are
   all read off the same plan and cannot drift apart again.

   No React.
   --------------------------------------------------------------- */

/* The modular catalogue the layout has always placed: single-transformer
   units with 10, 14 or 20 LV ways. They are the Sungrow MVS3200, 4480
   and 6400 sizes, which is a vendor's range rather than a standard, and
   the interface says so wherever it offers them. */
export const MODULAR_WAYS = [10, 14, 20];

export const STATION_MODES = {
  modular: { name: "Modular units: 10, 14 or 20 ways" },
  fixed: { name: "One size: the number of ways entered" },
};

/** Fewest units first, then fewest spare ways. 26 -> 14+14, 34 -> 20+14. */
export function chooseSubstations(nInv, sizes) {
  const list = (sizes || []).map(Number).filter((s) => s > 0);
  if (!(nInv > 0) || !list.length) return { units: 0, spare: 0, combo: [] };
  const big = Math.max(...list), small = Math.min(...list);
  let best = null;
  for (let units = 1; units <= Math.ceil(nInv / small) + 1; units++) {
    if (units * big < nInv) continue;
    const rec = (i, left, acc, sum) => {
      if (left === 0) {
        if (sum >= nInv) {
          const spare = sum - nInv;
          if (!best || spare < best.spare) {
            best = { units, spare, combo: [...acc].sort((a, b) => b - a) };
          }
        }
        return;
      }
      for (let k = i; k < list.length; k++) {
        acc.push(list[k]); rec(k, left - 1, acc, sum + list[k]); acc.pop();
      }
    };
    rec(0, units, [], 0);
    if (best) break;
  }
  return best || { units: 0, spare: 0, combo: [] };
}

/**
 * The station plan for a number of inverters.
 *
 * `cfg` is the electrical grouping from the layout: `stationMode` is
 * "modular" or "fixed", and `invertersPerTx` is the size used when it
 * is fixed. A project saved before the mode existed has none, and
 * reads as modular, because that is what its stations were.
 */
export function stationPlan(nInv, cfg = {}) {
  const mode = cfg.stationMode === "fixed" ? "fixed" : "modular";
  if (!(nInv > 0)) return { mode, units: 0, spare: 0, combo: [] };
  if (mode === "fixed") {
    const ways = Math.max(1, Math.round(Number(cfg.invertersPerTx) || 1));
    const units = Math.ceil(nInv / ways);
    return { mode, units, spare: units * ways - nInv, combo: Array(units).fill(ways) };
  }
  return { mode, ...chooseSubstations(nInv, MODULAR_WAYS) };
}

/**
 * Which station an inverter belongs to, by its index in the walk.
 *
 * Inverters are numbered along a snake through the block bands, so
 * consecutive numbers are physical neighbours, and each station takes
 * the next run of them. The last station is the one left short.
 */
export function stationIndexer(nInv, cfg = {}) {
  const { combo } = stationPlan(nInv, cfg);
  const ends = [];
  let acc = 0;
  for (const w of combo) { acc += w; ends.push(acc); }
  return (i) => {
    for (let s = 0; s < ends.length; s++) if (i < ends[s]) return s;
    return Math.max(0, ends.length - 1);
  };
}

/** How a plan reads in a sentence: "14 + 10" or "6 × 4". */
export function describePlan(plan) {
  const c = plan?.combo || [];
  if (!c.length) return "—";
  return c.every((w) => w === c[0]) && c.length > 1 ? `${c.length} × ${c[0]}` : c.join(" + ");
}
