/* =====================================================================
   STRING SIZING
   ---------------------------------------------------------------------
   The cold-Voc ceiling and the hot-Vmp full-power floor, on an IEC 62548
   basis. Pure maths, no React: lifted out of App.jsx so the guided
   business-development flow can call the same function the String Sizing
   tab does, rather than carrying a second copy that would drift from it
   within a week.

   The conventions it encodes are the ones CLAUDE.md states and they are
   not negotiable here:

   - Temperature extremes are never averaged. T_low is the MINIMUM of
     every source offered and T_high the MAXIMUM, because averaging
     softens exactly the extreme the check exists to catch.
   - N_max FLOORS. One more module over-volts the inverter on the
     coldest morning.
   - N_min uses the inverter's FULL-POWER lower bound, not the MPPT
     tracking bound off the datasheet front page.
   - N_rec trades modules for frame divisibility, falling back to the
     electrical maximum when the divisible candidate drops below N_min.
   - Parallel strings take the LOWER of the connector limit and the MPPT
     current headroom.
   ================================================================== */

/** Temperature rise over ambient by mounting style, in kelvin. */
export const RISE_TABLE = [
  { label: "Roof mount, gap \u2264 15 cm", rise: 35 },
  { label: "Rack mount, gap \u2265 15 cm", rise: 30 },
  { label: "Top of a pole / freefield", rise: 25 },
];

/**
 * Size a string.
 * @param {object} mod    module nameplate and coefficients
 * @param {object} inv    inverter window and limits
 * @param {Array}  tSrc   temperature sources, each {lo, hi}
 * @param {object} siteT  {riseIdx, margin}
 * @param {number} frameP modules per frame, for the divisibility preference
 * @param {number|null} nSel  a hand-picked N, or null to use N_rec
 */
export function sizeStrings({ mod, inv, tSrc, siteT, frameP, nSel }) {
  // β_Vmp derivation waterfall: datasheet → γ−α → NOCT (irradiance-corrected)
  const route2 = (mod.gPmax !== null && mod.aIsc !== null) ? mod.gPmax - mod.aIsc : null;
  const route3 =
    mod.vmpNoct !== null && mod.noct !== null && mod.cells !== null && mod.ideality !== null
      ? (((mod.vmpNoct - mod.vmp) -
          mod.cells * mod.ideality * 0.00008617 * (273.15 + mod.noct) * Math.log(0.8)) /
          mod.vmp / (mod.noct - 25)) * 100
      : null;
  const bVmpUsed = mod.bVmp !== null ? mod.bVmp : route2 !== null ? route2 : route3;
  const method = mod.bVmp !== null ? "Datasheet value"
    : route2 !== null ? "Derived: γ_Pmax − α_Isc"
    : route3 !== null ? "Derived from NOCT delta (irradiance-corrected)"
    : "NO ROUTE — enter data";

  // adopted temperature extremes: most extreme source, never averaged
  const los = tSrc.map((s) => s.lo).filter((v) => v !== null);
  const his = tSrc.map((s) => s.hi).filter((v) => v !== null);
  const tLo = los.length ? Math.min(...los) : null;
  const tHi = his.length ? Math.max(...his) : null;

  const rise = RISE_TABLE[siteT.riseIdx].rise;
  const tcMin = tLo !== null ? tLo - siteT.margin : null;
  const tcMax = tHi !== null ? tHi + rise + siteT.margin : null;
  const bad = bVmpUsed === null || tcMin === null || tcMax === null;

  const vocCold1 = bad ? 0 : mod.voc * (1 + (mod.bVoc / 100) * (tcMin - 25));
  const vmpHot1 = bad ? 1 : mod.vmp * (1 + (bVmpUsed / 100) * (tcMax - 25));
  const vmpCold1 = bad ? 0 : mod.vmp * (1 + (bVmpUsed / 100) * (tcMin - 25));
  const ceiling = Math.min(inv.vMax, mod.vSysMax || inv.vMax);
  const nMax = bad ? 0 : Math.floor(ceiling / vocCold1);
  const nMin = bad ? 1 : Math.ceil(inv.fpLo / vmpHot1);
  const valid = !bad && nMax >= nMin;
  // frame-P preference: largest N divisible by P, unless that drops below N_min
  const nDivCand = nMax - (nMax % Math.max(1, frameP));
  const nRec = !valid ? null : nDivCand >= nMin ? nDivCand : nMax;
  const recDivisible = nRec !== null && nRec % frameP === 0;
  const N = nSel !== null ? nSel : (nRec ?? 1);

  const effStart = [inv.vStart, inv.trackLo].filter((v) => v !== null);
  const startV = effStart.length ? Math.max(...effStart) : null;
  const nStart = startV !== null && !bad ? Math.ceil(startV / vmpHot1) : null;

  const byIsc = inv.iMppt !== null && mod.isc > 0 ? Math.floor(inv.iMppt / mod.isc) : null;
  const strPar = byIsc !== null && inv.connMax !== null ? Math.min(inv.connMax, byIsc)
    : byIsc !== null ? byIsc : inv.connMax;
  const pString = N * mod.pmax;
  const pMppt = strPar !== null ? strPar * pString : null;
  const pInv = pMppt !== null ? pMppt * inv.nMppt : null;
  const dcac = pInv !== null && inv.acKva ? pInv / 1000 / inv.acKva : null;

  return {
    route2, route3, bVmpUsed, method, tLo, tHi, rise, tcMin, tcMax, bad,
    vocCold1, vmpHot1, vmpCold1, ceiling, nMax, nMin, valid, nRec, recDivisible,
    nDivCand, N, vocColdN: N * vocCold1, vmpHotN: N * vmpHot1, vmpColdN: N * vmpCold1,
    startV, nStart, byIsc, strPar, pString, pMppt, pInv, dcac,
  };

}
