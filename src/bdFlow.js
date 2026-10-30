/* =====================================================================
   THE BUSINESS DEVELOPMENT FLOW
   ---------------------------------------------------------------------
   A linear path from a map pin to a quotable number, for someone who is
   not going to open the cable derating tab.

   WHAT ORDER, AND WHY. The dependency runs one way, and it is worth
   stating because the obvious guess is wrong:

     site -> string length -> PVsyst sweep -> layout -> yield -> quote

   The sweep comes BEFORE the layout, not after, because the thing the
   sweep decides — the row pitch — is an INPUT to the layout. And the
   sweep does not need the layout in return: PVsyst reports specific
   yield, kWh per kWp, which is independent of how many kWp end up on
   the site. So the sweep settles the geometry per kWp, the layout then
   says how many kWp that site actually holds, and the two multiply.

   The one real constraint is time. A sweep is hours of simulation on
   somebody else's machine, so the flow does not block on it: the layout
   runs immediately on a provisional pitch, every number downstream is
   marked provisional, and dropping the results in later re-settles them.
   `stepState` is what decides which of those two worlds a step is in.

   NOTHING HERE INVENTS A NUMBER. A step with missing inputs reports what
   is missing; it does not substitute a plausible default and carry on.
   That is the same refusal the costing tool makes about prices, for the
   same reason: a plausible default ends up in a board paper with nobody
   remembering where it came from.
   ================================================================== */

export const STEPS = [
  { id: "site", n: 1, title: "Where is it",
    asks: "Coordinates, and the site area or boundary.",
    gives: "Temperature extremes for the string sizing, and the irradiance baseline.",
    needs: [] },
  { id: "kit", n: 2, title: "What is going on it",
    asks: "A module and an inverter.",
    gives: "The nameplate figures every later step runs on.",
    needs: [] },
  { id: "string", n: 3, title: "How long is a string",
    asks: "Nothing more.",
    gives: "The string length, from the coldest morning and the hottest afternoon.",
    needs: ["site", "kit"] },
  { id: "sweep", n: 4, title: "What tilt, pitch and DC/AC",
    asks: "A PVsyst run — the file is written here and the results come back here.",
    gives: "The geometry, and the specific yield per kWp.",
    needs: ["string"] },
  { id: "layout", n: 5, title: "How much fits",
    asks: "The boundary, at the pitch step 4 chose.",
    gives: "The module count and the real DC capacity.",
    needs: ["site"] },
  { id: "yield", n: 6, title: "What it generates",
    asks: "Nothing more.",
    gives: "Annual energy: PVsyst's specific yield times the capacity that fits.",
    needs: ["sweep", "layout"] },
  { id: "quote", n: 7, title: "What it costs",
    asks: "A quote from the library, or a rate per watt.",
    gives: "Capex, and an indicative LCOE.",
    needs: ["yield"] },
];

export const stepById = (id) => STEPS.find((s) => s.id === id) || null;

/* ---------- what each step has, and what it still wants ------------ */

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Inspect a project and report, per step, whether it is done and what it
 * is missing. Pure: takes a plain object, returns a plain object, so the
 * rules are testable without rendering anything.
 */
export function assess(p = {}) {
  const out = {};

  const lat = num(p.lat), lon = num(p.lon);
  const areaHa = num(p.areaHa);
  out.site = {
    done: lat !== null && lon !== null && areaHa !== null && areaHa > 0,
    missing: [
      lat === null || lon === null ? "coordinates" : null,
      areaHa === null || areaHa <= 0 ? "site area" : null,
    ].filter(Boolean),
    /* The temperature pull is optional: without it the string sizing
       still runs on whatever extremes were typed, and says so. */
    pulled: Boolean(p.tempPulled),
  };

  const mw = num(p.moduleWp), ik = num(p.inverterKwac);
  out.kit = {
    done: mw !== null && mw > 0 && ik !== null && ik > 0,
    missing: [
      mw === null || mw <= 0 ? "module rating" : null,
      ik === null || ik <= 0 ? "inverter rating" : null,
    ].filter(Boolean),
  };

  const n = num(p.modulesInSeries);
  out.string = {
    done: n !== null && n > 0,
    missing: n === null || n <= 0 ? ["a string length"] : [],
    blocked: !out.site.done || !out.kit.done,
  };

  const pitch = num(p.pitchM), tilt = num(p.tiltDeg), spec = num(p.specificYield);
  out.sweep = {
    done: pitch !== null && tilt !== null && spec !== null,
    /* Provisional means the geometry was assumed rather than simulated,
       which every number downstream has to carry. */
    provisional: (pitch !== null || tilt !== null) && spec === null,
    missing: [
      pitch === null ? "a row pitch" : null,
      tilt === null ? "a tilt" : null,
      spec === null ? "PVsyst's specific yield" : null,
    ].filter(Boolean),
    blocked: !out.string.done,
  };

  const mods = num(p.moduleCount);
  out.layout = {
    done: mods !== null && mods > 0,
    missing: mods === null || mods <= 0 ? ["a module count"] : [],
    blocked: !out.site.done,
    /* The layout can run on a provisional pitch, and usually should —
       waiting hours for a sweep before seeing whether the site even
       holds the target is the wrong way round. */
    onProvisionalPitch: out.sweep.provisional,
  };

  out.yield = {
    done: out.layout.done && spec !== null,
    missing: [
      !out.layout.done ? "the module count" : null,
      spec === null ? "a specific yield" : null,
    ].filter(Boolean),
    /* Blocked on EITHER half. Energy is the specific yield times the
       capacity, so a missing simulation blocks it just as surely as a
       missing layout — reading it as merely "to do" would invite
       someone to fill the gap by hand. */
    blocked: !out.layout.done || !out.sweep.done,
  };

  const rate = num(p.capexPerWp);
  out.quote = {
    done: out.yield.done && rate !== null && rate > 0,
    missing: [
      !out.yield.done ? "the annual energy" : null,
      rate === null || rate <= 0 ? "a capex rate" : null,
    ].filter(Boolean),
    blocked: !out.yield.done,
  };

  return out;
}

/** One of: blocked | todo | provisional | done. */
export function stepState(id, state) {
  const s = state[id];
  if (!s) return "todo";
  if (s.blocked && !s.done) return "blocked";
  if (s.done) return "done";
  if (s.provisional) return "provisional";
  return "todo";
}

/** The step to point at next: the first that is neither done nor blocked. */
export function nextStep(state) {
  for (const s of STEPS) {
    const st = stepState(s.id, state);
    if (st === "todo" || st === "provisional") return s;
  }
  return null;
}

/* ---------- the numbers ---------------------------------------------
   Every figure carries how it was arrived at, because a BD will be
   asked, and "the tool said so" is not an answer. */

/**
 * Work the project through to a quotable set of figures.
 * Returns null for anything that cannot be derived, never a placeholder.
 */
export function derive(p = {}) {
  const moduleCount = num(p.moduleCount);
  const moduleWp = num(p.moduleWp);
  const specificYield = num(p.specificYield);
  const capexPerWp = num(p.capexPerWp);
  const inverterKwac = num(p.inverterKwac);
  const nInverter = num(p.nInverter);

  const dcKwp = moduleCount !== null && moduleWp !== null
    ? Math.round((moduleCount * moduleWp) / 1000 * 10) / 10 : null;
  const acKw = inverterKwac !== null && nInverter !== null
    ? Math.round(inverterKwac * nInverter * 10) / 10 : null;
  const dcac = dcKwp !== null && acKw !== null && acKw > 0
    ? Math.round((dcKwp / acKw) * 1000) / 1000 : null;

  /* PVsyst's specific yield is per kWp and survives the fact that its
     3D scene is a regular field while the layout followed a boundary.
     The capacity is the layout's. Multiplying the two is the whole
     point of running them separately. */
  const annualMwh = dcKwp !== null && specificYield !== null
    ? Math.round((dcKwp * specificYield) / 1000 * 10) / 10 : null;

  const capex = dcKwp !== null && capexPerWp !== null
    ? Math.round(dcKwp * 1000 * capexPerWp) : null;

  return {
    dcKwp, acKw, dcac, annualMwh, capex,
    dcKwpHow: dcKwp === null ? null
      : `${moduleCount} modules x ${moduleWp} Wp`,
    annualHow: annualMwh === null ? null
      : `${specificYield} kWh/kWp from PVsyst x ${dcKwp} kWp from the layout`,
    capexHow: capex === null ? null
      : `${dcKwp} kWp x ${capexPerWp} per Wp`,
  };
}

/* ---------- the guards a non-engineer will not think to apply -------
   The point of a guided flow is not only to shorten the path but to put
   a floor under it. Each of these is a figure that looks fine on screen
   and is obviously wrong to anyone who sizes plants for a living. */

/** Plausible outer bounds, deliberately wide: these catch a wrong
    number, not a bold one. Tightening them to "typical" would start
    arguing with legitimate designs. */
export const SANITY = {
  dcac: [0.9, 2.0],
  specificYield: [600, 2600],   // kWh/kWp/yr, Scotland to the Atacama
  gcr: [20, 90],                // %
  capexPerWp: [0.2, 3.0],
};

export function sanityChecks(p = {}, opts = {}) {
  const d = derive(p);
  const out = [];
  const band = opts.dcacBand || SANITY.dcac;

  if (d.dcac !== null && (d.dcac < band[0] || d.dcac > band[1])) {
    out.push({
      field: "dcac", severity: d.dcac > 3 || d.dcac < 0.5 ? "bad" : "warn",
      text: `DC/AC comes out at ${d.dcac}, outside the ${band[0]} to ${band[1]} that a built `
        + `plant sits in. ${d.dcac > band[1]
          ? "Either the inverter count is too low or the array is too big for it."
          : "Either there are too many inverters or the array is too small for them."}`,
    });
  }

  const sy = num(p.specificYield);
  if (sy !== null && (sy < SANITY.specificYield[0] || sy > SANITY.specificYield[1])) {
    out.push({ field: "specificYield", severity: "bad",
      text: `A specific yield of ${sy} kWh/kWp is outside anywhere on earth `
        + `(${SANITY.specificYield[0]} to ${SANITY.specificYield[1]}). Check the units on the `
        + "figure taken out of PVsyst." });
  }

  const cw = num(p.collectorWidthM), pitch = num(p.pitchM);
  if (cw !== null && pitch !== null && pitch > 0) {
    const gcr = Math.round((cw / pitch) * 1000) / 10;
    if (gcr > SANITY.gcr[1]) {
      out.push({ field: "pitchM", severity: "warn",
        text: `A ${pitch} m pitch on a ${cw} m collector is ${gcr}% ground cover — the rows `
          + "will shade each other heavily. Check the pitch is axis to axis and not the gap "
          + "between rows." });
    } else if (gcr < SANITY.gcr[0]) {
      out.push({ field: "pitchM", severity: "warn",
        text: `A ${pitch} m pitch is only ${gcr}% ground cover, which wastes most of the `
          + "site. Worth checking before it is quoted on area." });
    }
  }

  const cap = num(p.capexPerWp);
  if (cap !== null && (cap < SANITY.capexPerWp[0] || cap > SANITY.capexPerWp[1])) {
    out.push({ field: "capexPerWp", severity: "warn",
      text: `${cap} per Wp is outside the ${SANITY.capexPerWp[0]} to ${SANITY.capexPerWp[1]} `
        + "band that utility-scale work falls in. Check whether the rate is per Wp or per kWp." });
  }

  /* A site that cannot hold what has been drawn on it. Roughly 1 MWp
     per hectare is the loosest plausible density for fixed tilt; past
     about 1.5 the modules do not physically fit. */
  const ha = num(p.areaHa);
  if (ha !== null && ha > 0 && d.dcKwp !== null) {
    const mwPerHa = d.dcKwp / 1000 / ha;
    if (mwPerHa > 1.5) {
      out.push({ field: "areaHa", severity: "bad",
        text: `${Math.round(mwPerHa * 100) / 100} MWp per hectare is denser than modules `
          + "physically pack. Either the site area is too small or the module count is too high." });
    }
  }

  return out;
}

/**
 * The headline sentence, written out rather than left for the reader to
 * assemble — and explicitly marked when the geometry was assumed rather
 * than simulated, because that is the difference between a number worth
 * quoting and one worth checking.
 */
export function summarise(p = {}, opts = {}) {
  const st = assess(p);
  const d = derive(p);
  const checks = sanityChecks(p, opts);
  if (d.dcKwp === null) return { ready: false, text: "Not enough yet to size anything." };
  const bits = [`${d.dcKwp >= 1000 ? `${Math.round(d.dcKwp / 100) / 10} MWp` : `${d.dcKwp} kWp`} on the site`];
  if (d.dcac !== null) bits.push(`DC/AC ${d.dcac}`);
  if (d.annualMwh !== null) bits.push(`${d.annualMwh.toLocaleString("en-GB")} MWh a year`);
  if (d.capex !== null) bits.push(`capex ${d.capex.toLocaleString("en-GB")}`);
  return {
    ready: d.annualMwh !== null,
    provisional: st.sweep.provisional,
    checks,
    text: bits.join(", "),
    caveat: st.sweep.provisional
      ? "The geometry has not been simulated yet, so the yield is an assumption. Run the "
        + "PVsyst sweep and drop the results back in before this goes to a client."
      : null,
  };
}
