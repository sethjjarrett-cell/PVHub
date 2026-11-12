/* ---------------------------------------------------------------
   What the layout can hand to the tools downstream of it.

   The layout knows the module count, the inverter count, which
   inverters share a station and how far each cable actually runs.
   Until now every other tool asked for those to be typed in again, so
   a cable schedule could describe one plant while the layout beside
   it drew another, and nothing would notice.

   Each function here turns the layout's summary into the shape one
   receiving tool wants. Three rules hold across all of them:

   - Nothing is copied on its own. These return what WOULD be set; the
     receiving tab shows it against what is entered now, and a person
     presses the button. A value that changes underneath someone
     because another tab moved is how a design stops being trusted.
   - Only what the layout actually knows is handed over. Where the
     receiving tool needs something the layout has no opinion on — a
     transformer's impedance, a breaker rating, a protective conductor
     — it is left alone and named, not filled with something typical.
   - A layout with no routed cable hands over no lengths. Zero metres
     is a length, and it is the wrong one.

   No React.
   --------------------------------------------------------------- */

const fin = (v) => Number.isFinite(v);
const r0 = (v) => Math.round(v);
const r1 = (v) => Math.round(v * 10) / 10;

/** Whether there is a layout worth reading from at all. */
export const hasLayout = (L) => !!L && L.modules > 0;

const stationsOf = (L) => (L?.stations || []).filter((s) => s.used > 0);

/* ---------------------------------------------------------------
   Rows for the offer panel: label, what is entered now, what the
   layout says. A row whose layout value is unknown is dropped, so
   the panel never offers to set something to "nothing".
   --------------------------------------------------------------- */
export function offerRows(defs, current, patch) {
  return defs
    .filter((d) => patch[d.key] !== undefined && patch[d.key] !== null)
    .map((d) => {
      const now = current?.[d.key];
      const next = patch[d.key];
      const show = d.fmt || ((v) => (v === null || v === undefined || v === "" ? "—" : String(v)));
      return { key: d.key, label: d.label, unit: d.unit || "", now: show(now), next: show(next),
        differs: show(now) !== show(next) };
    });
}

/* ---------------------------------------------------------------
   LV: inverter to station
   --------------------------------------------------------------- */

/**
 * The routed LV runs, as the AC cable tab needs them.
 *
 * Volt drop is checked on the longest run, because that is the one
 * that fails first; the mean is what the losses and the cable order
 * scale with. Both are returned and the tab says which it used.
 */
export function lvRunsFromLayout(L) {
  const all = stationsOf(L).flatMap((s) => (s.lv || []).filter(fin));
  if (!all.length) return null;
  return {
    count: all.length,
    longest: r0(Math.max(...all)),
    shortest: r0(Math.min(...all)),
    mean: r0(all.reduce((a, b) => a + b, 0) / all.length),
    total: r0(all.reduce((a, b) => a + b, 0)),
  };
}

/* ---------------------------------------------------------------
   MV: station to the grid point
   --------------------------------------------------------------- */

/**
 * The MV run table, from the stations as routed.
 *
 * One run per station, each straight to the point of connection,
 * because that is what the layout routes today: every station on its
 * own radial. A real collector daisy-chains stations along a feeder,
 * which is shorter and loads the last stretch with all of them. The
 * tab says that this is the radial case and not a feeder design, so
 * the total is read as an upper bound on cable and each run's current
 * as a lower bound on what a shared feeder would carry.
 *
 * Size and installation are the tab's own reference choices, left as
 * they are: the layout has no view on either.
 */
export function mvRunsFromLayout(L, st = {}) {
  const ss = stationsOf(L).filter((s) => fin(s.mv) && s.mv > 0);
  if (!ss.length) return null;
  return {
    kva: fin(L.invAcKw) && L.invAcKw > 0 ? L.invAcKw : null,
    runs: ss.map((s, i) => ({
      branch: i + 1, from: `TS${i + 1}`, to: "POC", inv: s.used,
      install: st.refInstall || "duct", size: st.refSize || 150, dist: r0(s.mv),
    })),
    total: r0(ss.reduce((a, s) => a + s.mv, 0)),
  };
}

/* ---------------------------------------------------------------
   The guided flow and its bill of materials
   --------------------------------------------------------------- */

export const GUIDED_ROWS = [
  { key: "lat", label: "Latitude", unit: "°" },
  { key: "lon", label: "Longitude", unit: "°" },
  { key: "areaHa", label: "Site area", unit: "ha" },
  { key: "moduleWp", label: "Module", unit: "Wp" },
  { key: "modulesInSeries", label: "Modules in series" },
  { key: "inverterKwac", label: "Inverter", unit: "kWac" },
  { key: "nInverter", label: "Inverters" },
  { key: "collectorWidthM", label: "Collector width", unit: "m" },
  { key: "pitchM", label: "Pitch", unit: "m" },
  { key: "tiltDeg", label: "Tilt", unit: "°" },
  { key: "moduleCount", label: "Modules that fit" },
  { key: "transformerKva", label: "Transformer unit size", unit: "kVA" },
];

/**
 * Everything the guided flow asks for that the layout already holds.
 *
 * The transformer size is handed over only when every station is the
 * same size. A layout on mixed modular units has no single unit size,
 * and the bill of materials divides by one: giving it the largest
 * would under-count the stations and giving it the mean would price a
 * unit nobody makes.
 */
export function guidedFromLayout(L, loc = null) {
  if (!hasLayout(L)) return null;
  const p = {};
  if (loc && fin(loc.lat) && fin(loc.lon)) { p.lat = loc.lat; p.lon = loc.lon; }
  if (fin(L.areaM2) && L.areaM2 > 0) p.areaHa = r1(L.areaM2 / 1e4);
  if (fin(L.modPower)) p.moduleWp = L.modPower;
  if (fin(L.modulesPerString)) p.modulesInSeries = L.modulesPerString;
  if (fin(L.invAcKw) && L.invAcKw > 0) p.inverterKwac = L.invAcKw;
  if (fin(L.inverters)) p.nInverter = L.inverters;
  if (fin(L.collectW) && L.collectW > 0) p.collectorWidthM = Math.round(L.collectW * 100) / 100;
  if (fin(L.pitch) && L.pitch > 0) p.pitchM = L.pitch;
  // A tracker has no fixed tilt to hand over; its tilt is the sun's.
  if (L.mounting !== "tracker" && fin(L.tilt)) p.tiltDeg = L.tilt;
  p.moduleCount = L.modules;
  const ways = [...new Set(stationsOf(L).map((s) => s.ways))];
  /* A station sized from a real transformer carries that rating; one
     sized in ways is taken as the inverters it serves, the least the
     transformer could be. */
  const kvas = [...new Set(stationsOf(L).map((s) => s.kva).filter((v) => fin(v) && v > 0))];
  const notes = [];
  if (kvas.length === 1 && stationsOf(L).every((s) => s.kva === kvas[0])) {
    p.transformerKva = kvas[0];
  } else if (ways.length === 1 && kvas.length === 0 && fin(L.invAcKw) && L.invAcKw > 0) {
    p.transformerKva = r0(ways[0] * L.invAcKw);
  } else if (ways.length > 1 || kvas.length > 1) {
    notes.push(`The layout uses stations of ${ways.sort((a, b) => a - b).join(" and ")} ways, so `
      + "there is no single transformer size to hand over. Enter the one being bought.");
  }
  return { patch: p, notes };
}

/* ---------------------------------------------------------------
   The PVsyst sweep
   --------------------------------------------------------------- */

export const SWEEP_ROWS = [
  { key: "mount", label: "Mounting" },
  { key: "moduleWp", label: "Module", unit: "Wp" },
  { key: "modulesInSeries", label: "Modules in series" },
  { key: "nParallel", label: "Strings in parallel" },
  { key: "inverterKwac", label: "Inverter", unit: "kWac" },
  { key: "nInverter", label: "Inverters" },
  { key: "collectorWidthM", label: "Collector width", unit: "m" },
  { key: "baseTilt", label: "Tilt of the base variant", unit: "°" },
];

/**
 * The plant a PVsyst base variant has to be built around.
 *
 * Strings floor: a part-filled string is not a string, and PVsyst's
 * batch column takes a whole number. The modules that do not make up
 * a string are reported so the capacity PVsyst simulates can be seen
 * to differ from the layout's, and by how much.
 */
export function sweepFromLayout(L) {
  if (!hasLayout(L)) return null;
  const p = {};
  p.mount = L.mounting === "fixed" ? "fixed" : L.mounting === "ew" ? "ew" : "tracker";
  if (fin(L.modPower)) p.moduleWp = L.modPower;
  if (fin(L.modulesPerString)) p.modulesInSeries = L.modulesPerString;
  const notes = [];
  if (fin(L.modules) && fin(L.modulesPerString) && L.modulesPerString > 0) {
    p.nParallel = Math.floor(L.modules / L.modulesPerString);
    const spare = L.modules - p.nParallel * L.modulesPerString;
    if (spare > 0) {
      notes.push(`${spare} module${spare === 1 ? "" : "s"} in the layout do not make up a string `
        + "and are not in the PVsyst plant.");
    }
  }
  if (fin(L.invAcKw) && L.invAcKw > 0) p.inverterKwac = L.invAcKw;
  if (fin(L.inverters)) p.nInverter = L.inverters;
  if (fin(L.collectW) && L.collectW > 0) p.collectorWidthM = Math.round(L.collectW * 100) / 100;
  if (L.mounting !== "tracker" && fin(L.tilt)) p.baseTilt = L.tilt;
  return { patch: p, notes };
}

/* ---------------------------------------------------------------
   The fault study
   --------------------------------------------------------------- */

/**
 * A fault network for one station, from the layout.
 *
 * The station chosen is the one with the most inverters on it, since
 * it has the largest transformer and so the highest fault level. Two
 * feeders are built from it, not all of them: the shortest, where the
 * fault current is highest and the conductor is stressed hardest, and
 * the longest, where it is lowest and the device is least likely to
 * see enough to operate. Every other feeder lies between those two.
 *
 * What the layout knows goes in: the transformer's rating as the sum
 * of the inverters it serves, the inverter's AC voltage, the routed
 * lengths, and the cable the AC tab has chosen. What it does not know
 * stays out and is named — the transformer's impedance is kept from
 * whatever the study already holds, and the protective conductor and
 * the protective device are left empty, so those feeders draw grey
 * until somebody decides them. Filling them with something typical
 * would produce a network that passes on inputs nobody chose.
 */
export function networkFromLayout(L, { ac = {}, source = {} } = {}) {
  const ss = stationsOf(L).filter((s) => (s.lv || []).some(fin));
  if (!hasLayout(L) || !ss.length || !(L.invAcKw > 0)) return null;
  const pick = [...ss].sort((a, b) => b.used - a.used
    || Math.max(...b.lv.filter(fin)) - Math.max(...a.lv.filter(fin)))[0];
  const which = stationsOf(L).indexOf(pick) + 1;
  const lens = pick.lv.filter(fin);
  const shortest = r0(Math.min(...lens)), longest = r0(Math.max(...lens));
  const u = fin(L.invVac) && L.invVac > 0 ? L.invVac : null;

  const cable = (lengthM) => ({
    size: fin(ac.vdSize) ? ac.vdSize : null, material: "aluminium", insulation: "xlpe",
    kTable: "a544", lengthM, parallel: fin(ac.par) && ac.par > 0 ? ac.par : 1,
    arrangement: "trefoil", operatingC: fin(ac.tCond) ? ac.tCond : 90,
    peSize: null, peMaterial: "aluminium",
  });
  const nodes = [{ id: "near", name: `Nearest inverter, ${shortest} m`, kind: "load", parent: null,
    cable: cable(shortest), device: {} }];
  if (longest > shortest) {
    nodes.push({ id: "far", name: `Farthest inverter, ${longest} m`, kind: "load", parent: null,
      cable: cable(longest), device: {} });
  }
  const notes = [
    `Station ${which} of ${stationsOf(L).length}: ${pick.used} inverters on a ${pick.ways}-way unit, `
      + "the largest on the site and so the highest fault level.",
    "Transformer impedance is not something a layout knows. It is left as it was — set it "
      + "from the nameplate.",
    "No protective conductor or protective device is set, so both feeders stay grey until "
      + "they are. Those are decisions, and the layout has not made them.",
  ];
  if (!u) notes.push("The inverter's AC voltage is not set, so the voltage is left as it was.");
  if (!fin(ac.vdSize)) notes.push("The AC cable tab has no size chosen, so the conductor is left to pick.");
  notes.push("Many 800 V inverter networks run unearthed (IT), where a first earth fault draws "
    + "almost no current. The earth-fault side of this study describes an earthed (TN) system.");
  return {
    net: {
      source: {
        kind: "tx", kva: fin(pick.kva) && pick.kva > 0 ? pick.kva : r0(pick.ways * L.invAcKw),
        ukPct: source.ukPct ?? null, xOverR: source.xOverR ?? 10,
        uSecV: u ?? source.uSecV ?? null,
        u0V: u ? r0(u / Math.sqrt(3)) : source.u0V ?? null,
      },
      nodes,
    },
    notes, station: which, shortest, longest,
  };
}
