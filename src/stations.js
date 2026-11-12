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
  kva: { name: "Transformer units by kVA" },
};

/** "3150, 4000; 5000 kVA" -> [3150, 4000, 5000]. Anything that is not a
 *  positive number is dropped rather than read as zero. */
export function parseKvaList(text) {
  /* Numbers are matched with their sign, so "-5" is minus five and is
     dropped, rather than the minus being taken for a separator and five
     kept. */
  return [...new Set((String(text ?? "").match(/-?\d+(?:\.\d+)?/g) || []).map(Number).filter((v) => v > 0))]
    .sort((a, b) => a - b);
}

/**
 * How many inverters each available transformer can take.
 *
 * A unit takes as many inverters as fit inside its rating, floored: one
 * more would load it past its nameplate at full export. Units that
 * cannot take even one inverter are dropped, and so are two units that
 * work out to the same number of ways, keeping the smaller — it carries
 * the same inverters for less transformer.
 */
export function unitsByKva(kvaList, invKva) {
  if (!(invKva > 0)) return [];
  const out = [];
  for (const kva of [...kvaList].sort((a, b) => a - b)) {
    const ways = Math.floor(kva / invKva + 1e-9);
    if (ways < 1 || out.some((u) => u.ways === ways)) continue;
    out.push({ kva, ways });
  }
  return out;
}

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
  const mode = cfg.stationMode === "fixed" ? "fixed" : cfg.stationMode === "kva" ? "kva" : "modular";
  if (!(nInv > 0)) return { mode, units: 0, spare: 0, combo: [] };
  if (mode === "kva") {
    /* By kVA: each available unit becomes a number of ways for this
       inverter, and the plan is chosen over those exactly as it is for
       the modular catalogue. The kVA of each unit chosen travels with
       the plan, so the summary can say how hard each one is loaded. */
    const units = unitsByKva(parseKvaList(cfg.unitKva), cfg.invKva);
    if (!units.length) {
      return { mode, units: 0, spare: 0, combo: [],
        miss: !(cfg.invKva > 0) ? "the inverter's rating"
          : "a transformer size at least as large as one inverter" };
    }
    const plan = chooseSubstations(nInv, units.map((u) => u.ways));
    const kva = plan.combo.map((w) => units.find((u) => u.ways === w).kva);
    return { mode, ...plan, kva };
  }
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

/** The same, in transformer sizes: "2 × 4000 kVA" or "4000 + 3150 kVA". */
export function describeKva(plan) {
  const k = plan?.kva || [];
  if (!k.length) return null;
  return (k.every((v) => v === k[0]) && k.length > 1 ? `${k.length} × ${k[0]}` : k.join(" + ")) + " kVA";
}
