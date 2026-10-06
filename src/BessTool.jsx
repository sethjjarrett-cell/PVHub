/* =====================================================================
   BATTERY SIZING TAB

   Two panes, because there are two different questions and conflating
   them is how batteries get specified badly.

   "Capacity requirement" answers a tender: so many MW for so many
   hours, worked back through the derates to a nameplate and a unit
   count. Arithmetic only, reproducing the source workbook exactly.

   "Load following" answers a design: here is a load and an array, how
   big a battery is worth buying. That needs an hour-by-hour run over a
   year, which is what HOMER does and what this does.

   The last section walks the whole calculation through in prose with
   this project's own numbers substituted, because a number you cannot
   reproduce by hand is a number you cannot defend.
   ===================================================================== */

import React, { useMemo, useState, useRef } from "react";
import { fmt, C, Num, Sel, Section, Page, Working } from "./ui.jsx";
import {
  nameplateFromUsable, unitCount, loadProfile, pvProfile,
  dispatch, sweepBattery, suggestSizes, LOAD_SHAPES,
} from "./bess.js";

/* ---------------------------------------------------------------
   Units. One engine in kW/kWh, two ways of reading it.
   --------------------------------------------------------------- */
const UNITS = {
  small: { p: "kW", e: "kWh", kp: 1, ke: 1, dp: 1 },
  large: { p: "MW", e: "MWh", kp: 1000, ke: 1000, dp: 2 },
};
const U = (scale) => UNITS[scale === "large" ? "large" : "small"];

function Chart({ title, subtitle, children, legend }) {
  return (
    <div style={{ width: "100%", background: C.panel, border: `1px solid ${C.line}`,
      borderRadius: 6, padding: "10px 12px 12px", marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
        <div style={{ font: "600 12px system-ui", color: C.text }}>{title}</div>
        <div style={{ font: "10.5px system-ui", color: C.muted, flex: 1 }}>{subtitle}</div>
      </div>
      <div style={{ background: C.paper, borderRadius: 4, overflow: "hidden" }}>{children}</div>
      {legend && (
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 7,
          font: "10.5px system-ui", color: C.muted }}>
          {legend.map(([col, label]) => (
            <span key={label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: 11, height: 11, borderRadius: 2, background: col }} />{label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Where the energy went, as one stacked bar per month. */
function ChartMonthly({ d, u }) {
  const w = 820, h = 300, ml = 56, mr = 14, mt = 14, mb = 34;
  const iw = w - ml - mr, ih = h - mt - mb;
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const max = Math.max(1, ...d.monthly.map((m) => m.direct + m.fromBattery + m.imported + m.unmet));
  const bw = (iw / 12) * 0.62;
  const y = (v) => mt + ih - (v / max) * ih;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ display: "block" }}>
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <g key={f}>
          <line x1={ml} x2={w - mr} y1={y(max * f)} y2={y(max * f)} stroke={C.line} strokeWidth="1" />
          <text x={ml - 7} y={y(max * f) + 4} textAnchor="end"
            style={{ font: "10px var(--mono)", fill: C.muted }}>{fmt(max * f / u.ke, 0)}</text>
        </g>
      ))}
      <text x={13} y={mt + ih / 2} textAnchor="middle" transform={`rotate(-90 13 ${mt + ih / 2})`}
        style={{ font: "10px system-ui", fill: C.muted }}>Load met, {u.e}</text>
      {d.monthly.map((m, i) => {
        const x = ml + (iw / 12) * (i + 0.5) - bw / 2;
        const segs = [[m.direct, "#e8820c"], [m.fromBattery, "#4fb06a"],
          [m.imported, "#3a96e0"], [m.unmet, "#d67070"]];
        let acc = 0;
        return (
          <g key={i}>
            {segs.map(([v, col], j) => {
              if (v <= 0) return null;
              const yTop = y(acc + v), yBot = y(acc); acc += v;
              return <rect key={j} x={x} y={yTop} width={bw} height={Math.max(0, yBot - yTop)} fill={col} />;
            })}
            <text x={x + bw / 2} y={h - 12} textAnchor="middle"
              style={{ font: "10px system-ui", fill: C.muted }}>{MONTHS[i]}</text>
          </g>
        );
      })}
    </svg>
  );
}

/** State of charge through a chosen week, which is where dispatch becomes legible. */
function ChartWeek({ d, pv, load, startHour, u }) {
  const w = 820, h = 260, ml = 50, mr = 46, mt = 14, mb = 30;
  const iw = w - ml - mr, ih = h - mt - mb;
  const n = 168;
  const s = Math.max(0, Math.min(8760 - n, startHour));
  const pvW = Array.from({ length: n }, (_, i) => pv[s + i]);
  const ldW = Array.from({ length: n }, (_, i) => load[s + i]);
  const socW = Array.from({ length: n }, (_, i) => d.socSeries[s + i]);
  const maxP = Math.max(1e-9, ...pvW, ...ldW);
  const x = (i) => ml + (i / (n - 1)) * iw;
  const yP = (v) => mt + ih - (v / maxP) * ih;
  const yS = (v) => mt + ih - (v / 100) * ih;
  const path = (arr, f) => arr.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${f(v).toFixed(1)}`).join("");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ display: "block" }}>
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={ml} x2={w - mr} y1={yP(maxP * f)} y2={yP(maxP * f)} stroke={C.line} />
          <text x={ml - 6} y={yP(maxP * f) + 4} textAnchor="end"
            style={{ font: "10px var(--mono)", fill: C.muted }}>{fmt(maxP * f / u.kp, 1)}</text>
          <text x={w - mr + 6} y={yS(f * 100) + 4}
            style={{ font: "10px var(--mono)", fill: "#8c6fd0" }}>{fmt(f * 100, 0)}%</text>
        </g>
      ))}
      {Array.from({ length: 7 }, (_, dd) => (
        <line key={dd} x1={x(dd * 24)} x2={x(dd * 24)} y1={mt} y2={mt + ih}
          stroke={C.line} strokeDasharray="2 3" />
      ))}
      <path d={path(socW, yS)} fill="none" stroke="#8c6fd0" strokeWidth="2.5" opacity="0.85" />
      <path d={path(pvW, yP)} fill="none" stroke="#e8820c" strokeWidth="1.8" />
      <path d={path(ldW, yP)} fill="none" stroke="#3a96e0" strokeWidth="1.8" />
      <text x={13} y={mt + ih / 2} textAnchor="middle" transform={`rotate(-90 13 ${mt + ih / 2})`}
        style={{ font: "10px system-ui", fill: C.muted }}>Power, {u.p}</text>
      {Array.from({ length: 7 }, (_, dd) => (
        <text key={dd} x={x(dd * 24 + 12)} y={h - 10} textAnchor="middle"
          style={{ font: "10px system-ui", fill: C.muted }}>Day {dd + 1}</text>
      ))}
    </svg>
  );
}

/** Self-sufficiency against battery size, with the knee marked. */
function ChartSweep({ s, u }) {
  const w = 820, h = 300, ml = 52, mr = 16, mt = 16, mb = 38;
  const iw = w - ml - mr, ih = h - mt - mb;
  const xs = s.rows.map((r) => r.nameplateKWh);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const x = (v) => ml + ((v - x0) / Math.max(1e-9, x1 - x0)) * iw;
  const y = (v) => mt + ih - (v / 100) * ih;
  const path = s.rows.map((r, i) => `${i ? "L" : "M"}${x(r.nameplateKWh).toFixed(1)},${y(r.selfSufficiencyPct).toFixed(1)}`).join("");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ display: "block" }}>
      {[0, 25, 50, 75, 100].map((f) => (
        <g key={f}>
          <line x1={ml} x2={w - mr} y1={y(f)} y2={y(f)} stroke={C.line} />
          <text x={ml - 6} y={y(f) + 4} textAnchor="end"
            style={{ font: "10px var(--mono)", fill: C.muted }}>{f}%</text>
        </g>
      ))}
      {s.knee && (
        <g>
          <line x1={x(s.knee.nameplateKWh)} x2={x(s.knee.nameplateKWh)} y1={mt} y2={mt + ih}
            stroke="#4fb06a" strokeWidth="1.5" strokeDasharray="4 3" />
          <text x={x(s.knee.nameplateKWh) + 5} y={mt + 12}
            style={{ font: "600 10.5px system-ui", fill: "#4fb06a" }}>
            knee — {fmt(s.knee.nameplateKWh / u.ke, u.dp)} {u.e}
          </text>
        </g>
      )}
      <path d={path} fill="none" stroke="#e8820c" strokeWidth="2.5" />
      {s.rows.map((r, i) => (
        <circle key={i} cx={x(r.nameplateKWh)} cy={y(r.selfSufficiencyPct)} r="3"
          fill={s.knee && r.nameplateKWh === s.knee.nameplateKWh ? "#4fb06a" : "#e8820c"} />
      ))}
      <text x={13} y={mt + ih / 2} textAnchor="middle" transform={`rotate(-90 13 ${mt + ih / 2})`}
        style={{ font: "10px system-ui", fill: C.muted }}>Self-sufficiency</text>
      <text x={ml + iw / 2} y={h - 8} textAnchor="middle"
        style={{ font: "10px system-ui", fill: C.muted }}>Battery nameplate, {u.e}</text>
      {s.rows.filter((_, i) => i % 2 === 0).map((r, i) => (
        <text key={i} x={x(r.nameplateKWh)} y={h - 24} textAnchor="middle"
          style={{ font: "9.5px var(--mono)", fill: C.muted }}>{fmt(r.nameplateKWh / u.ke, u.dp)}</text>
      ))}
    </svg>
  );
}

const Stat = ({ label, value, unit, tone }) => (
  <div style={{ background: C.panel2, border: `1px solid ${tone || C.line}`, borderRadius: 6,
    padding: "8px 11px", minWidth: 112 }}>
    <div style={{ font: "10px system-ui", color: C.muted }}>{label}</div>
    <div style={{ font: "650 17px var(--mono)", color: tone || C.text }}>
      {value}<span style={{ font: "10.5px system-ui", color: C.muted }}> {unit}</span>
    </div>
  </div>
);

export function BessTab({ st, set, scale, tmy, kWpHint, lat }) {
  const u = U(scale);
  const [week, setWeek] = useState(0);

  /* ---- A. the capacity chain ---- */
  const chain = useMemo(() => nameplateFromUsable({
    usableKWh: st.usableKWh, dodPct: st.dod, rtePct: st.rte,
    auxPct: st.aux, retentionPct: st.retention, sizeFor: st.sizeFor,
  }), [st.usableKWh, st.dod, st.rte, st.aux, st.retention, st.sizeFor]);

  const units = useMemo(() => unitCount({
    requiredKW: st.powerKW, nameplateKWh: chain.nameplateKWh,
    unitKWh: st.unitKWh, unitKW: st.unitKW, pf: st.pf,
    dodPct: st.dod, rtePct: st.rte, auxPct: st.aux,
    retentionPct: st.retention, sizeFor: st.sizeFor,
  }), [st, chain.nameplateKWh]);

  /* ---- B. the simulation ---- */
  const load = useMemo(() => loadProfile({
    annualKWh: st.annualLoadKWh, shape: st.shape, weekendFactor: st.weekendFactor,
    seasonalAmp: st.seasonalAmp, seasonalPeak: st.seasonalPeak,
  }), [st.annualLoadKWh, st.shape, st.weekendFactor, st.seasonalAmp, st.seasonalPeak]);

  const { pv, synthetic } = useMemo(() => pvProfile({
    tmy, kWp: st.kWp || kWpHint || 0, specificYield: st.specificYield, lat: lat || 0,
  }), [tmy, st.kWp, kWpHint, st.specificYield, lat]);

  const sim = useMemo(() => dispatch({
    pv, load, nameplateKWh: st.battKWh, powerKW: st.battKW,
    rtePct: st.rte, dodPct: st.dod, socInitPct: 50,
    hasGrid: st.hasGrid, exportLimitKW: st.exportLimit > 0 ? st.exportLimit : Infinity,
  }), [pv, load, st.battKWh, st.battKW, st.rte, st.dod, st.hasGrid, st.exportLimit]);

  const sweep = useMemo(() => {
    const sizes = suggestSizes(st.annualLoadKWh / 365, 12);
    return sweepBattery({ pv, load, powerKW: st.battKW, rtePct: st.rte, dodPct: st.dod,
      hasGrid: st.hasGrid, exportLimitKW: st.exportLimit > 0 ? st.exportLimit : Infinity },
      sizes, st.kneeFraction / 100);
  }, [pv, load, st.battKW, st.rte, st.dod, st.hasGrid, st.exportLimit, st.annualLoadKWh, st.kneeFraction]);

  const E = (v, dp = u.dp) => fmt(v / u.ke, dp);
  const P = (v, dp = u.dp) => fmt(v / u.kp, dp);
  const dailyLoad = st.annualLoadKWh / 365;

  return (
    <Page wide>
      <div className="tbl" style={{ marginBottom: 10 }}>
        BATTERY SIZING — CAPACITY CHAIN AND HOURLY DISPATCH
      </div>

      <Section code="B1" title="What are you sizing for?">
        <Sel label="Question to answer" value={st.basis}
          onChange={(v) => set({ ...st, basis: v })}
          options={[
            { value: "requirement", label: "A stated requirement — so much power for so many hours" },
            { value: "following", label: "A load to cover — how big a battery is worth buying" },
          ]} />
        <div className="readout">
          {st.basis === "requirement" ? <>
            <b>A capacity requirement is arithmetic, not a simulation.</b> A tender that says
            35 MW for 5 hours is asking for energy deliverable at the meter, and the job is to
            work back through depth of discharge, the round-trip losses, the auxiliary load and
            whatever degradation you are sizing for, to the nameplate you have to install. No
            weather and no load profile enter into it. That is section B2 and B3.
          </> : <>
            <b>How big a battery is worth buying cannot be answered by arithmetic</b>, because
            the answer depends on when the sun shines against when the load runs. Two sites with
            identical annual figures need different batteries if one is an office and the other a
            house. Sections B4 to B6 step through 8,760 hours and count what the battery actually
            saved, which is what HOMER does and the only honest way to answer it.
          </>}
        </div>
      </Section>

      {st.basis === "requirement" ? (<>
        <Section code="B2" title="From deliverable energy back to nameplate">
          <Num label={`Required power (${u.p})`} value={st.powerKW / u.kp} step={u.kp === 1 ? 1 : 0.5}
            onChange={(v) => set({ ...st, powerKW: v * u.kp })} />
          <Num label={`Required usable energy at the meter (${u.e})`} value={st.usableKWh / u.ke}
            step={u.ke === 1 ? 1 : 1} onChange={(v) => set({ ...st, usableKWh: v * u.ke })} />
          <Num label="Design power factor" value={st.pf} step={0.01} min={0.1}
            onChange={(v) => set({ ...st, pf: v })} />
          <Working n="B1" title="Implied duration"
            formula="t = E_usable / P"
            sub={`${E(st.usableKWh)} ${u.e} / ${P(st.powerKW)} ${u.p}`}
            result={fmt(st.powerKW > 0 ? st.usableKWh / st.powerKW : 0, 2)} unit="h"
            why="Duration is the shape of the requirement. Under about an hour the job is power — frequency response, ramp smoothing — and the energy comes almost free with the inverters. Above about four hours it is energy, the cells dominate the cost, and a cheaper lower-power conversion stage may suit." />
          <Working n="B2" title="Required apparent power"
            formula="S = P / cos φ"
            sub={`${P(st.powerKW)} ${u.p} / ${fmt(st.pf, 2)}`}
            result={P(st.pf > 0 ? st.powerKW / st.pf : 0)} unit={`MVA`.replace("MVA", u.p === "MW" ? "MVA" : "kVA")}
            why="The conversion stage is rated in apparent power, so a grid code that asks for reactive support at the same real power pushes the inverter rating up. At unity the two are the same number and this step does nothing." />

          <Num label="Usable depth of discharge" unit="%" value={st.dod} step={1} min={1}
            onChange={(v) => set({ ...st, dod: v })} />
          <Num label="Round-trip efficiency" unit="%" value={st.rte} step={0.5} min={1}
            onChange={(v) => set({ ...st, rte: v })} />
          <Num label="Auxiliary and HVAC load" unit="%" value={st.aux} step={0.5} min={0}
            onChange={(v) => set({ ...st, aux: v })} />
          <Sel label="Size the system for" value={st.sizeFor}
            onChange={(v) => set({ ...st, sizeFor: v })}
            options={[{ value: "bol", label: "Beginning of life — hold capacity by augmenting later" },
              { value: "eol", label: "End of life — install day one for year 25" }]} />
          {st.sizeFor === "eol" && (
            <Num label="End-of-life capacity retention" unit="%" value={st.retention} step={1} min={1}
              onChange={(v) => set({ ...st, retention: v })} />
          )}
          <Working n="B3" title="Required nameplate energy"
            formula="E_nameplate = E_usable / (DoD × √RTE × (1 − aux) × retention)"
            sub={`${E(st.usableKWh)} / (${fmt(chain.dod, 3)} × ${fmt(chain.etaDischarge, 4)} × ${fmt(chain.aux, 3)} × ${fmt(chain.retention, 3)})`}
            result={E(chain.nameplateKWh)} unit={u.e}
            why="Each divisor is a real loss between the cells and the connection. Only the discharge half of the round trip stands between stored energy and the meter, so the one-way figure is √RTE on the usual even split — a supplier quoting a one-way number directly should have it entered as RTE², or the loss is applied twice." />
          <div className="readout">
            <b>The commonest error in this calculation is double-counting depth of discharge.</b>
            {" "}If the supplier quotes the container in <b>usable</b> {u.e}, their figure already
            has DoD in it and this input belongs at 100. If they quote gross or nameplate, enter
            the real figure. Getting it wrong either oversizes the plant by a fifth or leaves it
            short by the same, and nothing downstream will tell you which.
            {st.sizeFor === "eol" && <>
              {" "}You are sizing for end of life, which multiplies the installed energy by
              {" "}{fmt(1 / chain.retention, 2)}×. Most projects hold capacity by augmenting
              instead, because cells bought in year eight are cheaper than cells bought in year
              one and left idle.
            </>}
          </div>
        </Section>

        <Section code="B3" title="How many units that is">
          <Num label={`Unit nameplate energy (${u.e})`} value={st.unitKWh / u.ke} step={u.ke === 1 ? 0.5 : 0.5}
            onChange={(v) => set({ ...st, unitKWh: v * u.ke })} />
          <Num label={`Unit rated power (${u.p})`} value={st.unitKW / u.kp} step={u.kp === 1 ? 0.5 : 0.1}
            onChange={(v) => set({ ...st, unitKW: v * u.kp })} />
          <Working n="B4" title="Units needed for power"
            formula="n_power = CEILING(S × cos φ / P_unit)"
            sub={`${P(units.requiredKVA || 0)} × ${fmt(st.pf, 2)} / ${P(st.unitKW)}`}
            result={units.forPower ?? "—"} unit="units"
            why="Rounded up, because you cannot buy part of a container." />
          <Working n="B5" title="Units needed for energy"
            formula="n_energy = CEILING(E_nameplate / E_unit)"
            sub={`${E(chain.nameplateKWh)} / ${E(st.unitKWh)}`}
            result={units.forEnergy ?? "—"} unit="units"
            why="Same rounding, same reason." />
          <Working n="B6" title="Governing unit count"
            formula="n = MAX(n_power, n_energy)"
            sub={`MAX(${units.forPower ?? "—"}, ${units.forEnergy ?? "—"})`}
            result={units.units ?? "—"} unit={`units — ${units.governedBy}-driven`}
            status={units.units && units.deliverableKWh >= st.usableKWh && units.powerOk ? "OK" : "Short"}
            why="Which requirement binds is worth knowing, not just the answer. If energy binds, the extra power comes free with the units and a cheaper lower-power conversion stage may suit. If power binds, the duration is longer than asked for and that headroom is worth something in a tender." />
          <div style={{ display: "flex", gap: 9, flexWrap: "wrap", width: "100%" }}>
            <Stat label="Installed nameplate" value={E(units.installedKWh || 0)} unit={u.e} />
            <Stat label="Installed power" value={P(units.installedKW || 0)} unit={u.p} />
            <Stat label="Deliverable at the meter" value={E(units.deliverableKWh || 0)} unit={u.e}
              tone={units.deliverableKWh >= st.usableKWh ? "#4fb06a" : "#d67070"} />
            <Stat label="Against the requirement" value={E(st.usableKWh)} unit={u.e} />
          </div>
          <div className="readout">
            Rounding up to whole units leaves <b>{E(Math.max(0, (units.deliverableKWh || 0) - st.usableKWh))} {u.e}</b>
            {" "}of deliverable energy and <b>{P(Math.max(0, units.spareKW || 0))} {u.p}</b> of power above what
            was asked for. That spare is real and worth declaring — it is headroom against
            degradation in the early years, and in a tender it is a number the client may value.
          </div>
        </Section>
      </>) : (<>
        <Section code="B2" title="The load">
          <Num label={`Annual consumption (${u.e})`} value={st.annualLoadKWh / u.ke} step={u.ke === 1 ? 100 : 1}
            onChange={(v) => set({ ...st, annualLoadKWh: v * u.ke })} />
          <Sel label="Daily shape" value={st.shape} onChange={(v) => set({ ...st, shape: v })}
            options={LOAD_SHAPES} />
          <Num label="Weekend load, relative to a weekday" value={st.weekendFactor} step={0.05} min={0}
            onChange={(v) => set({ ...st, weekendFactor: v })} />
          <Num label="Seasonal swing" unit="±%" value={st.seasonalAmp} step={5} min={0}
            onChange={(v) => set({ ...st, seasonalAmp: v })} />
          <Sel label="Season of peak demand" value={st.seasonalPeak}
            onChange={(v) => set({ ...st, seasonalPeak: v })}
            options={[{ value: "winter", label: "Winter — heating-led" },
              { value: "summer", label: "Summer — cooling-led" }]} />
          <Working n="B1" title="Average daily consumption"
            formula="E_day = E_year / 365"
            sub={`${E(st.annualLoadKWh)} ${u.e} / 365`}
            result={E(dailyLoad)} unit={u.e}
            why="The single most useful number for a first guess at battery size, because a battery covering one evening is a fraction of a day and one covering a full day of autonomy is the whole of it. It is the basis the sweep range below is built on." />
          <div className="readout">
            <b>These shapes are stylised, not measured.</b> They are built to be defensible
            starting points — the residential one has the morning and evening peaks that make the
            duck curve, the commercial one is the daytime plateau that matches PV best, the
            industrial one is nearly flat. A real half-hourly meter file beats all of them, and
            the difference is not small: which season the peak falls in decides whether PV and
            load agree at all. Treat what follows as the shape of the answer, not the answer.
          </div>
        </Section>

        <Section code="B3" title="The array">
          <Num label="Array size (kWp)" value={st.kWp} step={0.5} min={0}
            onChange={(v) => set({ ...st, kWp: v })} />
          <Num label="Specific yield" unit="kWh/kWp/yr" value={st.specificYield} step={10} min={1}
            onChange={(v) => set({ ...st, specificYield: v })} />
          <Working n="B2" title="Expected annual generation"
            formula="E_pv = kWp × specific yield"
            sub={`${fmt(st.kWp, 1)} kWp × ${fmt(st.specificYield, 0)} kWh/kWp`}
            result={E(st.kWp * st.specificYield)} unit={u.e}
            why="The total the hourly profile is scaled to. Its accuracy sets the accuracy of everything below it, which is why taking the specific yield from the Yield report rather than a rule of thumb is worth the trip." />
          {synthetic ? (
            <div className="warn" style={{ width: "100%" }}>
              &#9888; <b>No TMY loaded, so the hourly shape is a clear-sky model.</b> The daily
              and seasonal shape is right and the dispatch is sensitive to shape, so the
              self-sufficiency figures are usable for comparing battery sizes. The absolute runs
              high, because a clear-sky year has no clouds in it. Pull TMY on the Yield report
              tab and this becomes a real year.
            </div>
          ) : (
            <div className="readout" style={{ border: `1px solid #4fb06a` }}>
              <b>Running on PVGIS TMY.</b> The hour-to-hour shape is a real typical
              meteorological year, scaled to the annual generation above.
            </div>
          )}
          <Working n="B3" title="Generation against consumption"
            formula="ratio = E_pv / E_load"
            sub={`${E(st.kWp * st.specificYield)} / ${E(st.annualLoadKWh)}`}
            result={fmt(st.annualLoadKWh > 0 ? (st.kWp * st.specificYield) / st.annualLoadKWh : 0, 2)} unit="×"
            why="A ratio near 1 does not mean the load is covered — it means the annual totals match, which they can do while every kilowatt-hour arrives at the wrong time of day. The gap between this ratio and the self-sufficiency below is exactly what the battery is being bought to close." />
        </Section>

        <Section code="B4" title="The battery, and what a year does to it">
          <Num label={`Battery nameplate (${u.e})`} value={st.battKWh / u.ke} step={u.ke === 1 ? 0.5 : 0.5}
            onChange={(v) => set({ ...st, battKWh: v * u.ke })} />
          <Num label={`Battery power (${u.p})`} value={st.battKW / u.kp} step={u.kp === 1 ? 0.5 : 0.1}
            onChange={(v) => set({ ...st, battKW: v * u.kp })} />
          <Num label="Round-trip efficiency" unit="%" value={st.rte} step={0.5} min={1}
            onChange={(v) => set({ ...st, rte: v })} />
          <Num label="Usable depth of discharge" unit="%" value={st.dod} step={1} min={1}
            onChange={(v) => set({ ...st, dod: v })} />
          <Sel label="Grid connection" value={st.hasGrid ? "grid" : "island"}
            onChange={(v) => set({ ...st, hasGrid: v === "grid" })}
            options={[{ value: "grid", label: "Grid connected — shortfall is imported" },
              { value: "island", label: "Off grid — shortfall is unmet load" }]} />
          <Num label={`Export limit (${u.p}, 0 = none)`} value={st.exportLimit / u.kp} step={0.5} min={0}
            onChange={(v) => set({ ...st, exportLimit: v * u.kp })} />

          <div style={{ display: "flex", gap: 9, flexWrap: "wrap", width: "100%", marginTop: 4 }}>
            <Stat label="Self-sufficiency" value={fmt(sim.selfSufficiencyPct, 1)} unit="%" tone="#4fb06a" />
            <Stat label="Self-consumption" value={fmt(sim.selfConsumptionPct, 1)} unit="%" tone="#e8820c" />
            {st.hasGrid
              ? <Stat label="Imported" value={E(sim.imported)} unit={u.e} tone="#3a96e0" />
              : <Stat label="Unmet load" value={E(sim.unmet)} unit={u.e}
                  tone={sim.unmet > 0 ? "#d67070" : "#4fb06a"} />}
            <Stat label="Full cycles a year" value={fmt(sim.cycles, 0)} unit="eq" />
            <Stat label="Exported" value={E(sim.exported)} unit={u.e} />
            <Stat label="Curtailed" value={E(sim.curtailed)} unit={u.e}
              tone={sim.curtailed > 0 ? "#e0a63a" : undefined} />
          </div>

          <Working n="B4" title="Self-sufficiency"
            formula="(PV direct to load + from battery) / total load"
            sub={`(${E(sim.direct)} + ${E(sim.discharged)}) / ${E(sim.loadTotal)}`}
            result={fmt(sim.selfSufficiencyPct, 1)} unit="%"
            why="The share of consumption covered without the grid. The number an off-grid or resilience project lives or dies by. Note that PV going straight to the load is counted separately from PV via the battery — the direct share suffers no round-trip loss and is almost always the larger benefit, which is worth seeing rather than burying in a total." />
          <Working n="B5" title="Self-consumption"
            formula="(PV direct to load + PV into battery) / PV generated"
            sub={`(${E(sim.direct)} + ${E(sim.charged)}) / ${E(sim.pvTotal)}`}
            result={fmt(sim.selfConsumptionPct, 1)} unit="%"
            why="The share of generation kept on site rather than exported or thrown away. Where export earns little, this is the number that pays for the battery; where export is paid near the retail rate, it barely matters." />
          <Working n="B6" title="Equivalent full cycles"
            formula="cycles = discharge throughput / usable capacity"
            sub={`${E(sim.discharged)} / ${E(sim.usableKWh)}`}
            result={fmt(sim.cycles, 0)} unit="per year"
            status={sim.cycles > 400 ? "Heavy" : "OK"}
            why="Warranties are written in cycles, so this is what decides whether the battery lasts its design life. A domestic self-consumption battery lands around 250 to 350 — roughly one cycle a day with winter days contributing little. Much above 400 and the duty is harder than a self-consumption profile implies, and the warranty should be read carefully." />
          {sim.roundTripLossKWh > 0 && (
            <div className="readout">
              Round-trip losses cost <b>{E(sim.roundTripLossKWh)} {u.e}</b> over the year, which is
              {" "}{fmt(sim.charged > 0 ? (sim.roundTripLossKWh / sim.charged) * 100 : 0, 1)}% of everything
              that went into the battery. That is the price of time-shifting, and it is why PV going
              straight to the load is worth more than the same energy taken from the battery an hour later.
            </div>
          )}
        </Section>

        <Section code="B5" title="Where the energy went">
          <Chart title="Load met, by month" subtitle="How the load was covered, month by month"
            legend={[["#e8820c", "PV straight to load"], ["#4fb06a", "from the battery"],
              ["#3a96e0", "imported"], ["#d67070", "unmet"]]}>
            <ChartMonthly d={sim} u={u} />
          </Chart>
          <div className="readout">
            The shape of this chart is the whole argument. A battery shifts energy by hours, not
            by months, so a site whose summer surplus and winter deficit are the real problem
            cannot be fixed by a bigger battery — the bars will keep their shape however much
            storage is added. That is a seasonal mismatch and it needs a bigger array, a
            different tariff, or the grid.
          </div>
          <Num label="Week to show (0 = first week of January)" value={week} step={1} min={0} max={51}
            onChange={(v) => setWeek(Math.max(0, Math.min(51, Math.round(v))))} />
          <Chart title={`One week, hour by hour — week ${week + 1}`}
            subtitle="Generation, consumption and state of charge. Dashed lines are midnight."
            legend={[["#e8820c", `PV, ${u.p}`], ["#3a96e0", `load, ${u.p}`], ["#8c6fd0", "state of charge, %"]]}>
            <ChartWeek d={sim} pv={pv} load={load} startHour={week * 168} u={u} />
          </Chart>
          <div className="readout">
            A week is where dispatch becomes legible. A healthy self-consumption battery fills
            through the middle of the day, empties through the evening and sits near the bottom
            overnight. A bank that never reaches the top is too big for the surplus, or the
            charging power is the constraint; one that never reaches the bottom is too big for
            the evening load. Try a summer week and a winter week — they rarely look alike.
          </div>
        </Section>

        <Section code="B6" title="How big is worth buying">
          <Num label="Knee threshold" unit="% of the first increment's gain" value={st.kneeFraction}
            step={5} min={1} onChange={(v) => set({ ...st, kneeFraction: v })} />
          <Chart title="Self-sufficiency against battery size"
            subtitle={`Swept from a fraction of a day to two days of autonomy, at ${P(st.battKW)} ${u.p}`}>
            <ChartSweep s={sweep} u={u} />
          </Chart>
          {sweep.knee ? (
            <div className="readout" style={{ border: `1px solid #4fb06a` }}>
              <b>The curve flattens at about {E(sweep.knee.nameplateKWh)} {u.e}</b>, which reaches
              {" "}{fmt(sweep.knee.selfSufficiencyPct, 1)}% self-sufficiency at
              {" "}{fmt(sweep.knee.cycles, 0)} equivalent cycles a year.
              {!sweep.bracketed && <> <b>But the curve is still climbing at the largest size swept</b>,
                so this is the edge of the range rather than a genuine knee — the honest answer is
                to sweep further, not to call the edge an optimum.</>}
            </div>
          ) : (
            <div className="warn" style={{ width: "100%" }}>
              &#9888; No knee could be identified over this range — the curve has not turned over
              at all. Either the battery is far too small to matter at any size swept, or the load
              and generation never overlap enough for storage to help.
            </div>
          )}
          <div className="readout">
            <b>Reporting the best size would be useless advice, because the best size is always
            the largest one offered.</b> Self-sufficiency against battery size saturates: the
            first kilowatt-hours displace the evening peak every single day and earn their keep,
            and later ones sit idle most of the year waiting for the few days that need them.
            What matters is where the curve flattens, and "flattens" is defined here rather than
            eyeballed — the knee is the last size whose marginal gain is still at least
            {" "}{fmt(st.kneeFraction, 0)}% of what the first increment delivered. That fraction is
            a judgement, which is why it is an input you can argue with.
          </div>
          <div style={{ width: "100%", overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 620 }}>
              <thead><tr>
                {[`Size ${u.e}`, "Self-sufficiency", "Self-consumption", "Cycles/yr",
                  `Marginal %/${u.e}`, st.hasGrid ? `Imported ${u.e}` : `Unmet ${u.e}`].map((x) => (
                  <th key={x} style={{ padding: "5px 9px", borderBottom: `1px solid ${C.line}`,
                    textAlign: "right", font: "600 9.5px system-ui", textTransform: "uppercase",
                    letterSpacing: "0.06em", color: C.muted, whiteSpace: "nowrap" }}>{x}</th>
                ))}
              </tr></thead>
              <tbody>
                {sweep.rows.map((r, i) => {
                  const isKnee = sweep.knee && r.nameplateKWh === sweep.knee.nameplateKWh;
                  return (
                    <tr key={i} style={{ borderTop: `1px solid ${C.line}`,
                      background: isKnee ? "rgba(79,176,106,0.14)" : "transparent" }}>
                      {[E(r.nameplateKWh), `${fmt(r.selfSufficiencyPct, 1)}%`,
                        `${fmt(r.selfConsumptionPct, 1)}%`, fmt(r.cycles, 0),
                        r.marginalPerKWh === null ? "—" : fmt(r.marginalPerKWh * u.ke, 3),
                        E(st.hasGrid ? r.importedKWh : (r.unmetPct / 100) * sim.loadTotal)].map((v, j) => (
                        <td key={j} style={{ padding: "4px 9px", font: "12px var(--mono)",
                          textAlign: "right", color: isKnee ? "#8fd6a3" : C.text,
                          fontWeight: isKnee ? 700 : 400 }}>{v}</td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>
      </>)}

      <Section code="B7" title="How this is calculated, start to finish">
        <div className="readout" style={{ font: "11.5px/1.75 system-ui" }}>
          <p style={{ margin: "0 0 10px" }}>
            Everything above can be reproduced with a calculator. This is the whole chain in
            order, with this project&#39;s own numbers in it, because a figure you cannot check by
            hand is a figure you cannot defend in a review.
          </p>

          <p style={{ margin: "0 0 6px" }}><b>1 · The two questions are different.</b></p>
          <p style={{ margin: "0 0 10px" }}>
            A capacity requirement — 35 MW for 5 hours — is arithmetic. How big a battery is
            worth buying is a simulation. The first has one right answer; the second depends
            entirely on when the sun shines against when the load runs, and two sites with
            identical annual totals can need very different batteries. Nothing in the first pane
            uses weather, and nothing in the second pane is a substitute for a tender spec.
          </p>

          <p style={{ margin: "0 0 6px" }}><b>2 · Nameplate is not what you get.</b></p>
          <p style={{ margin: "0 0 10px" }}>
            Four things stand between the cells and the meter, and they multiply:
            {" "}<code style={{ font: "11px var(--mono)", color: C.accent }}>
              E_nameplate = E_usable / (DoD × √RTE × (1 − aux) × retention)
            </code>.
            Depth of discharge because a cell is not emptied to zero. The square root of
            round-trip efficiency because the round trip covers a charge and a discharge, and only
            the discharge half stands between stored energy and the meter — the even split is the
            usual convention, and a supplier quoting a one-way figure should have it entered as
            RTE² or the loss lands twice. Auxiliary load because HVAC, controls and fire
            suppression draw on the same connection. Retention only if you are sizing day one for
            year twenty-five, which costs about a third more plant than holding capacity by
            augmenting later.
            {st.basis === "requirement" && <>
              {" "}Here: {E(st.usableKWh)} / ({fmt(chain.dod, 3)} × {fmt(chain.etaDischarge, 4)} ×
              {" "}{fmt(chain.aux, 3)} × {fmt(chain.retention, 3)}) = <b>{E(chain.nameplateKWh)} {u.e}</b>.
            </>}
          </p>

          <p style={{ margin: "0 0 6px" }}><b>3 · Units round up, and the larger one wins.</b></p>
          <p style={{ margin: "0 0 10px" }}>
            Power needs <code style={{ font: "11px var(--mono)" }}>CEILING(S × cos φ / P_unit)</code>,
            energy needs <code style={{ font: "11px var(--mono)" }}>CEILING(E_nameplate / E_unit)</code>,
            and you buy the larger. Which one binds is as useful as the count: energy-driven means
            the power came free and a cheaper conversion stage may suit; power-driven means the
            duration is longer than asked for.
            {st.basis === "requirement" && units.units && <>
              {" "}Here: power needs {units.forPower}, energy needs {units.forEnergy}, so
              {" "}<b>{units.units} units</b>, {units.governedBy}-driven, delivering
              {" "}{E(units.deliverableKWh)} {u.e} against the {E(st.usableKWh)} {u.e} asked for.
            </>}
          </p>

          <p style={{ margin: "0 0 6px" }}><b>4 · The simulation is a loop over 8,760 hours.</b></p>
          <p style={{ margin: "0 0 10px" }}>
            Each hour, in this order. PV serves the load directly — this energy never enters the
            battery, so it suffers no round-trip loss, and it is usually the largest single
            benefit. Surplus charges the battery, limited by the inverter&#39;s power and by the
            headroom left in the bank. Surplus beyond that is exported up to the export limit and
            curtailed after that. A deficit is covered from the battery, limited by power and by
            what is actually in it. Whatever is still short is imported, or, with no grid,
            recorded as unmet load. Energy in and out of the bank is multiplied by √RTE each way,
            the same convention the nameplate chain uses, so the two halves of the tool agree.
          </p>

          <p style={{ margin: "0 0 6px" }}><b>5 · State of charge is tracked in usable energy.</b></p>
          <p style={{ margin: "0 0 10px" }}>
            The bank is &ldquo;empty&rdquo; at the bottom of its permitted window, not at zero
            cells, so usable capacity is nameplate × DoD and the percentage on the week chart is a
            percentage of that window. Equivalent full cycles are discharge throughput divided by
            that same usable capacity, which is how warranties are written.
          </p>

          <p style={{ margin: "0 0 6px" }}><b>6 · The knee, not the maximum.</b></p>
          <p style={{ margin: 0 }}>
            Self-sufficiency against battery size saturates, so the largest size swept always
            scores highest and reporting it would be useless advice. The knee is defined as the
            last size whose marginal gain per {u.e} is still at least {fmt(st.kneeFraction, 0)}% of
            what the first increment delivered. That fraction is a judgement rather than a
            standard, which is why it is an input. If the curve is still climbing at the top of
            the range the tool says the knee is not bracketed and asks for a wider sweep, rather
            than presenting the edge of the range as an optimum.
          </p>
        </div>
      </Section>
    </Page>
  );
}
