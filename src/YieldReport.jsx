/* =====================================================================
   YIELD REPORT  —  pull the data, state what the plant should make, and
   put the pitch decision on a footing you can defend.

   The purpose, in the client's words: print out a layout, and on the next
   page say approximately what to expect from it. Not a PVsyst run — a
   figure good enough to start a conversation, with its provenance
   attached so nobody mistakes it for one.

   Two things this tab is careful about.

   First, absolute against relative. The absolute yield comes from PVGIS
   PVcalc, which is a validated model; the row-geometry effects come from
   ours, because no public API takes a pitch. So the absolute number is
   PVGIS's and the differences between pitches are ours, and those
   differences hold up far better than the absolute does — swap the
   irradiance dataset and every pitch moves together.

   Second, yield is not the only axis. Widening the pitch always adds
   yield and always adds cable, and past a point it buys a hundredth of a
   per cent for a kilometre of copper. The trade-off table is the part
   worth reading.
   ===================================================================== */

import React, { useState, useMemo } from "react";
import { fmt, fmtKm, C, Num, Sel, Section, Page, Working } from "./ui.jsx";
import { fetchEra5, fetchTmy, fetchPvcalc } from "./pvgis.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* A source row: what was asked, what came back, and where from. */
function Source({ name, what, st, onPull, children }) {
  const tone = st.state === "ok" ? "#59b56f" : st.state === "err" ? "#d67070" : C.muted;
  return (
    <div style={{
      width: "100%", background: C.panel2, border: `1px solid ${C.line}`,
      borderRadius: 5, padding: "9px 11px", display: "flex", gap: 10,
      alignItems: "flex-start", flexWrap: "wrap",
    }}>
      <div style={{ flex: "1 1 240px", minWidth: 200 }}>
        <div style={{ font: "600 12px system-ui", color: C.text }}>
          {name}
          <span style={{ font: "600 9.5px system-ui", color: tone, marginLeft: 8,
            letterSpacing: "0.07em", textTransform: "uppercase" }}>
            {st.state === "busy" ? "fetching" : st.state === "ok" ? "loaded"
              : st.state === "err" ? "unavailable" : "not pulled"}
          </span>
        </div>
        <div style={{ font: "11px system-ui", color: C.muted, marginTop: 2, lineHeight: 1.5 }}>
          {st.state === "err" ? st.msg : what}
        </div>
        {children}
      </div>
      <button className="btn" disabled={st.state === "busy"} onClick={onPull}>
        {st.state === "busy" ? "…" : st.state === "ok" ? "Refresh" : "Fetch"}
      </button>
    </div>
  );
}

/** Monthly generation bars — the shape of the year, not just its total. */
function MonthlyBars({ monthly, mwp }) {
  if (!monthly?.length) return null;
  const W = 560, H = 190, L = 46, R = W - 12, T = 14, B = H - 30;
  const vals = monthly.map((m) => (m.e * mwp * 1000) / 1000); // MWh per month
  const max = Math.max(...vals);
  const bw = (R - L) / vals.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }}>
      <rect x="0" y="0" width={W} height={H} fill={C.paper} />
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <g key={f}>
          <line x1={L} y1={B - f * (B - T)} x2={R} y2={B - f * (B - T)}
            stroke={f === 0 ? C.gridMajor : C.grid} strokeWidth="1" />
          <text x={L - 6} y={B - f * (B - T) + 3} textAnchor="end" fill={C.muted}
            style={{ font: "9.5px var(--mono)" }}>{fmt(max * f, 0)}</text>
        </g>
      ))}
      {vals.map((v, i) => (
        <g key={i}>
          <rect x={L + i * bw + bw * 0.18} y={B - (v / max) * (B - T)}
            width={bw * 0.64} height={(v / max) * (B - T)} fill={C.accent} opacity="0.85" rx="2" />
          <text x={L + i * bw + bw / 2} y={B + 14} textAnchor="middle" fill={C.muted}
            style={{ font: "9.5px system-ui" }}>{MONTHS[i]}</text>
        </g>
      ))}
      <text x={L} y={T - 2} fill={C.muted} style={{ font: "9.5px system-ui" }}>MWh per month</text>
    </svg>
  );
}

/**
 * Pitch against yield and cable on one pair of axes. Yield rises and
 * flattens; cable cost rises without flattening. Where the two curves
 * stop converging is the answer, and it is nearly always well short of
 * the pitch that maximises yield alone.
 */
function TradeCurve({ rows, chosen }) {
  if (rows.length < 2) return null;
  const W = 560, H = 250, L = 52, R = W - 54, T = 16, B = H - 34;
  const ps = rows.map((r) => r.pitch);
  const pLo = Math.min(...ps), pHi = Math.max(...ps);
  const x = (p) => L + ((p - pLo) / Math.max(1e-6, pHi - pLo)) * (R - L);
  const ys = rows.map((r) => r.netGain);
  const yLo = Math.min(0, ...ys), yHi = Math.max(...ys, 0.001);
  const y = (v) => B - ((v - yLo) / Math.max(1e-6, yHi - yLo)) * (B - T);
  const best = rows.reduce((m, r) => (r.netGain > m.netGain ? r : m), rows[0]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }}>
      <rect x="0" y="0" width={W} height={H} fill={C.paper} />
      <line x1={L} y1={y(0)} x2={R} y2={y(0)} stroke={C.gridMajor} strokeWidth="1" />
      {rows.map((r) => (
        <g key={r.pitch}>
          <line x1={x(r.pitch)} y1={T} x2={x(r.pitch)} y2={B} stroke={C.grid} strokeWidth="1" />
          <text x={x(r.pitch)} y={B + 14} textAnchor="middle" fill={C.muted}
            style={{ font: "9.5px var(--mono)" }}>{fmt(r.pitch, 1)}</text>
        </g>
      ))}
      <polyline fill="none" stroke={C.accent} strokeWidth="2"
        points={rows.map((r) => `${x(r.pitch)},${y(r.netGain)}`).join(" ")} />
      {rows.map((r) => (
        <circle key={r.pitch} cx={x(r.pitch)} cy={y(r.netGain)} r={r.pitch === chosen ? 5 : 3}
          fill={r.pitch === chosen ? "#fff" : C.accent}
          stroke={r.pitch === chosen ? C.accent : "none"} strokeWidth="2" />
      ))}
      <g>
        <line x1={x(best.pitch)} y1={T} x2={x(best.pitch)} y2={B}
          stroke="#59b56f" strokeWidth="1.4" strokeDasharray="4 3" />
        <text x={x(best.pitch)} y={T + 10} textAnchor="middle" fill="#7fc78f"
          style={{ font: "600 10px var(--mono)" }}>best value {fmt(best.pitch, 1)} m</text>
      </g>
      <text x={(L + R) / 2} y={H - 6} textAnchor="middle" fill={C.muted}
        style={{ font: "10px system-ui" }}>Row pitch (m)</text>
      <text x="12" y={(T + B) / 2} textAnchor="middle" fill={C.muted}
        transform={`rotate(-90 12 ${(T + B) / 2})`} style={{ font: "10px system-ui" }}>
        Net value vs tightest pitch
      </text>
    </svg>
  );
}

export function YieldReportTab({ loc, setLoc, mod, inv, elec, frame, summary, rates, st, set }) {
  const [era5, setEra5] = useState({ state: "idle", msg: "" });
  const [tmy, setTmy] = useState({ state: "idle", msg: "" });
  const [pvc, setPvc] = useState({ state: "idle", msg: "" });

  const pull = (setter, fn) => async () => {
    setter({ state: "busy", msg: "" });
    const r = await fn();
    setter(r.ok
      ? { state: "ok", msg: "", data: r.data, url: r.url, at: new Date() }
      : { state: "err", msg: r.msg, url: r.url });
  };
  const pullEra5 = pull(setEra5, () => fetchEra5(loc.lat, loc.lon));
  const pullTmy = pull(setTmy, () => fetchTmy(loc.lat, loc.lon));
  const pullPvc = pull(setPvc, () => fetchPvcalc({
    lat: loc.lat, lon: loc.lon, mounting: frame.mounting, tilt: frame.tilt, loss: st.bos,
  }));
  // Concurrently: a source that is slow or blocked should not hold up the
  // two that are fine.
  const pullAll = () => { pullEra5(); pullTmy(); pullPvc(); };

  /* ---- the plant, as configured elsewhere ---- */
  const mwp = summary?.dcMWp ?? 0;
  const pitch0 = summary?.pitch ?? 0;
  const collectW = summary?.collectW ?? 0;
  const gcr0 = pitch0 > 0 ? collectW / pitch0 : 0;
  const acMw = summary ? (summary.inverters * (summary.invAcKw || 0)) / 1000 : 0;

  /* Fraction of the unshaded yield a given ground cover ratio keeps.
     Backtracking trackers trade shade for cosine loss, so their curve is
     shallower than fixed tilt — but it is not flat, which is the whole
     point of sweeping the pitch at all. */
  const keepAt = (gcr) => (frame.mounting === "fixed"
    ? 1 - st.shadeK * Math.pow(Math.max(0, gcr - 0.18), 1.7)
    : 1 - st.shadeK * 0.55 * Math.pow(Math.max(0, gcr - 0.22), 1.7));

  /* ---- expected generation ---- */
  const specYield = pvc.state === "ok" ? pvc.data.specYield : null;
  // PVcalc models a free-standing array with no row in front of it. Ours
  // supplies the shading a real pitch imposes; below is the fraction of
  // the free-standing figure this geometry keeps.
  // Modelled by default from the pitch actually in use, so the headline
  // figure is not silently the unshaded one; an entered value overrides it
  // and the card says which of the two is in play.
  const modelledKeep = gcr0 > 0 ? keepAt(gcr0) : 1;
  const keepIsEntered = st.geomKeep !== null && st.geomKeep !== undefined;
  const geomKeep = keepIsEntered ? st.geomKeep : modelledKeep;
  const netSpec = specYield !== null ? specYield * geomKeep : null;
  const annualGWh = netSpec !== null ? (netSpec * mwp * 1000) / 1e6 : null;
  const cf = netSpec !== null && acMw > 0 ? (netSpec * mwp * 1000) / (acMw * 1000 * 8760) : null;

  /* ---- pitch against everything it costs ----

     Widening the pitch always adds yield per module, so a model that
     charges nothing for the space would always answer "wider" — which is
     not advice, it is an artefact. What the extra space costs depends on
     which constraint is real, and on a given job exactly one of them is:

       Fixed capacity — the plant is the plant. A wider pitch spreads the
         same MWp over more land, so it buys more cable, more land and
         more civils. Area goes as the pitch; collection cable over a
         compact area goes as the square root of area.

       Fixed site — the boundary is the boundary, which is the usual case
         once a site is drawn. A wider pitch fits fewer rows, so capacity
         falls roughly as 1/pitch. That loses energy and saves capex, and
         the two do not cancel.

     Cable is anchored on the length the layout actually routed at the
     pitch in use; the scaling away from it is a model and is labelled
     as one. */
  const lv0 = summary?.lv ?? 0;
  const mv0 = summary?.mv ?? 0;
  const area0 = summary?.areaM2 ?? 0;
  const perWp = (rates.modWp || 0) + (rates.mountWp || 0);   // £/Wp of module + mounting
  const rows = useMemo(() => {
    if (!(pitch0 > 0) || !(collectW > 0)) return [];
    const out = [];
    const n = 9;
    const steps = [];
    for (let i = 0; i < n; i++) steps.push(+(st.pLo + ((st.pHi - st.pLo) * i) / (n - 1)).toFixed(2));
    // The pitch actually in use always gets a row, otherwise there is
    // nothing to compare the alternatives against.
    if (!steps.some((v) => Math.abs(v - pitch0) < 0.05)) steps.push(+pitch0.toFixed(2));
    steps.sort((a, b) => a - b);
    for (const pitch of steps) {
      if (!(pitch > collectW)) continue;
      const gcr = collectW / pitch;
      // Row-shading loss against an unshaded row, as a fraction kept.
      // Backtracking trackers lose to cosine rather than to shade, so the
      // curve is shallower than fixed tilt but it is not flat.
      const keep = keepAt(gcr);
      const spec = (specYield ?? 1000) * keep;
      const fixedSite = st.constraint === "site";
      // Rows fit as 1/pitch, so on a fixed boundary capacity does too.
      const cap = fixedSite ? mwp * (pitch0 / pitch) : mwp;
      const area = fixedSite ? area0 : area0 * (pitch / pitch0);
      // Fixed site: cable follows the capacity it serves. Fixed capacity:
      // the same plant spread over more ground, so cable goes as the root
      // of the area.
      const scale = fixedSite ? cap / mwp : Math.sqrt(pitch / pitch0);
      const lv = lv0 * scale, mv = mv0 * scale;
      const energyMwh = spec * cap * 1000 / 1000;
      const cableCost = (lv * rates.lv + mv * rates.mv) / 1000;              // £k
      const landCost = (area * st.landCost) / 1000;                          // £k
      const arrayCost = cap * 1e6 * perWp / 1000;                            // £k
      const capex = cableCost + landCost + arrayCost;
      const revenue = (energyMwh * st.tariff) / 1000;                        // £k per year
      out.push({ pitch, gcr, keep, spec, cap, area, energyMwh, lv, mv,
        cableCost, landCost, arrayCost, capex, revenue });
    }
    if (!out.length) return [];
    const base = out[0];
    return out.map((r) => ({
      ...r,
      dYield: ((r.spec - base.spec) / base.spec) * 100,
      dEnergy: ((r.energyMwh - base.energyMwh) / base.energyMwh) * 100,
      dCable: r.lv + r.mv - (base.lv + base.mv),
      dCost: r.capex - base.capex,
      // Value against the tightest pitch: extra revenue over the appraisal
      // period, less the extra capex — cable, land and array together, so
      // nothing about the extra space is free.
      netGain: (r.revenue - base.revenue) * st.years - (r.capex - base.capex),
    }));
  }, [pitch0, collectW, st, specYield, mwp, lv0, mv0, area0, perWp,
      rates.lv, rates.mv, frame.mounting]);

  const best = rows.length ? rows.reduce((m, r) => (r.netGain > m.netGain ? r : m), rows[0]) : null;
  const chosen = rows.find((r) => Math.abs(r.pitch - pitch0) < 0.3);

  const noLayout = !summary || !(mwp > 0);

  return (
    <Page wide>
      <div className="tbl" style={{ marginBottom: 10 }}>
        YIELD REPORT — PULLED DATA, EXPECTED GENERATION, AND THE PITCH TRADE-OFF
      </div>

      <Section code="Y1" title="Data sources">
        <div style={{ display: "flex", gap: 8, width: "100%", flexWrap: "wrap", marginBottom: 4 }}>
          <Num label="Site latitude" unit="°" value={loc.lat} step={0.001}
            onChange={(v) => setLoc({ ...loc, lat: v })} />
          <Num label="Site longitude" unit="°" value={loc.lon} step={0.001}
            onChange={(v) => setLoc({ ...loc, lon: v })} />
        </div>
        <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
          <Source name="Open-Meteo ERA5 — temperature extremes" st={era5} onPull={pullEra5}
            what="Ten years of daily minima and maxima, for the cold-morning voltage check.">
            {era5.state === "ok" && (
              <div className="readout" style={{ marginTop: 6 }}>
                Lowest <b>{fmt(era5.data.lo, 1)} °C</b>, highest <b>{fmt(era5.data.hi, 1)} °C</b>
                {" "}over {fmt(era5.data.days, 0)} days. These are the extremes, never an average —
                averaging softens exactly the event the check exists to catch.
              </div>
            )}
          </Source>
          <Source name="PVGIS TMY — 8,760 hours" st={tmy} onPull={pullTmy}
            what="A typical meteorological year of GHI, DNI, DHI and air temperature, which the pitch model runs against.">
            {tmy.state === "ok" && (
              <div className="readout" style={{ marginTop: 6 }}>
                {fmt(tmy.data.outputs.tmy_hourly.length, 0)} hours loaded. Without this the pitch
                model falls back to a clear-sky synthetic year: the geometry stays right and the
                absolute yield runs high.
              </div>
            )}
          </Source>
          <Source name="PVGIS PVcalc — validated yield baseline" st={pvc} onPull={pullPvc}
            what="Their own PV model, terrain horizon included, for one kWp of this mounting type. The only absolute yield figure in the tool that is not ours.">
            {pvc.state === "ok" && (
              <div className="readout" style={{ marginTop: 6 }}>
                <b>{fmt(pvc.data.specYield, 0)} kWh/kWp</b> unshaded
                {pvc.data.irradiation ? <> from {fmt(pvc.data.irradiation, 0)} kWh/m² in plane</> : null}
                {pvc.data.sdYear ? <>, year-to-year spread ±{fmt(pvc.data.sdYear, 0)} kWh/kWp</> : null}.
              </div>
            )}
          </Source>
        </div>
        <button className="btn primary" onClick={pullAll}>Pull all three</button>
        <Num label="System losses for PVcalc" unit="%" value={st.bos} step={0.5}
          onChange={(v) => set({ ...st, bos: v })} />
        <div className="readout">
          All three are optional and the tool works offline without them, but a generation figure
          quoted to a client from a fallback model is worse than no figure at all — so nothing here
          is assumed. Coordinates are shared with string sizing and the layout, and a KMZ dropped
          on the Layout tab sets them.
        </div>
      </Section>

      <Section code="Y2" title="The plant as configured">
        {noLayout ? (
          <div className="warn" style={{ width: "100%" }}>
            ⚠ No layout yet. Draw or import a boundary on the Layout tab and pick a variant —
            everything below reads the plant from there rather than asking you to retype it.
          </div>
        ) : (
          <div className="readout">
            <b>{fmt(mwp, 2)} MWp</b> across {fmt(summary.modules, 0)} modules of {summary.modPower} W
            on {fmt(summary.frames, 0)} frames, {summary.inverters} inverters
            ({fmt(acMw, 2)} MVA), DC/AC <b>{acMw > 0 ? fmt(mwp / acMw, 2) : "—"}</b>.
            {" "}{summary.mounting === "fixed" ? `Fixed tilt at ${fmt(summary.tilt, 0)}°` : "Single-axis tracker"},
            {" "}row pitch <b>{fmt(pitch0, 2)} m</b> over a {fmt(collectW, 2)} m collector,
            GCR <b>{fmt(gcr0, 3)}</b>. Site area {fmt((summary.areaM2 || 0) / 1e6, 3)} km².
            {lv0 ? <> Collection cable as routed: LV {fmtKm(lv0)}, MV {fmtKm(mv0)}.</> : null}
          </div>
        )}
      </Section>

      <Section code="Y3" title="Expected generation">
        {specYield === null ? (
          <div className="warn" style={{ width: "100%" }}>
            ⚠ Pull PVGIS PVcalc above to put an absolute number here. Everything else on this tab
            works without it — the pitch comparison below is a ratio and does not need it.
          </div>
        ) : (
          <>
            <Num label={`Row-geometry factor kept (${keepIsEntered ? "entered" : "modelled"})`}
              value={+geomKeep.toFixed(4)} step={0.005} min={0.5} max={1}
              onChange={(v) => set({ ...st, geomKeep: v })} />
            {keepIsEntered && (
              <button className="btn" onClick={() => set({ ...st, geomKeep: null })}>
                Back to modelled ({fmt(modelledKeep, 4)})
              </button>
            )}
            <Working n="Y3a" title="Specific yield at this geometry"
              formula="Y = Y_PVGIS × f_geometry"
              sub={`${fmt(specYield, 0)} kWh/kWp × ${fmt(geomKeep, 3)}`}
              result={fmt(netSpec, 0)} unit="kWh/kWp"
              why={`PVGIS models a free-standing array with nothing in front of it, because its API has no pitch or GCR parameter. The factor is the fraction this row spacing keeps. ${keepIsEntered ? "This one was entered — a figure from PVsyst or from the Pitch & Yield tab belongs here and beats the model." : `This one is modelled from the GCR of ${fmt(gcr0, 3)} you have built at, and it is the same model the pitch sweep below uses, so the headline figure and the comparison agree. Overwrite it with a PVsyst result the moment you have one.`}`} />
            <Working n="Y3b" title="Annual generation"
              formula="E = Y × P_dc"
              sub={`${fmt(netSpec, 0)} kWh/kWp × ${fmt(mwp, 2)} MWp`}
              result={fmt(annualGWh, 2)} unit="GWh per year"
              why={`Capacity factor ${cf === null ? "—" : fmt(cf * 100, 1)} % against ${fmt(acMw, 2)} MVA of inverter. This is a preliminary figure for starting a conversation, not a bankable one: it carries no soiling schedule, no availability assumption, no degradation and no measured horizon.`} />
            <div style={{ width: "100%", background: C.paper, border: `1px solid ${C.line}`,
              borderRadius: 6, padding: 8 }}>
              <MonthlyBars monthly={pvc.data.monthly} mwp={mwp * geomKeep} />
            </div>
          </>
        )}
      </Section>

      <Section code="Y4" title="Pitch against cable — the trade-off">
        <Num label="Pitch sweep from" unit="m" value={st.pLo} step={0.5}
          onChange={(v) => set({ ...st, pLo: v })} />
        <Num label="Pitch sweep to" unit="m" value={st.pHi} step={0.5}
          onChange={(v) => set({ ...st, pHi: v })} />
        <Sel label="Which constraint is real?" value={st.constraint}
          onChange={(v) => set({ ...st, constraint: v })}
          options={[
            { value: "site", label: "Fixed site — the boundary is the boundary" },
            { value: "capacity", label: "Fixed capacity — the plant is the plant" },
          ]} />
        <Num label="Land + civils" unit="£/m²" value={st.landCost} step={0.1}
          onChange={(v) => set({ ...st, landCost: v })} />
        <Num label="Tariff / PPA" unit="£/MWh" value={st.tariff} step={1}
          onChange={(v) => set({ ...st, tariff: v })} />
        <Num label="Appraisal period" unit="years" value={st.years} step={1}
          onChange={(v) => set({ ...st, years: v })} />
        <Num label="Row-shading coefficient" value={st.shadeK} step={0.05}
          onChange={(v) => set({ ...st, shadeK: v })} />
        <div className="readout" style={{ font: "10.5px system-ui" }}>
          The shading coefficient sets how steeply yield falls as rows close up. The default is
          calibrated so a backtracking tracker at GCR 0.41 loses about 2.2 % against a very wide
          pitch, and a fixed-tilt array at the same GCR about 5.5 % — the right order for both, but
          it is a two-parameter curve standing in for an hourly simulation. Run two pitches in
          PVsyst and turn this dial until the model reproduces the gap between them; everything on
          this tab then sharpens at once.
        </div>
        {noLayout ? (
          <div className="warn" style={{ width: "100%" }}>⚠ Needs a layout to anchor the cable lengths.</div>
        ) : (
          <>
            <div style={{ overflowX: "auto", width: "100%", WebkitOverflowScrolling: "touch" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 820,
                font: "12px var(--mono)" }}>
                <thead><tr>
                  {["Pitch m", "GCR", st.constraint === "site" ? "MWp fitted" : "Area km²",
                    "Yield/kWp", "Energy MWh/yr", "Cable LV+MV",
                    "Extra cable", "Extra capex", `Net over ${fmt(st.years, 0)} yr`, ""].map((h) => (
                    <th key={h} style={{ padding: "6px 9px", borderBottom: `1px solid ${C.line}`,
                      textAlign: "left", font: "600 9.5px system-ui", textTransform: "uppercase",
                      letterSpacing: "0.07em", color: C.muted, whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {rows.map((r) => {
                    const isBest = best && r.pitch === best.pitch;
                    const isNow = chosen && r.pitch === chosen.pitch;
                    return (
                      <tr key={r.pitch} style={{
                        borderTop: `1px solid ${C.line}`,
                        background: isNow ? "rgba(232,130,12,0.12)" : "transparent",
                      }}>
                        <td style={{ padding: "5px 9px" }}><b>{fmt(r.pitch, 2)}</b></td>
                        <td style={{ padding: "5px 9px", color: C.muted }}>{fmt(r.gcr, 3)}</td>
                        <td style={{ padding: "5px 9px", color: C.muted }}>
                          {st.constraint === "site" ? fmt(r.cap, 2) : fmt(r.area / 1e6, 3)}
                        </td>
                        <td style={{ padding: "5px 9px" }}>
                          {r.dYield >= 0 ? "+" : ""}{fmt(r.dYield, 2)}%
                        </td>
                        <td style={{ padding: "5px 9px", color: C.muted }}>
                          {fmt(r.energyMwh, 0)}
                          <span style={{ color: r.dEnergy >= 0 ? "#59b56f" : "#d67070", marginLeft: 6 }}>
                            {r.dEnergy >= 0 ? "+" : ""}{fmt(r.dEnergy, 2)}%
                          </span>
                        </td>
                        <td style={{ padding: "5px 9px", color: C.muted }}>{fmtKm(r.lv + r.mv)}</td>
                        <td style={{ padding: "5px 9px" }}>
                          {r.dCable > 0 ? "+" : ""}{fmtKm(r.dCable)}
                        </td>
                        <td style={{ padding: "5px 9px" }}>
                          {r.dCost > 0 ? "+" : ""}{rates.cur}{fmt(r.dCost, 0)}k
                        </td>
                        <td style={{ padding: "5px 9px",
                          color: r.netGain > 0 ? "#59b56f" : r.netGain < 0 ? "#d67070" : C.muted }}>
                          <b>{r.netGain >= 0 ? "+" : ""}{rates.cur}{fmt(r.netGain, 0)}k</b>
                        </td>
                        <td style={{ padding: "5px 9px", font: "10px system-ui", color: C.muted }}>
                          {isBest ? "★ best value" : ""}{isBest && isNow ? " · " : ""}{isNow ? "in use" : ""}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ width: "100%", background: C.paper, border: `1px solid ${C.line}`,
              borderRadius: 6, padding: 8 }}>
              <TradeCurve rows={rows} chosen={chosen?.pitch} />
            </div>
            {best && chosen && (
              <Working n="Y4a" title="Is a wider pitch worth it?"
                formula="net = (ΔE × tariff × years) − Δcable cost"
                sub={`best value at ${fmt(best.pitch, 2)} m against ${fmt(chosen.pitch, 2)} m in use`}
                result={`${best.netGain - chosen.netGain >= 0 ? "+" : ""}${rates.cur}${fmt(best.netGain - chosen.netGain, 0)}k`}
                status={Math.abs(best.pitch - chosen.pitch) < 0.4 ? "OK" : "Review pitch"}
                why={`Going from ${fmt(chosen.pitch, 2)} m to ${fmt(best.pitch, 2)} m changes yield per kWp by ${fmt(best.dYield - chosen.dYield, 2)} %, total energy by ${fmt(best.dEnergy - chosen.dEnergy, 2)} % and cable by ${fmtKm(Math.abs(best.dCable - chosen.dCable))}. ${st.constraint === "site" ? "On a fixed boundary a wider pitch fits fewer rows, so each module earns more and there are fewer of them — the optimum is where those two stop trading evenly, and it moves with the tariff and the module price, not with the irradiance." : "At fixed capacity a wider pitch always adds yield, so the answer is set entirely by what the extra ground costs: cable, land and civils. Set those to zero and the model will tell you to spread out for ever, which is why they are inputs rather than assumptions."}`} />
            )}
            <div className="readout">
              <b>What is measured and what is modelled.</b> Cable length at the pitch in use is the
              layout's own routed figure; every other row scales away from it
              {st.constraint === "site"
                ? " with the capacity it serves, because the boundary is fixed and a wider pitch simply fits fewer rows."
                : " as √(pitch/pitch₀), because at fixed capacity the area goes as the pitch and collection cable over a compact area goes as the square root of area."}
              {" "}The yield column is a ratio from a two-parameter row-shading curve, not a
              simulation. Both are for ranking pitches against each other; PVsyst decides the number
              you commit to. What makes the ranking worth having before any simulation exists is
              that the ratios survive a change of irradiance dataset far better than the absolute
              does — swap the dataset and every pitch moves together.
            </div>
          </>
        )}
      </Section>

      <Section code="Y5" title="Summary for the client">
        {noLayout || specYield === null ? (
          <div className="readout" style={{ color: C.muted }}>
            Fills in once a layout exists and PVcalc has been pulled.
          </div>
        ) : (
          <div style={{ width: "100%", background: C.panel2, border: `1px solid ${C.accent}55`,
            borderRadius: 6, padding: "14px 16px", lineHeight: 1.7 }}>
            <div style={{ font: "600 13px system-ui", color: C.accent, marginBottom: 8 }}>
              Indicative performance — preliminary design
            </div>
            <div style={{ font: "12.5px system-ui", color: C.text }}>
              A <b>{fmt(mwp, 1)} MWp</b> ({fmt(acMw, 1)} MVA) array at {fmt(loc.lat, 4)}, {fmt(loc.lon, 4)}
              {" "}on {summary.mounting === "fixed" ? `fixed tilt at ${fmt(summary.tilt, 0)}°` : "single-axis trackers"}
              {" "}at {fmt(pitch0, 2)} m row pitch is expected to generate approximately
              {" "}<b>{fmt(annualGWh, 1)} GWh per year</b> ({fmt(netSpec, 0)} kWh/kWp,
              capacity factor {cf === null ? "—" : fmt(cf * 100, 1)} %), occupying
              {" "}{fmt((summary.areaM2 || 0) / 1e6, 2)} km².
            </div>
            <div style={{ font: "11px system-ui", color: C.muted, marginTop: 10 }}>
              Basis: PVGIS {pvc.data.sdYear ? "SARAH3" : "satellite"} irradiance and PVGIS's own PV
              model for the absolute yield, with row-geometry effects applied on top; {fmt(st.bos, 1)} %
              system losses assumed. This is a preliminary figure to frame a conversation. It carries
              no soiling schedule, no availability assumption, no degradation profile and no measured
              horizon, and it has not been simulated in PVsyst. Expect the bankable figure to sit
              below it.
            </div>
          </div>
        )}
      </Section>
    </Page>
  );
}
