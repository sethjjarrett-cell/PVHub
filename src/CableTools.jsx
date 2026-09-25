/* =====================================================================
   CABLE SIZING  —  DC string/array, AC inverter-to-transformer, MV
   collector — and short-circuit withstand.

   Three questions get asked of every cable, and the tools answer them in
   that order because they bind in that order:

     1. Will it carry the current without cooking?  (ampacity, derated)
     2. Will the volt drop and I²R loss be acceptable?  (regulation)
     3. Will it survive the fault before the protection clears?
        (adiabatic withstand)

   A cable that passes 1 and 2 and fails 3 is the dangerous case, because
   nothing about normal operation reveals it. That is why the withstand
   check is a tool of its own rather than a footnote.

   Derating is never a single number. It is a product of four factors —
   ambient temperature, grouping, soil resistivity and burial depth —
   and each is shown separately so a failing run can be traced to the
   one that actually cost the capacity, which is nearly always grouping.
   ===================================================================== */

import React, { useState, useMemo } from "react";
import { fmt, C, Num, Sel, Section, Page, Working } from "./ui.jsx";
import {
  RefCard, Table1D, TableGroup, TableCCC, FactorChain, HighlightKey, HL,
} from "./CableRefTables.jsx";
import {
  interp, interpBracket, groupFactorBracket, groupFactor, rowFor, ratingFor, derateLV,
  applyOverride,
  recommendSize, shortfall, trenchPlan, circuitWidthMm,
  LV_DUCT_SPACING_M, LV_DIRECT_SPACING_M, MV_SPACING_CENTRE_M,
  DC_CCC, DC_R20, AC_CCC, AL_R20, AL_X_TREFOIL,
  LV_TEMP_AIR, LV_TEMP_GROUND, LV_GROUP_AIR, LV_GROUP_DUCT, LV_GROUP_DIRECT,
  LV_DUCT_SPACINGS, LV_DIRECT_SPACINGS, LV_SOIL_DUCT, LV_SOIL_DIRECT,
  DEPTH_DIRECT_LE185, DEPTH_DIRECT_GT185, DEPTH_DUCT_LE185, DEPTH_DUCT_GT185,
  mvTable, MV_TEMP_GROUND, MV_SOIL_DIRECT, MV_SOIL_DUCT,
  MV_GROUP_DIRECT, MV_GROUP_DUCT, MV_SPACINGS,
  CONDUCTOR, INSULATION, materialK, adiabaticK, peakFactor, dcHeatFactor,
} from "./cableData.js";

/* ---------------------------------------------------------------
   Temperature correction of conductor resistance.
   IEC 60228 tabulates R at 20 °C. A conductor at its 90 °C limit is
   27 % more resistive than the table says, and volt drop computed on
   the 20 °C figure is optimistic by exactly that much.
   --------------------------------------------------------------- */
const ALPHA = { copper: 0.00393, aluminium: 0.00403 };
const rAtTemp = (r20, theta, mat) => r20 * (1 + ALPHA[mat] * (theta - 20));

const INSTALLS = [
  { value: "air", label: "In air / on tray" },
  { value: "duct", label: "Buried duct" },
  { value: "ground", label: "Direct buried" },
];

/* ---------------------------------------------------------------
   The derating engine, shared by the DC and AC tools.

   Grouping counts circuits, not cables. IEC 60364-5-52 Tables B.52.18
   and B.52.19 NOTE 3: a circuit with m conductors per phase in parallel
   counts as m circuits. So a run of four cables per pole in a trench
   with five other runs is 4 × 6 = 24 circuits for the lookup, not six.
   Getting this wrong is the single most common way a trench design ends
   up thermally undersized.
   --------------------------------------------------------------- */

/* ---------------------------------------------------------------
   Trench cross-section. Drawn from the same inputs the grouping factor
   is looked up with, so a wrong circuit count or spacing is visible
   rather than buried in a cell.
   --------------------------------------------------------------- */
function TrenchDiagram({ install, circuits, spacingLabel, depth, parallel, own, aux, total, trenches }) {
  const W = 460, H = 210;
  const nT = Math.max(1, Math.min(4, Math.round(trenches || 1)));
  const n = Math.max(1, Math.min(10, Math.round(circuits || 1)));
  const groundY = 46;
  const cableY = groundY + Math.min(110, Math.max(34, (depth || 0.8) * 58));
  // Each trench gets its own slice of the drawing, with a gap between
  // them, because the whole point of splitting is that they are far
  // enough apart not to heat one another.
  const slice = (W - 24) / nT;
  const pitch = Math.min(34, (slice - 40) / Math.max(1, n));
  const rad = Math.max(4, Math.min(8, pitch * 0.32));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", maxWidth: 500 }}>
      <defs>
        <pattern id="soilhatch" width="7" height="7" patternTransform="rotate(45)"
          patternUnits="userSpaceOnUse">
          <line x1="0" y1="0" x2="0" y2="7" stroke={C.soilLine} strokeWidth="1" />
        </pattern>
      </defs>
      {install === "air" ? (
        <>
          <rect x="0" y="0" width={W} height={H} fill={C.paper} />
          <text x="14" y="26" fill={C.muted} style={{ font: "10px system-ui" }}>
            Cable tray or free air, {n} circuit{n > 1 ? "s" : ""} bunched and touching
          </text>
          <rect x={W / 2 - (n - 1) * pitch / 2 - 26} y={cableY + 14}
            width={(n - 1) * pitch + 52} height="7" fill={C.steel} opacity="0.7" />
          {Array.from({ length: n }, (_, i) => {
            const cx = W / 2 - ((n - 1) * pitch) / 2 + i * pitch;
            return (
              <g key={i}>
                <circle cx={cx} cy={cableY} r={rad} fill={C.navy} stroke={C.navyLight} strokeWidth="1.2" />
                <circle cx={cx} cy={cableY} r={rad * 0.45} fill={C.accent} opacity="0.85" />
              </g>
            );
          })}
        </>
      ) : (
        <>
          <rect x="0" y="0" width={W} height={groundY} fill={C.paper} />
          <rect x="0" y={groundY} width={W} height={H - groundY} fill={C.soil} />
          <rect x="0" y={groundY} width={W} height={H - groundY} fill="url(#soilhatch)" opacity="0.5" />
          <line x1="0" y1={groundY} x2={W} y2={groundY} stroke={C.soilLine} strokeWidth="1.5" />
          <text x="14" y="26" fill={C.muted} style={{ font: "10px system-ui" }}>
            {install === "duct" ? "Cables in buried ducts" : "Direct buried"}
            {" · "}{nT} trench{nT > 1 ? "es" : ""} of {n} circuit{n > 1 ? "s" : ""}
            {nT > 1 ? ` (${total} in total)` : ""}{" · "}{spacingLabel}
          </text>
          <line x1="14" y1={groundY} x2="14" y2={cableY} stroke={C.navyLight} strokeWidth="1" />
          <line x1="9" y1={groundY} x2="19" y2={groundY} stroke={C.navyLight} strokeWidth="1" />
          <line x1="9" y1={cableY} x2="19" y2={cableY} stroke={C.navyLight} strokeWidth="1" />
          <text x="22" y={(groundY + cableY) / 2 + 3} fill={C.navyLight}
            style={{ font: "10px var(--mono)" }}>{fmt(depth, 2)} m</text>
          {Array.from({ length: nT }, (_, t) => {
            const x0 = 12 + t * slice + (slice - (n - 1) * pitch) / 2;
            return (
              <g key={t}>
                {Array.from({ length: n }, (_, i) => {
                  const cx = x0 + i * pitch;
                  return (
                    <g key={i}>
                      {install === "duct" && (
                        <circle cx={cx} cy={cableY} r={rad + 4} fill="none"
                          stroke={C.steel} strokeWidth="1.4" strokeDasharray="3 2" />
                      )}
                      <circle cx={cx} cy={cableY} r={rad} fill={C.navy} stroke={C.navyLight} strokeWidth="1.1" />
                      <circle cx={cx} cy={cableY} r={rad * 0.45} fill={C.accent} opacity="0.85" />
                    </g>
                  );
                })}
                <text x={x0 + ((n - 1) * pitch) / 2} y={cableY + 34} textAnchor="middle"
                  fill={C.navyLight} style={{ font: "10px var(--mono)" }}>
                  trench {t + 1}
                </text>
              </g>
            );
          })}
        </>
      )}
      <text x={W - 12} y={H - 9} textAnchor="end" fill={C.muted} style={{ font: "10px var(--mono)" }}>
        {own} own ({parallel}{"×"} parallel){aux ? ` + ${aux} aux` : ""}
        {nT > 1 ? ` = ${total}, ${n} per trench` : ` = ${total ?? own + aux}`}
      </text>
    </svg>
  );
}


/* Utilisation bar — green to 80 %, amber to 100 %, red beyond. */
function UtilBar({ pct }) {
  const col = pct > 100 ? "#d67070" : pct > 80 ? C.warn : "#59b56f";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 130 }}>
      <div style={{ flex: 1, height: 7, background: C.panel2, borderRadius: 4, overflow: "hidden" }}>
        <div style={{ width: `${Math.min(100, pct)}%`, height: "100%", background: col }} />
      </div>
      <span style={{ font: "600 11.5px var(--mono)", color: col, minWidth: 44, textAlign: "right" }}>
        {Number.isFinite(pct) ? `${fmt(pct, 0)}%` : "—"}
      </span>
    </div>
  );
}

const Verdict = ({ pass, failText = "FAIL" }) => (
  <span className={`wk-status ${pass ? "ok" : "bad"}`}>{pass ? "PASS" : failText}</span>
);

/* Shared table chrome, so the three sizing tables read alike. */
const Th = ({ children, w }) => (
  <th style={{
    padding: "6px 9px", borderBottom: `1px solid ${C.line}`, textAlign: "left",
    font: "600 9.5px system-ui", textTransform: "uppercase", letterSpacing: "0.07em",
    color: C.muted, whiteSpace: "nowrap", width: w,
  }}>{children}</th>
);
const Td = ({ children, dim, style }) => (
  <td style={{ padding: "5px 9px", font: "12px var(--mono)", color: dim ? C.muted : C.text,
    whiteSpace: "nowrap", ...style }}>{children}</td>
);
const Scroll = ({ children, min = 900 }) => (
  <div style={{ overflowX: "auto", width: "100%", WebkitOverflowScrolling: "touch" }}>
    <div style={{ minWidth: min }}>{children}</div>
  </div>
);

/* A small inline size/number picker used inside the sizing tables. */
function CellNum({ value, onChange, step = 1, min = 0, w = 66 }) {
  return (
    <input type="number" value={value} step={step} min={min}
      onChange={(e) => { const v = Number(e.target.value); if (!Number.isNaN(v)) onChange(v); }}
      style={{ width: w, background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 4,
        color: C.text, font: "12px var(--mono)", padding: "4px 6px", outline: "none" }} />
  );
}
function CellSel({ value, onChange, options, w = 110 }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      style={{ width: w, background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 4,
        color: C.text, font: "12px var(--mono)", padding: "4px 6px", outline: "none" }}>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

/* =====================================================================
   Imported-value row: linked figure from another tool, with an override.
   Mirrors the workbook's discipline of importing once, visibly, so a
   number can always be traced back to where it was entered.
   ===================================================================== */
function Imported({ label, source, linked, override, onOverride, unit, dp = 2 }) {
  const inUse = override === null || override === undefined || override === "" ? linked : override;
  return (
    <tr>
      <Td>{label}</Td>
      <Td dim style={{ font: "11px system-ui" }}>{source}</Td>
      <Td dim>{Number.isFinite(linked) ? fmt(linked, dp) : "—"}</Td>
      <Td>
        <input type="number" value={override ?? ""} placeholder="—"
          onChange={(e) => onOverride(e.target.value === "" ? null : Number(e.target.value))}
          style={{ width: 78, background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 4,
            color: C.accent, font: "12px var(--mono)", padding: "4px 6px", outline: "none" }} />
      </Td>
      <Td style={{ color: C.accent, fontWeight: 600 }}>
        {Number.isFinite(inUse) ? fmt(inUse, dp) : "—"} <span style={{ color: C.muted }}>{unit}</span>
      </Td>
    </tr>
  );
}
const ImportedHead = () => (
  <thead><tr>
    <Th>Imported value</Th><Th>Source</Th><Th>Linked</Th><Th>Override</Th><Th>In use</Th>
  </tr></thead>
);

/* =====================================================================
   1.  DC — string and array cable
   ===================================================================== */
/* =====================================================================
   The LV sizing section, shared by the DC and AC tabs.

   One installation method is in focus at a time, because a derating
   chain is only legible for one method at once. The other two stay in a
   comparison strip, so nothing is hidden, and the reference tables
   underneath highlight whatever the focused method just read.
   ===================================================================== */

/**
 * One factor: automatic by default, with a dropdown to take it over.
 *
 * The dropdown is the whole control. "Auto" means the IEC table decides
 * and there is nothing else on screen; "Enter a value" reveals a box. An
 * empty box that silently means automatic is the kind of thing that gets
 * misread at four in the afternoon, so the state is always spelled out.
 */
function AutoField({ label, auto, value, onChange, dp = 3, unit = "", hint, disabled }) {
  const manual = value !== null && value !== undefined && value !== "";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 130,
      opacity: disabled ? 0.45 : 1 }}>
      <span style={{ font: "10px system-ui", color: C.muted, letterSpacing: "0.03em" }}>
        {label}{unit ? ` ${unit}` : ""}
      </span>
      <select disabled={disabled} value={manual ? "manual" : "auto"}
        onChange={(e) => onChange(e.target.value === "auto"
          ? null
          : (Number.isFinite(auto) ? Number(fmt(auto, dp).replace(/,/g, "")) : 1))}
        style={{ background: C.panel2,
          border: `1px solid ${manual ? HL.manual.line : C.line}`, borderRadius: 4,
          color: manual ? HL.manual.text : C.text, font: "11px system-ui",
          padding: "4px 5px", outline: "none" }}>
        <option value="auto">Auto{Number.isFinite(auto) ? ` — ${fmt(auto, dp)}` : ""}</option>
        <option value="manual">Enter a value</option>
      </select>
      {manual && (
        <input type="number" autoFocus value={value}
          onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
          style={{ width: "100%", background: C.panel2, border: `1px solid ${HL.manual.line}`,
            borderRadius: 4, color: HL.manual.text, font: "12px var(--mono)",
            padding: "4px 6px", outline: "none" }} />
      )}
      <span style={{ font: "9.5px system-ui", color: manual ? HL.manual.text : C.muted }}>
        {manual
          ? `instead of ${Number.isFinite(auto) ? fmt(auto, dp) : "no table value"}`
          : hint || (Number.isFinite(auto) ? "from the table" : "not tabulated")}
      </span>
    </div>
  );
}

const METHODS = [
  { value: "air", label: "In air / tray" },
  { value: "duct", label: "Buried duct" },
  { value: "ground", label: "Direct buried" },
];

function spacingOptionsFor(install) {
  return install === "duct" ? LV_DUCT_SPACINGS
    : install === "ground" ? LV_DIRECT_SPACINGS
      : [{ value: "touching", label: "touching" }];
}

/** Everything about one installation method at one size. */
function evaluateRow(row, install, st, table, kind, designCurrent) {
  const own = row.circ * row.par;
  const spacings = install === "duct" ? LV_DUCT_SPACING_M
    : install === "ground" ? LV_DIRECT_SPACING_M : { touching: 0 };
  const widthM = (st.odOverride > 0 ? st.odOverride : circuitWidthMm(kind, row.size)) / 1000;
  const plan = trenchPlan({
    ownCircuits: own, auxCircuits: row.aux,
    /* Trenching is opt-in. With it off the whole run is one group, which
       is the conservative reading and the one most runs actually get. */
    trenches: install === "air" || !st.multiTrench ? 1 : st.trenches,
    clearSpacingM: spacings[row.spacing] ?? 0,
    circuitWidthM: widthM, maxWidthM: st.maxTrenchW,
  });
  const params = {
    table, install, tAir: st.tAir, tGnd: st.tGnd, soil: st.soil, depth: st.depth,
    circuits: plan.perTrench, spacing: row.spacing, safetyPct: st.safetyPct,
    ov: row.ov || {},
  };
  const chain = derateLV({ ...params, size: row.size });
  const perCable = row.par > 0 ? designCurrent / row.par : null;
  const short = chain.derated !== null && perCable !== null && perCable > chain.derated
    ? shortfall(perCable, chain.derated) : null;
  const rec = short ? recommendSize(params, designCurrent, row.par) : null;
  return { own, plan, chain, perCable, short, rec, widthM, params };
}

/* =====================================================================
   One installation method, shown in full.

   All three are on screen at once, because the question an engineer
   actually asks is "which of these works", and answering it by flipping
   a selector three times and remembering the numbers is worse than
   printing them. Each card carries its own size, its own arithmetic and
   its own verdict, so the three can be compared by eye.
   ===================================================================== */
function MethodCard({ method, kind, table, st, set, designCurrent, open, onToggle }) {
  const focus = method.value;
  const row = st.rows[focus];
  const buried = focus !== "air";
  const upd = (patch) => set({ ...st, rows: { ...st.rows, [focus]: { ...row, ...patch } } });
  const ovOf = (k) => (row.ov || {})[k] ?? null;
  const setOv = (k, v) => upd({ ov: { ...(row.ov || {}), [k]: v } });

  const ev = evaluateRow(row, focus, st, table, kind, designCurrent);
  const { plan, chain, perCable, short, rec } = ev;
  const spacingOpts = spacingOptionsFor(focus);

  /* Splitting the run lifts the grouping factor, because each trench is
     its own thermal group. Only worth offering once trenching is on. */
  let trenchFix = null;
  if (short && buried && st.multiTrench) {
    for (let t = st.trenches + 1; t <= st.trenches + 12; t++) {
      const e = evaluateRow(row, focus, { ...st, trenches: t }, table, kind, designCurrent);
      if (e.chain.derated !== null && e.perCable <= e.chain.derated) {
        trenchFix = { trenches: t, derated: e.chain.derated, perTrench: e.plan.perTrench,
          fGroup: e.chain.fGroup.value, widthM: e.plan.widthM };
        break;
      }
    }
  }

  const pass = chain.derated !== null && !short;
  const util = chain.derated ? (perCable / chain.derated) * 100 : NaN;
  const edge = chain.derated === null ? "#d67070" : pass ? HL.used.line : "#d67070";

  return (
    <div style={{ width: "100%", border: `1px solid ${edge}`, borderRadius: 7,
      background: C.panel, marginBottom: 10, overflow: "hidden" }}>

      {/* Header: the answer, before any of the working. */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
        padding: "9px 12px", background: pass ? HL.used.bg : "rgba(214,112,112,0.10)" }}>
        <b style={{ font: "600 13px system-ui", color: C.text, minWidth: 108 }}>{method.label}</b>
        <select value={String(row.size)} onChange={(e) => upd({ size: Number(e.target.value) })}
          style={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 4,
            color: C.text, font: "12px var(--mono)", padding: "3px 6px", outline: "none" }}>
          {table.map((x) => <option key={x.size} value={String(x.size)}>{x.size} mm²</option>)}
        </select>
        <span style={{ font: "13px var(--mono)", color: C.text }}>
          {chain.derated === null ? "no rating" : `${fmt(chain.derated, 1)} A`}
          <span style={{ color: C.muted, font: "10.5px system-ui" }}> derated</span>
        </span>
        <span style={{ font: "13px var(--mono)", color: C.muted }}>
          vs {perCable === null ? "—" : fmt(perCable, 1)} A
          <span style={{ font: "10.5px system-ui" }}> needed</span>
        </span>
        <div style={{ flex: 1, minWidth: 90, maxWidth: 190 }}><UtilBar pct={util} /></div>
        {chain.derated === null
          ? <span className="wk-status bad">NO RATING</span>
          : short
            ? <span className="wk-status bad">{fmt(short.overPct, 0)}% OVER</span>
            : <span className="wk-status ok">PASS</span>}
        {chain.extrapolated && (
          <span style={{ font: "10px system-ui", color: HL.extrap.text }}>extrapolated rating</span>
        )}
        {chain.anyManual && (
          <span style={{ font: "10px system-ui", color: HL.manual.text }}>has entered values</span>
        )}
        <button className="btn" onClick={onToggle} style={{ padding: "3px 9px", font: "10px system-ui" }}>
          {open ? "▴ hide working" : "▾ show working"}
        </button>
      </div>

      {open && (
        <div style={{ padding: "10px 12px" }}>
          {/* The inputs that belong to this method alone. */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
            <Num label="Cables in parallel per pole" value={row.par} step={1} min={1}
              onChange={(v) => upd({ par: v })} />
            <Num label="Circuits routed together" value={row.circ} step={1} min={1}
              onChange={(v) => upd({ circ: v })} />
            <Num label="Other loaded circuits on the route" value={row.aux} step={1} min={0}
              onChange={(v) => upd({ aux: v })} />
            {buried && (
              <Sel label="Spacing between circuits" value={row.spacing}
                onChange={(v) => upd({ spacing: v })} options={spacingOpts} />
            )}
          </div>

          <FactorChain chain={chain} perCable={perCable ?? 0} />

          <div style={{ font: "10.5px system-ui", color: C.muted, margin: "7px 0 2px" }}>
            {plan.total} circuit{plan.total === 1 ? "" : "s"} in total ({row.circ} routed together
            {" × "}{row.par} in parallel{row.aux ? `, plus ${row.aux} other` : ""}), and the
            grouping factor is looked up on{" "}
            <b style={{ color: C.text }}>{plan.perTrench}</b>
            {plan.trenches > 1
              ? ` — ${plan.trenches} trenches, so each is its own thermal group.`
              : buried ? " — one trench, so they all share it." : " — bunched together."}
          </div>

          {/* Overrides, as dropdowns. Auto unless told otherwise. */}
          <div style={{ marginTop: 9, padding: "9px 11px", borderRadius: 6,
            background: C.panel2, border: `1px solid ${C.line}` }}>
            <div style={{ font: "600 10.5px system-ui", color: C.text, marginBottom: 7 }}>
              Override a factor — leave on Auto unless you have a reason
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <AutoField label="Base rating" unit="A" dp={0}
                auto={chain.baseAuto} value={ovOf("base")} onChange={(v) => setOv("base", v)}
                hint={chain.extrapolated ? "extrapolated, not IEC" : "from the table"} />
              <AutoField label="f_temp" auto={chain.fTemp.auto ?? chain.fTemp.value}
                value={ovOf("fTemp")} onChange={(v) => setOv("fTemp", v)} />
              <AutoField label="f_grp" auto={chain.fGroup.auto ?? chain.fGroup.value}
                value={ovOf("fGroup")} onChange={(v) => setOv("fGroup", v)} />
              <AutoField label="f_soil" disabled={!buried}
                auto={chain.fSoil.auto ?? chain.fSoil.value}
                value={ovOf("fSoil")} onChange={(v) => setOv("fSoil", v)}
                hint={buried ? undefined : "no soil in air"} />
              <AutoField label="f_depth" disabled={!buried}
                auto={chain.fDepth.auto ?? chain.fDepth.value}
                value={ovOf("fDepth")} onChange={(v) => setOv("fDepth", v)}
                hint={buried ? undefined : "not buried"} />
            </div>
            {chain.anyManual && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 9,
                font: "10.5px system-ui", color: HL.manual.text }}>
                <span>
                  This rating is no longer purely the standard&#8217;s. An entered number is yours
                  to defend, so record where it came from.
                </span>
                <button className="btn" style={{ padding: "3px 10px" }}
                  onClick={() => upd({ ov: {} })}>Reset to auto</button>
              </div>
            )}
          </div>

          {/* Verdict and the ways out of a failing one. */}
          <div style={{ marginTop: 9 }}>
            {chain.derated === null ? (
              <div className="warn" style={{ width: "100%" }}>
                &#9888; {chain.notes.join(" ") || "This combination cannot be rated."}
              </div>
            ) : short ? (
              <div className="warn" style={{ width: "100%" }}>
                &#9888; <b>Too small by {fmt(short.overA, 1)} A, which is {fmt(short.overPct, 0)}% over
                the derated rating</b> ({fmt(perCable, 1)} A against {fmt(chain.derated, 1)} A,
                {" "}{fmt(short.utilPct, 0)}% utilised). Ways out, and which is cheapest is a
                site question:
                <ul style={{ margin: "6px 0 0", paddingLeft: 18, lineHeight: 1.6 }}>
                  <li>
                    {rec?.found
                      ? <>Go up to <b>{rec.size} mm&#178;</b>, which derates to {fmt(rec.derated, 1)} A
                          and leaves {fmt(rec.headroomA, 1)} A spare at {fmt(rec.utilPct, 0)}% utilised
                          {rec.extrapolated ? <span style={{ color: HL.extrap.text }}> (extrapolated rating)</span> : null}.
                          <button className="btn" style={{ marginLeft: 8, padding: "2px 9px" }}
                            onClick={() => upd({ size: rec.size })}>Use {rec.size} mm&#178;</button></>
                      : <>No size in this table carries it at this grouping, even extrapolated.</>}
                  </li>
                  <li>
                    Run <b>{short.parallelNeeded}</b> cable{short.parallelNeeded === 1 ? "" : "s"} per
                    pole instead of {row.par}. That raises the circuit count for grouping, so it is
                    not a free halving.
                    <button className="btn" style={{ marginLeft: 8, padding: "2px 9px" }}
                      onClick={() => upd({ par: short.parallelNeeded })}>
                      Use {short.parallelNeeded} in parallel
                    </button>
                  </li>
                  {buried && (
                    <li>
                      {!st.multiTrench
                        ? <>Split the run across more than one trench. Each trench is its own
                            thermal group, so the grouping factor rises.
                            <button className="btn" style={{ marginLeft: 8, padding: "2px 9px" }}
                              onClick={() => set({ ...st, multiTrench: true })}>
                              Turn trenching on
                            </button></>
                        : trenchFix
                          ? <>Split across <b>{trenchFix.trenches} trenches</b>, which puts
                              {" "}{trenchFix.perTrench} circuits in each, lifts the grouping factor
                              from {fmt(chain.fGroup.value ?? 0, 3)} to {fmt(trenchFix.fGroup, 3)} and
                              the rating to {fmt(trenchFix.derated, 1)} A, at about
                              {" "}{fmt(trenchFix.widthM, 2)} m of width each.
                              <button className="btn" style={{ marginLeft: 8, padding: "2px 9px" }}
                                onClick={() => set({ ...st, trenches: trenchFix.trenches })}>
                                Split into {trenchFix.trenches}
                              </button></>
                          : <>More trenches lift the grouping factor, but not far enough to carry
                              this current at this size; it is currently
                              {" "}{fmt(chain.fGroup.value ?? 0, 3)}.</>}
                    </li>
                  )}
                </ul>
              </div>
            ) : (
              <div className="readout" style={{ border: `1px solid ${HL.used.line}`, background: HL.used.bg }}>
                <b>Passes.</b> {fmt(perCable, 1)} A per cable against {fmt(chain.derated, 1)} A derated,
                {" "}{fmt(util, 0)}% utilised with {fmt(chain.derated - perCable, 1)} A of headroom.
                {chain.derated / Math.max(1e-9, perCable) > 2
                  ? " That is a lot of headroom; a smaller size may be cheaper."
                  : ""}
              </div>
            )}
          </div>

          {chain.extrapolated && (
            <div className="warn" style={{ width: "100%", marginTop: 8 }}>
              &#9888; <b>The base rating is extrapolated, not IEC data.</b> {chain.extrapReason}
              {" "}Real ratings flatten off as size grows, because skin and proximity effects rise,
              so a straight line over-predicts and the {fmt(st.safetyPct, 0)}% reduction only partly
              offsets it. Replace it with the manufacturer&#39;s figure before anything is ordered.
            </div>
          )}

          {buried && st.multiTrench && !plan.fits && (
            <div className="warn" style={{ width: "100%", marginTop: 8 }}>
              &#9888; {plan.perTrench} circuits at {fmt(plan.centreSpacingM * 1000, 0)} mm centres
              needs {fmt(plan.widthM, 2)} m of trench, against a {fmt(st.maxTrenchW, 1)} m maximum.
              {" "}<b>Use at least {plan.minTrenches} trench{plan.minTrenches === 1 ? "" : "es"}</b>
              {" "}({Math.ceil(plan.total / plan.minTrenches)} circuits each), or bring the spacing in.
              <button className="btn" style={{ marginLeft: 10, padding: "3px 10px" }}
                onClick={() => set({ ...st, trenches: plan.minTrenches })}>
                Split into {plan.minTrenches}
              </button>
            </div>
          )}

          {buried && st.multiTrench && (
            <div style={{ width: "100%", background: C.paper, border: `1px solid ${C.line}`,
              borderRadius: 6, padding: 8, marginTop: 8 }}>
              <TrenchDiagram install={focus} circuits={plan.perTrench} depth={st.depth}
                parallel={row.par} own={ev.own} aux={row.aux} total={plan.total}
                trenches={plan.trenches}
                spacingLabel={spacingOpts.find((x) => x.value === row.spacing)?.label ?? row.spacing} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LvSizing({ kind, table, designCurrent, st, set, firstCode = 3 }) {
  const code = (n) => `C${firstCode + n}`;
  /* Which cards are expanded. All three are on screen either way; this
     only controls whether the arithmetic under each is unfolded. The
     first view is the three answers, which is what a first glance wants. */
  const [openCards, setOpenCards] = useState({ air: false, duct: true, ground: false });
  const toggle = (k) => setOpenCards((o) => ({ ...o, [k]: !o[k] }));
  const [refMethod, setRefMethod] = useState("duct");

  const evs = Object.fromEntries(METHODS.map((m) =>
    [m.value, evaluateRow(st.rows[m.value], m.value, st, table, kind, designCurrent)]));
  const focus = refMethod;
  const row = st.rows[focus];
  const { chain, plan } = evs[focus];
  const buried = focus !== "air";
  const spacingOpts = spacingOptionsFor(focus);

  return (<>
    <Section code={code(0)} title="Site conditions">
      <Num label="Air temperature" unit="°C" value={st.tAir} step={1}
        onChange={(v) => set({ ...st, tAir: v })} />
      <Num label="Ground temperature" unit="°C" value={st.tGnd} step={1}
        onChange={(v) => set({ ...st, tGnd: v })} />
      <Num label="Soil resistivity" unit="K·m/W" value={st.soil} step={0.1}
        onChange={(v) => set({ ...st, soil: v })} />
      <Num label="Burial depth" unit="m" value={st.depth} step={0.05}
        onChange={(v) => set({ ...st, depth: v })} />
      <div className="readout" style={{ font: "10.5px/1.6 system-ui" }}>
        Four numbers set every buried rating below. Air temperature drives the tray case only;
        the other three drive both buried cases. Everything else is per method and sits on its
        own card.
      </div>

      {/* Trenching is off until asked for. Most runs are one trench, and
          a tool that opens with trench-width arithmetic on screen is
          answering a question nobody asked yet. */}
      <label style={{ display: "flex", alignItems: "center", gap: 8, width: "100%",
        padding: "8px 11px", borderRadius: 6, cursor: "pointer",
        background: st.multiTrench ? "rgba(232,130,12,0.10)" : C.panel2,
        border: `1px solid ${st.multiTrench ? C.accent : C.line}` }}>
        <input type="checkbox" checked={!!st.multiTrench}
          onChange={(e) => set({ ...st, multiTrench: e.target.checked,
            trenches: e.target.checked ? Math.max(2, st.trenches || 2) : 1 })}
          style={{ width: 15, height: 15, accentColor: C.accent }} />
        <span style={{ font: "600 11.5px system-ui", color: C.text }}>
          Split the run across more than one trench
        </span>
        <span style={{ font: "10.5px system-ui", color: C.muted }}>
          Off by default. Turn it on when the circuits will not fit one trench — a trench is
          about 2 m wide at most — or to lift the grouping factor.
        </span>
      </label>

      {st.multiTrench && (<>
        <Num label="Number of trenches" value={st.trenches} step={1} min={1}
          onChange={(v) => set({ ...st, trenches: v })} />
        <Num label="Maximum trench width" unit="m" value={st.maxTrenchW} step={0.1} min={0.3}
          onChange={(v) => set({ ...st, maxTrenchW: v })} />
        <Num label="Circuit width override" unit="mm" value={st.odOverride} step={1} min={0}
          onChange={(v) => set({ ...st, odOverride: v })} />
        <div className="readout" style={{ font: "10.5px/1.6 system-ui" }}>
          <b>The grouping factor is then looked up per trench, not on the total</b>, because each
          trench is its own thermal group. That only holds if they are far enough apart to be
          thermally independent — two trenches a metre apart are still one group and the lookup
          belongs on the total. The tool does not check the separation; you do.
        </div>
      </>)}
    </Section>

    <Section code={code(1)} title="All three installation methods">
      <div style={{ width: "100%" }}>
        {METHODS.map((m) => (
          <MethodCard key={m.value} method={m} kind={kind} table={table} st={st} set={set}
            designCurrent={designCurrent} open={!!openCards[m.value]}
            onToggle={() => toggle(m.value)} />
        ))}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button className="btn" onClick={() => setOpenCards({ air: true, duct: true, ground: true })}>
            Show all working
          </button>
          <button className="btn" onClick={() => setOpenCards({ air: false, duct: false, ground: false })}>
            Hide all
          </button>
          <Num label="Extrapolation safety reduction" unit="%" value={st.safetyPct} step={1} min={0}
            onChange={(v) => set({ ...st, safetyPct: v })} />
        </div>
        <div className="readout" style={{ marginTop: 8 }}>
          A circuit with several conductors per pole counts as that many circuits
          (IEC 60364-5-52 B.52.18/19 NOTE 3), so circuits routed together {"×"} parallel N, plus
          anything else loaded on the route, is the total. Earth, fibre and spare cores carry no
          load and do not count.
        </div>
      </div>
    </Section>

    <Section code={code(2)} title="The tables these numbers came from">
      <Sel label="Show the lookups for" value={refMethod}
        onChange={setRefMethod} options={METHODS} />
      <div style={{ width: "100%" }}>
        <HighlightKey />

        <RefCard
          title="Base current-carrying capacity"
          source={kind === "dc"
            ? "IEC 60364-5-52 Table B.52.12 (air) and B.52.4 D1/D2 (buried)"
            : "IEC 60364-5-52 Table B.52.13 (air) and B.52.4 D1/D2 (buried)"}
          note="All three methods are highlighted at once, each in its own column, so the sizes can be compared without changing anything.">
          <TableCCC table={table} size={row.size} install={focus} methods={METHODS}
            extrapolated={chain.extrapolated ? chain.base : null}
            manual={chain.baseManual} manualValue={chain.base} autoValue={chain.baseAuto}
            alsoPicks={METHODS.filter((m) => m.value !== focus).map((m) => ({
              install: m.value, size: st.rows[m.value].size }))} />
        </RefCard>

        <RefCard emphasis={!chain.fTemp.exact || chain.fTemp.manual}
          title={`Temperature factor, ${focus === "air" ? "in air" : "in ground"}`}
          source={focus === "air"
            ? "IEC 60364-5-52 Table B.52.14, XLPE, 30 °C base"
            : "IEC 60364-5-52 Table B.52.15, XLPE, 20 °C base"}>
          <Table1D table={chain.tempTable} xLabel="°C" yLabel="factor" bracket={chain.fTemp}
            fmtX={(v) => `${v}`} />
        </RefCard>

        {chain.groupRows && (
          <RefCard title="Grouping factor"
            source={focus === "air" ? "IEC 60364-5-52 Table B.52.17 item 1, bunched"
              : focus === "duct" ? "IEC 60364-5-52 Table B.52.19A, buried ducts"
                : "IEC 60364-5-52 Table B.52.18, direct buried"}
            note={`Looked up on ${plan.perTrench} circuit${plan.perTrench === 1 ? "" : "s"}`
              + `${plan.trenches > 1 ? ` per trench, from ${plan.total} split across ${plan.trenches}` : ""}.`}>
            <TableGroup rows={chain.groupRows}
              cols={focus === "air" ? [{ value: "f", label: "factor" }] : spacingOpts}
              activeCol={chain.groupCol} circuits={plan.perTrench} bracket={chain.fGroup} />
          </RefCard>
        )}

        {buried && (<>
          <RefCard emphasis={!chain.fSoil.exact || chain.fSoil.manual}
            title="Soil thermal resistivity"
            source="IEC 60364-5-52 Table B.52.16, 2.5 K·m/W base">
            <Table1D table={chain.soilTable} xLabel="K·m/W" yLabel="factor" bracket={chain.fSoil} />
          </RefCard>
          <RefCard emphasis={!chain.fDepth.exact || chain.fDepth.manual} title="Burial depth"
            source={`IEC 60287 derived, 0.8 m base, ${row.size <= 185 ? "≤185" : ">185"} mm² column`}>
            <Table1D table={chain.depthTable} xLabel="m" yLabel="factor" bracket={chain.fDepth} />
          </RefCard>
        </>)}
      </div>
    </Section>
  </>);
}

export function CableDcTab({ mod, elec, st, set }) {
  const isc = st.iscOv ?? mod.isc;
  const imp = st.impOv ?? mod.imp;
  const vmp = st.vmpOv ?? mod.vmp;
  const nMod = st.nModOv ?? elec.modulesPerString;

  const iAuto = isc * st.sf;
  const iDesign = Number.isFinite(st.iOv) && st.iOv !== null ? st.iOv : iAuto;
  const vString = vmp * nMod;
  const pString = vString * imp;


  const r20 = rowFor(DC_R20, st.vdSize)?.r ?? null;
  const rTab = r20 === null ? null : rAtTemp(r20, st.tCond, "copper");
  const rUse = st.rMode === "manual" ? st.rManual : rTab;
  const lTotal = st.length * st.loop;
  const rTotal = rUse === null ? null : rUse * lTotal;
  const dV = rTotal === null ? null : imp * rTotal;
  const dVpct = dV === null || !vString ? null : (dV / vString) * 100;
  const pLoss = rTotal === null ? null : imp * imp * rTotal;
  const pLossPct = pLoss === null || !pString ? null : (pLoss / pString) * 100;
  const maxLen = rUse && imp && st.loop
    ? ((st.vdLimit / 100) * vString) / (imp * rUse * st.loop) : null;

  return (
    <Page wide>
      <div className="tbl" style={{ marginBottom: 10 }}>
        CABLE SIZING — DC STRING / ARRAY (H1Z2Z2-K COPPER, XLPO, 2 LOADED CONDUCTORS)
      </div>

      <Section code="C1" title="Imported values — the only link to the other tools">
        <Scroll min={640}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <ImportedHead />
            <tbody>
              <Imported label="Module Isc" source="Module tab" linked={mod.isc}
                override={st.iscOv} onOverride={(v) => set({ ...st, iscOv: v })} unit="A" />
              <Imported label="Module Imp" source="Module tab" linked={mod.imp}
                override={st.impOv} onOverride={(v) => set({ ...st, impOv: v })} unit="A" />
              <Imported label="Module Vmp" source="Module tab" linked={mod.vmp}
                override={st.vmpOv} onOverride={(v) => set({ ...st, vmpOv: v })} unit="V" />
              <Imported label="Modules in series" source="String sizing" linked={elec.modulesPerString}
                override={st.nModOv} onOverride={(v) => set({ ...st, nModOv: v })} unit="—" dp={0} />
            </tbody>
          </table>
        </Scroll>
      </Section>

      <Section code="C2" title="Design current">
        <Num label="Safety factor" value={st.sf} step={0.05} min={1}
          onChange={(v) => set({ ...st, sf: v })} />
        <div className="readout">
          IEC 62548 sizes PV array cable on <b>{fmt(st.sf, 2)} × Isc</b>, not on Imp. The factor
          covers irradiance above 1000 W/m² — edge-of-cloud enhancement routinely puts 1.2 suns
          on an array for a few minutes — and the fact that a short circuit in a PV array is
          barely larger than normal operating current, so the cable itself has to be the
          limiting element rather than a fuse.
        </div>
        <Working n="C2" title="DC design current"
          formula="I_design = Isc × SF"
          sub={`${fmt(isc, 2)} A × ${fmt(st.sf, 2)}`}
          result={fmt(iAuto, 2)} unit="A"
          why="Every ampacity check below is against this current, divided by however many cables run in parallel." />
        <AutoField label="Design current" unit="A" dp={2} auto={iAuto}
          value={st.iOv ?? null} onChange={(v) => set({ ...st, iOv: v })}
          hint="Isc × SF, as above" />
        <div className="readout" style={{ font: "10.5px system-ui" }}>
          The calculated figure is the one to use unless something says otherwise. Type a current
          here when a client standard, a protective device rating or an existing design fixes it,
          and every check below moves to your number instead.
          {Number.isFinite(st.iOv) && st.iOv !== null && (
            <b style={{ color: HL.manual.text }}>
              {" "}Currently using {fmt(st.iOv, 2)} A by hand, not the {fmt(iAuto, 2)} A calculated.
            </b>
          )}
        </div>
      </Section>

      <LvSizing kind="dc" table={DC_CCC} designCurrent={iDesign} st={st} set={set} firstCode={3} />

      <Section code="C6" title="Voltage drop and power loss">
        <Sel label="Resistance source" value={st.rMode}
          onChange={(v) => set({ ...st, rMode: v })}
          options={[
            { value: "table", label: "IEC 60228 class 5 table" },
            { value: "manual", label: "Enter R directly" },
          ]} />
        <Sel label="Cable size for volt drop" value={String(st.vdSize)}
          onChange={(v) => set({ ...st, vdSize: Number(v) })}
          options={DC_R20.map((x) => ({ value: String(x.size), label: `${x.size} mm²` }))} />
        {st.rMode === "manual"
          ? <Num label="R in use" unit="Ω/m" value={st.rManual} step={0.0001}
              onChange={(v) => set({ ...st, rManual: v })} />
          : <Num label="Conductor temperature" unit="°C" value={st.tCond} step={5}
              onChange={(v) => set({ ...st, tCond: v })} />}
        <Num label="Route length, one way" unit="m" value={st.length} step={5}
          onChange={(v) => set({ ...st, length: v })} />
        <Num label="Loop factor" value={st.loop} step={1} min={1}
          onChange={(v) => set({ ...st, loop: v })} />
        <Num label="Voltage drop limit" unit="%" value={st.vdLimit} step={0.1}
          onChange={(v) => set({ ...st, vdLimit: v })} />

        {st.rMode === "table" && (
          <Working n="C6a" title="Conductor resistance at operating temperature"
            formula="R(θ) = R₂₀ × [1 + α(θ − 20)]"
            sub={`${fmt((r20 ?? 0) * 1000, 4)} mΩ/m × [1 + 0.00393 × (${fmt(st.tCond, 0)} − 20)]`}
            result={fmt((rUse ?? 0) * 1000, 4)} unit="mΩ/m"
            why="IEC 60228 tabulates the maximum resistance at 20 °C. A loaded solar cable in the sun sits far above that, and volt drop taken from the 20 °C value under-reads by about 1 % for every 2.5 °C. H1Z2Z2-K uses fine-strand tinned class 5 copper, which is around 18 % more resistive than solid copper of the same nominal area." />
        )}
        <Working n="C6b" title="Total conductor length"
          formula="L_total = L_route × loop factor"
          sub={`${fmt(st.length, 0)} m × ${fmt(st.loop, 0)}`}
          result={fmt(lTotal, 0)} unit="m"
          why="A DC circuit is a loop: current goes out on the positive and returns on the negative, so both legs drop volts. Set the loop factor to 1 only if the resistance figure you entered already covers both conductors." />
        <Working n="C6c" title="Voltage drop"
          formula="ΔV = Imp × R × L_total"
          sub={`${fmt(imp, 2)} A × ${fmt((rUse ?? 0) * 1000, 4)} mΩ/m × ${fmt(lTotal, 0)} m`}
          result={dV === null ? "—" : fmt(dV, 2)} unit="V"
          status={dVpct !== null && dVpct <= st.vdLimit ? "OK" : "Over limit"}
          why={`String voltage is Vmp × N = ${fmt(vmp, 2)} × ${nMod} = ${fmt(vString, 0)} V, so the drop is ${dVpct === null ? "—" : fmt(dVpct, 2)} % against a ${fmt(st.vdLimit, 1)} % limit. Volt drop on the DC side is a pure yield loss, not a compliance question — the inverter simply sees a lower voltage and harvests less.`} />
        <Working n="C6d" title="Power loss"
          formula="ΔP = Imp² × R × L_total"
          sub={`${fmt(imp, 2)}² × ${fmt(rTotal ?? 0, 4)} Ω`}
          result={pLoss === null ? "—" : fmt(pLoss, 1)} unit="W"
          why={`That is ${pLossPct === null ? "—" : fmt(pLossPct, 2)} % of the ${fmt(pString / 1000, 2)} kW the string produces at MPP. For a DC string the loss percentage and the volt-drop percentage are numerically identical, because power is voltage times a current that is common to both — so a 1 % drop limit is also a 1 % energy limit.`} />
        <Working n="C6e" title="Maximum route length at the limit"
          formula="L_max = (limit% / 100 × V_string) / (Imp × R × loop)"
          sub={`(${fmt(st.vdLimit, 1)}% × ${fmt(vString, 0)} V) / (${fmt(imp, 2)} A × ${fmt((rUse ?? 0) * 1000, 4)} mΩ/m × ${fmt(st.loop, 0)})`}
          result={maxLen === null ? "—" : fmt(maxLen, 1)} unit="m"
          status={maxLen !== null && maxLen >= st.length ? "OK" : "Over limit"}
          why={`Headroom is ${maxLen === null ? "—" : fmt(maxLen - st.length, 1)} m. Negative means the run is too long for this size: upsize the cable, split the string closer to the combiner, or accept the loss deliberately.`} />
      </Section>
    </Page>
  );
}

/* =====================================================================
   2.  AC — inverter to transformer feeder
   ===================================================================== */
export function CableAcTab({ inv, setInv, st, set }) {
  const linkedI = inv.acKva && inv.vAc ? (inv.acKva * 1000) / (Math.sqrt(3) * inv.vAc) : null;
  const iDesign = st.iOv ?? (Number.isFinite(linkedI) ? linkedI : 0);


  const r20 = rowFor(AL_R20, st.vdSize)?.r ?? null;
  const rUse = st.rMode === "manual" ? st.rManual
    : (r20 === null ? null : rAtTemp(r20, st.tCond, "aluminium"));
  const xUse = st.rMode === "manual" ? st.xManual
    : (AL_X_TREFOIL.find((v) => v.size === st.vdSize)?.x ?? null);
  const th = (st.theta * Math.PI) / 180;
  const n = Math.max(1, st.par);
  const zEff = rUse === null ? null : (rUse / n) * Math.cos(th) + (xUse / n) * Math.sin(th);
  const dV = zEff === null ? null : Math.sqrt(3) * iDesign * zEff * st.length;
  const dVpct = dV === null || !st.vRef ? null : (dV / st.vRef) * 100;
  const pLoss = rUse === null ? null : (3 * Math.pow(iDesign / n, 2) * rUse * st.length * n);
  const sTotal = (inv.acKva || 0) * 1000;
  const pLossPct = sTotal ? (pLoss / (sTotal * Math.max(0.1, Math.cos(th)))) * 100 : null;
  const maxLen = zEff && iDesign ? ((st.vdLimit / 100) * st.vRef) / (Math.sqrt(3) * iDesign * zEff) : null;

  return (
    <Page wide>
      <div className="tbl" style={{ marginBottom: 10 }}>
        CABLE SIZING — AC INVERTER TO TRANSFORMER (ALUMINIUM XLPE, THREE SINGLE-CORES IN TREFOIL)
      </div>

      <Section code="C1" title="Imported values and design current">
        <Scroll min={640}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <ImportedHead />
            <tbody>
              <Imported label="Inverter AC current" source="Inverter tab — S / (√3 × V)"
                linked={linkedI} override={st.iOv} onOverride={(v) => set({ ...st, iOv: v })} unit="A" />
            </tbody>
          </table>
        </Scroll>
        <div className="readout">
          The linked figure is the rated apparent power divided by √3 × line voltage. Use the
          override for the datasheet's <b>maximum</b> output current instead, which is what
          IEC 62548 and most grid codes want — it is typically a few per cent above the rating
          because the inverter is allowed to run at leading or lagging power factor, and the
          current, not the power, is what heats the cable.
        </div>
        <Num label="Inverter AC line voltage" unit="V" value={inv.vAc || 0} step={5}
          onChange={(v) => setInv({ ...inv, vAc: v })} />
        <div className="readout" style={{ font: "10.5px system-ui", color: C.muted }}>
          Shared with the Inverter tab and the short-circuit tool. Utility-scale string
          inverters are commonly 800 V; central inverters 600 to 690 V.
        </div>
      </Section>

      <LvSizing kind="ac" table={AC_CCC} designCurrent={iDesign} st={st} set={set} firstCode={2} />

      <Section code="C5" title="Voltage drop and power loss">
        <Sel label="Impedance source" value={st.rMode}
          onChange={(v) => set({ ...st, rMode: v })}
          options={[
            { value: "table", label: "IEC 60228 + typical trefoil X" },
            { value: "manual", label: "Enter R and X directly" },
          ]} />
        <Sel label="Cable size for volt drop" value={String(st.vdSize)}
          onChange={(v) => set({ ...st, vdSize: Number(v) })}
          options={AL_R20.map((x) => ({ value: String(x.size), label: `${x.size} mm²` }))} />
        {st.rMode === "manual" ? (
          <>
            <Num label="R in use" unit="Ω/m" value={st.rManual} step={0.00001}
              onChange={(v) => set({ ...st, rManual: v })} />
            <Num label="X in use" unit="Ω/m" value={st.xManual} step={0.00001}
              onChange={(v) => set({ ...st, xManual: v })} />
          </>
        ) : (
          <Num label="Conductor temperature" unit="°C" value={st.tCond} step={5}
            onChange={(v) => set({ ...st, tCond: v })} />
        )}
        <Num label="Angle θ (cos θ = power factor)" unit="deg" value={st.theta} step={1}
          onChange={(v) => set({ ...st, theta: v })} />
        <Num label="Reference line voltage" unit="V" value={st.vRef} step={5}
          onChange={(v) => set({ ...st, vRef: v })} />
        <Num label="Run length" unit="m" value={st.length} step={5}
          onChange={(v) => set({ ...st, length: v })} />
        <Num label="Parallel cables per phase" value={st.par} step={1} min={1}
          onChange={(v) => set({ ...st, par: v })} />
        <Num label="Voltage drop limit" unit="%" value={st.vdLimit} step={0.1}
          onChange={(v) => set({ ...st, vdLimit: v })} />

        <Working n="C5a" title="Effective impedance per phase"
          formula="Z_eff = (R/n)·cos θ + (X/n)·sin θ"
          sub={`(${fmt((rUse ?? 0) * 1000, 4)} / ${n})·cos ${fmt(st.theta, 0)}° + (${fmt((xUse ?? 0) * 1000, 4)} / ${n})·sin ${fmt(st.theta, 0)}° mΩ/m`}
          result={fmt((zEff ?? 0) * 1000, 5)} unit="mΩ/m"
          why="At unity power factor the reactance term vanishes and only resistance matters. It stops being negligible the moment the inverter is asked to absorb or export reactive power: at 0.9 lagging, sin θ is 0.44 and the reactance of a large aluminium cable is comparable with its resistance, so the drop can nearly double." />
        <Working n="C5b" title="Voltage drop"
          formula="ΔV = √3 × I × Z_eff × L"
          sub={`1.732 × ${fmt(iDesign, 1)} A × ${fmt((zEff ?? 0) * 1000, 5)} mΩ/m × ${fmt(st.length, 0)} m`}
          result={dV === null ? "—" : fmt(dV, 2)} unit="V"
          status={dVpct !== null && dVpct <= st.vdLimit ? "OK" : "Over limit"}
          why={`${dVpct === null ? "—" : fmt(dVpct, 3)} % of ${fmt(st.vRef, 0)} V against a ${fmt(st.vdLimit, 1)} % limit. On the AC side the drop matters for two reasons: it is lost energy, and it eats into the inverter's voltage headroom for reactive power at the point of connection.`} />
        <Working n="C5c" title="Power loss"
          formula="ΔP = 3 × (I/n)² × R × L × n"
          sub={`3 × (${fmt(iDesign, 1)}/${n})² × ${fmt((rUse ?? 0) * 1000, 4)} mΩ/m × ${fmt(st.length, 0)} m × ${n}`}
          result={pLoss === null ? "—" : fmt(pLoss, 0)} unit="W"
          why={`About ${pLossPct === null ? "—" : fmt(pLossPct, 3)} % of the inverter's output at this power factor. Reactance does no net work, so only R appears here — a cable can have a significant volt drop and a small loss, or the reverse.`} />
        <Working n="C5d" title="Maximum length at the limit"
          formula="L_max = (limit% / 100 × V_ref) / (√3 × I × Z_eff)"
          sub={`(${fmt(st.vdLimit, 1)}% × ${fmt(st.vRef, 0)} V) / (1.732 × ${fmt(iDesign, 1)} A × ${fmt((zEff ?? 0) * 1000, 5)} mΩ/m)`}
          result={maxLen === null ? "—" : fmt(maxLen, 1)} unit="m"
          status={maxLen !== null && maxLen >= st.length ? "OK" : "Over limit"}
          why={`Headroom ${maxLen === null ? "—" : fmt(maxLen - st.length, 1)} m. If the LV run has to be long, the answer is usually not a bigger cable — it is to move the transformer, because MV carries the same power at a fraction of the current.`} />
      </Section>
    </Page>
  );
}

/* =====================================================================
   3.  MV — collector ring
   ===================================================================== */
export function CableMvTab({ st, set }) {
  const table = useMemo(() => mvTable(st.safety), [st.safety]);
  const iInv = st.kv > 0 ? st.kva / (Math.sqrt(3) * st.kv) : 0;

  /* Derated capacity for every size, both installation methods. */
  const caps = useMemo(() => table.map((r) => {
    /* Each factor is kept as a bracket object, not a bare number, so the
       reference tables in C6 can pick out the row it was read from and
       say when a value was interpolated rather than tabulated. */
    const build = (kind) => {
      const base = r[kind === "duct" ? "duct" : "buried"];
      const depthTable = kind === "duct"
        ? (r.size <= 185 ? DEPTH_DUCT_LE185 : DEPTH_DUCT_GT185)
        : (r.size <= 185 ? DEPTH_DIRECT_LE185 : DEPTH_DIRECT_GT185);
      const soilRow = (kind === "duct" ? MV_SOIL_DUCT : MV_SOIL_DIRECT).find((x) => x.size === r.size);
      const o = (st.ov || {})[kind] || {};
      const bT = applyOverride(interpBracket(MV_TEMP_GROUND, st.tGnd), o.fTemp);
      const bD = applyOverride(interpBracket(depthTable, st.depth), o.fDepth);
      const bS = applyOverride(soilRow ? interpBracket(soilRow.f, st.soil)
        : { value: 1, lo: null, hi: null, exact: true, clamped: false }, o.fSoil);
      const bG = applyOverride(groupFactorBracket(
        kind === "duct" ? MV_GROUP_DUCT : MV_GROUP_DIRECT,
        kind === "duct" ? st.ductCirc : st.dirCirc,
        kind === "duct" ? st.ductSp : st.dirSp,
      ), o.fGroup);
      const fT = bT.value, fD = bD.value, fS = bS.value, fG = bG.value;
      const ok = base !== null && base !== undefined && fG !== null;
      const df = ok ? fT * fD * fS * fG : null;
      return { base, fT, fD, fS, fG, bT, bD, bS, bG, depthTable, soilTable: soilRow?.f ?? null,
        df, derated: ok ? base * df : null };
    };
    return { size: r.size, extrap: !!r.extrap, r: r.r, x: r.x, duct: build("duct"), direct: build("direct") };
  }), [table, st.tGnd, st.depth, st.soil, st.ductCirc, st.ductSp, st.dirCirc, st.dirSp, st.ov]);

  const capFor = (install, size) => {
    const c = caps.find((x) => x.size === size);
    if (!c) return null;
    return (install === "duct" ? c.duct : c.direct).derated;
  };

  /* Runs. Current accumulates along a branch and resets at each new one. */
  const th = (st.theta * Math.PI) / 180;
  const runs = useMemo(() => {
    let cum = 0, cumV = 0, lastBranch = null;
    return st.runs.map((rn) => {
      if (rn.branch !== lastBranch) { cum = 0; cumV = 0; lastBranch = rn.branch; }
      const runI = rn.inv * iInv;
      cum += runI;
      const c = caps.find((x) => x.size === rn.size);
      const derated = capFor(rn.install, rn.size);
      const r20 = c?.r ?? 0;
      const rOp = rAtTemp(r20, st.tCond, "aluminium");
      const x = c?.x ?? 0;
      const dv = Math.sqrt(3) * cum * (rOp * Math.cos(th) + x * Math.sin(th)) * rn.dist;
      cumV += dv;
      const cumPct = st.kv > 0 ? (cumV / (st.kv * 1000)) * 100 : 0;
      const len = rn.dist * 3 * st.slack;
      /* If the run is over its rating, say by how much and name the
         smallest size that carries it, rather than leaving "UPSIZE" as
         the whole of the advice. */
      const over = derated !== null && cum > derated;
      let rec = null;
      if (over) {
        for (const cand of caps) {
          const d = (rn.install === "duct" ? cand.duct : cand.direct).derated;
          if (d !== null && d >= cum) { rec = { size: cand.size, derated: d, extrap: !!cand.extrap }; break; }
        }
      }
      return { ...rn, runI, cum, derated, util: derated ? (cum / derated) * 100 : NaN, dv, cumPct, len,
        extrap: !!c?.extrap, over,
        overA: over ? cum - derated : 0, overPct: over ? ((cum - derated) / derated) * 100 : 0, rec };
    });
  }, [st.runs, iInv, caps, th, st.kv, st.slack, st.tCond]);

  const worstI = runs.length ? Math.max(...runs.map((r) => r.cum)) : 0;
  const worstV = runs.length ? Math.max(...runs.map((r) => r.cumPct)) : 0;
  const totalLen = runs.reduce((a, r) => a + r.len, 0);

  /* Bill of materials by size. */
  const bom = useMemo(() => table.map((t) => {
    const rs = runs.filter((r) => r.size === t.size);
    const len = rs.reduce((a, r) => a + r.len, 0);
    return { size: t.size, count: rs.length, len, withSpares: len * (1 + st.spares / 100) };
  }).filter((b) => b.count > 0), [runs, table, st.spares]);

  const upd = (i, patch) => set({ ...st, runs: st.runs.map((r, j) => (i === j ? { ...r, ...patch } : r)) });
  const addRun = () => {
    const last = st.runs[st.runs.length - 1];
    set({ ...st, runs: [...st.runs, last
      ? { ...last, from: last.to, to: `${last.to}b`, inv: Math.max(1, last.inv - 1) }
      : { branch: 1, from: "1", to: "2", inv: 10, install: "duct", size: 150, dist: 300 }] });
  };
  const delRun = (i) => set({ ...st, runs: st.runs.filter((_, j) => j !== i) });

  return (
    <Page wide>
      <div className="tbl" style={{ marginBottom: 10 }}>
        CABLE SIZING — MV COLLECTOR RING (3 × 1c ALUMINIUM XLPE 19/33 kV, IEC 60502-2, TREFOIL)
      </div>

      <Section code="C1" title="Design current">
        <Num label="MV voltage level" unit="kV" value={st.kv} step={1}
          onChange={(v) => set({ ...st, kv: v })} />
        <Num label="Inverter apparent power" unit="kVA" value={st.kva} step={10}
          onChange={(v) => set({ ...st, kva: v })} />
        <Working n="M1" title="Current per inverter, referred to MV"
          formula="I_inv = S / (√3 × U)"
          sub={`${fmt(st.kva, 0)} kVA / (1.732 × ${fmt(st.kv, 0)} kV)`}
          result={fmt(iInv, 2)} unit="A"
          why="This is the whole reason MV collection exists. The same 352 kVA that needs 490 A at 415 V needs 6.2 A at 33 kV, so a ring serving fifty inverters still fits in a cable a person can pull. Use the inverter's AC output at the site's design ambient, not its nameplate — thermal derating at 45 °C is real and reduces the ring current." />
      </Section>

      <Section code="C2" title="Installation parameters — both capacity tables follow these">
        <Num label="Ground temperature" unit="°C" value={st.tGnd} step={1}
          onChange={(v) => set({ ...st, tGnd: v })} />
        <Num label="Burial depth" unit="m" value={st.depth} step={0.05}
          onChange={(v) => set({ ...st, depth: v })} />
        <Num label="Soil resistivity" unit="K·m/W" value={st.soil} step={0.1}
          onChange={(v) => set({ ...st, soil: v })} />
        <Num label="Extrapolation safety reduction" unit="%" value={st.safety} step={1}
          onChange={(v) => set({ ...st, safety: v })} />
        <Num label="Ducts: circuits adjacent" value={st.ductCirc} step={1} min={1}
          onChange={(v) => set({ ...st, ductCirc: v })} />
        <Sel label="Ducts: centre spacing" value={st.ductSp}
          onChange={(v) => set({ ...st, ductSp: v })} options={MV_SPACINGS} />
        <Num label="Direct: circuits adjacent" value={st.dirCirc} step={1} min={1}
          onChange={(v) => set({ ...st, dirCirc: v })} />
        <Sel label="Direct: centre spacing" value={st.dirSp}
          onChange={(v) => set({ ...st, dirSp: v })} options={MV_SPACINGS} />
        <div className="readout">
          <b>Two different bases.</b> IEC 60502-2 references its soil factors to 1.5 K·m/W;
          the LV standard IEC 60364-5-52 uses 2.5. The tables here are the MV ones — do not
          carry a factor across from the DC or AC tab. A soil resistivity of 2.5 K·m/W costs a
          buried MV cable about 20 %, which is roughly one standard size.
        </div>
      </Section>

      <Section code="C3" title="Derated capacity by size">
        <Scroll min={860}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead><tr>
              <Th>Size mm²</Th>
              <Th>Duct base A</Th><Th>f_temp</Th><Th>f_depth</Th><Th>f_soil</Th><Th>f_grp</Th>
              <Th>Duct derated A</Th>
              <Th>Direct base A</Th><Th>Direct derated A</Th><Th>R mΩ/m</Th><Th>X mΩ/m</Th>
            </tr></thead>
            <tbody>
              {caps.map((c) => (
                <tr key={c.size} style={{ borderTop: `1px solid ${C.line}`,
                  background: c.extrap ? "rgba(120,80,180,0.10)" : "transparent" }}>
                  <Td>{c.size}{c.extrap ? " *" : ""}</Td>
                  <Td dim>{c.duct.base === null ? "—" : fmt(c.duct.base, 0)}</Td>
                  {[c.duct.bT, c.duct.bD, c.duct.bS, c.duct.bG].map((bb, bi) => (
                    <Td key={bi} dim style={bb.manual ? { color: HL.manual.text, fontWeight: 700 } : undefined}>
                      {bb.value === null ? "—" : fmt(bb.value, 2)}</Td>
                  ))}
                  <Td><b>{c.duct.derated === null ? "—" : fmt(c.duct.derated, 0)}</b></Td>
                  <Td dim>{c.direct.base === null ? "—" : fmt(c.direct.base, 0)}</Td>
                  <Td><b>{c.direct.derated === null ? "—" : fmt(c.direct.derated, 0)}</b></Td>
                  <Td dim>{fmt(c.r * 1000, 3)}</Td>
                  <Td dim>{fmt(c.x * 1000, 3)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
        <div className="warn" style={{ width: "100%" }}>
          ⚠ 500 and 630 mm² (marked *) are <b>extrapolated, not IEC data</b>. IEC 60502-2
          Table B.3 stops at 400 mm². These rows extend the 300–400 mm² gradient in a straight
          line and then subtract {fmt(st.safety, 0)} %. Real ratings flatten off above 400 mm²
          as skin and proximity effects grow, so the straight line over-predicts and the
          reduction only partly offsets it. Replace them with a manufacturer rating before
          anything is ordered.
        </div>
      </Section>

      <Section code="C4" title="Ring runs">
        <Num label="Angle θ" unit="deg" value={st.theta} step={1}
          onChange={(v) => set({ ...st, theta: v })} />
        <Num label="Voltage drop limit" unit="%" value={st.vdLimit} step={0.1}
          onChange={(v) => set({ ...st, vdLimit: v })} />
        <Num label="Conductor temperature for R" unit="°C" value={st.tCond} step={5}
          onChange={(v) => set({ ...st, tCond: v })} />
        <Num label="Cable length slack factor" value={st.slack} step={0.05} min={1}
          onChange={(v) => set({ ...st, slack: v })} />
        <div className="readout" style={{ font: "10.5px system-ui" }}>
          IEC 60228 tabulates R at 20 °C. Set the conductor temperature to 20 to reproduce a
          spreadsheet that uses the table value directly; 90 °C is the XLPE limit and gives the
          worst-case drop at full load. The difference is 28 %, which is not a rounding error.
        </div>
        <Scroll min={1080}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead><tr>
              <Th>Branch</Th><Th>From</Th><Th>To</Th><Th>Inverters</Th><Th>Run A</Th>
              <Th>Cumulative A</Th><Th>Install</Th><Th>Size mm²</Th><Th>Derated A</Th>
              <Th>Utilisation</Th><Th>Route m</Th><Th>Cable m</Th><Th>ΔV run</Th>
              <Th>Cum ΔV %</Th><Th>Verdict</Th><Th />
            </tr></thead>
            <tbody>
              {runs.map((r, i) => (
                <tr key={i} style={{ borderTop: `1px solid ${C.line}` }}>
                  <Td><CellNum value={r.branch} min={1} onChange={(v) => upd(i, { branch: v })} w={44} /></Td>
                  <Td><input value={r.from} onChange={(e) => upd(i, { from: e.target.value })}
                    style={{ width: 52, background: C.panel2, border: `1px solid ${C.line}`,
                      borderRadius: 4, color: C.text, font: "12px var(--mono)", padding: "4px 6px", outline: "none" }} /></Td>
                  <Td><input value={r.to} onChange={(e) => upd(i, { to: e.target.value })}
                    style={{ width: 52, background: C.panel2, border: `1px solid ${C.line}`,
                      borderRadius: 4, color: C.text, font: "12px var(--mono)", padding: "4px 6px", outline: "none" }} /></Td>
                  <Td><CellNum value={r.inv} min={0} onChange={(v) => upd(i, { inv: v })} w={54} /></Td>
                  <Td dim>{fmt(r.runI, 1)}</Td>
                  <Td><b>{fmt(r.cum, 1)}</b></Td>
                  <Td><CellSel value={r.install} w={78} onChange={(v) => upd(i, { install: v })}
                    options={[{ value: "duct", label: "Duct" }, { value: "direct", label: "Direct" }]} /></Td>
                  <Td><CellSel value={String(r.size)} w={78} onChange={(v) => upd(i, { size: Number(v) })}
                    options={caps.map((c) => ({ value: String(c.size), label: `${c.size}${c.extrap ? " *" : ""}` }))} /></Td>
                  <Td dim>{r.derated === null ? "—" : fmt(r.derated, 0)}</Td>
                  <Td><UtilBar pct={r.util} /></Td>
                  <Td><CellNum value={r.dist} min={0} step={10} onChange={(v) => upd(i, { dist: v })} w={72} /></Td>
                  <Td dim>{fmt(r.len, 0)}</Td>
                  <Td dim>{fmt(r.dv, 1)} V</Td>
                  <Td>{fmt(r.cumPct, 3)}</Td>
                  <Td><Verdict pass={r.derated !== null && r.cum <= r.derated && r.cumPct <= st.vdLimit}
                    failText={r.derated !== null && r.cum > r.derated ? "UPSIZE" : "ΔV"} /></Td>
                  <Td><button className="btn" onClick={() => delRun(i)} style={{ padding: "3px 8px" }}>✕</button></Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
        <button className="btn" onClick={addRun}>+ Add run</button>

        {runs.some((r) => r.over) && (
          <div className="warn" style={{ width: "100%" }}>
            <b>&#9888; {runs.filter((r) => r.over).length} run
            {runs.filter((r) => r.over).length === 1 ? " is" : "s are"} over the derated
            rating.</b>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18, lineHeight: 1.65 }}>
              {runs.map((r, i) => r.over && (
                <li key={i}>
                  <b>{r.from}&#8594;{r.to}</b> carries {fmt(r.cum, 1)} A against {fmt(r.derated, 1)} A
                  at {r.size} mm&#178;: <b>over by {fmt(r.overA, 1)} A, which is {fmt(r.overPct, r.overPct < 10 ? 1 : 0)} %
                  </b> ({fmt(r.util, 0)} % utilised).
                  {r.rec
                    ? <> The smallest size that carries it is <b>{r.rec.size} mm&#178;</b> at
                        {" "}{fmt(r.rec.derated, 1)} A
                        {r.rec.extrap ? <span style={{ color: HL.extrap.text }}> (extrapolated, not IEC data)</span> : null}.
                        <button className="btn" style={{ marginLeft: 8, padding: "2px 9px" }}
                          onClick={() => upd(i, { size: r.rec.size })}>
                          Use {r.rec.size} mm&#178;
                        </button></>
                    : <> <b>No tabulated size carries it</b>, even extrapolated. Split the load
                        across a second circuit, widen the spacing, or feed the branch from the
                        other side of the ring.</>}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="readout">
          Current accumulates along a branch and resets when the branch number changes, so a
          radial feeder is one branch numbered in order from its far end to the substation.
          Cable length is route distance × 3 cores × {fmt(st.slack, 2)} slack — the slack covers
          joint bays, terminations, snaking in the trench and the vertical rises at each end,
          and 20 % is a realistic preliminary allowance.
        </div>
        <Working n="M2" title="Binding design current — worst run"
          formula="I_bind = MAX(cumulative current over all runs)"
          sub={`${runs.length} run${runs.length === 1 ? "" : "s"} evaluated`}
          result={fmt(worstI, 1)} unit="A"
          why="The last run into the substation carries everything upstream of it, so it sets the largest size on the ring. Worst cumulative volt drop is currently the run reaching the substation on its branch." />
        <Working n="M3" title="Worst cumulative voltage drop"
          formula="ΔV% = Σ(ΔV along branch) / U × 100"
          sub={`worst branch total / ${fmt(st.kv, 0)} kV`}
          result={fmt(worstV, 3)} unit="%"
          status={worstV <= st.vdLimit ? "OK" : "Over limit"}
          why={`Against a ${fmt(st.vdLimit, 1)} % limit. MV drop is usually comfortable — that is the point of MV — so a figure near the limit is a sign the ring is too long, too heavily loaded, or that a branch should be split and fed from the other side.`} />
      </Section>

      <Section code="C5" title="The tables these numbers came from">
        <Sel label="Show the lookups for" value={st.refInstall}
          onChange={(v) => set({ ...st, refInstall: v })}
          options={[{ value: "duct", label: "Buried duct" }, { value: "direct", label: "Direct buried" }]} />
        <Sel label="Size to trace" value={String(st.refSize)}
          onChange={(v) => set({ ...st, refSize: Number(v) })}
          options={caps.map((c) => ({ value: String(c.size), label: `${c.size} mm²${c.extrap ? " *" : ""}` }))} />
        <div style={{ width: "100%" }}>
          <HighlightKey />
          {(() => {
            const c = caps.find((x) => x.size === st.refSize) || caps[0];
            const b = st.refInstall === "duct" ? c.duct : c.direct;
            const circuits = st.refInstall === "duct" ? st.ductCirc : st.dirCirc;
            const spacing = st.refInstall === "duct" ? st.ductSp : st.dirSp;
            const chain = { base: b.base, extrapolated: c.extrap, fTemp: b.bT, fGroup: b.bG,
              fSoil: b.bS, fDepth: b.bD, derated: b.derated };
            const design = runs.filter((r) => r.size === c.size && r.install === st.refInstall)
              .reduce((a, r) => Math.max(a, r.cum), 0);
            const o = (st.ov || {})[st.refInstall] || {};
            const setMvOv = (k, v) => set({ ...st,
              ov: { ...(st.ov || {}), [st.refInstall]: { ...o, [k]: v } } });
            return (
              <>
                <div style={{ marginBottom: 10 }}>
                  <FactorChain chain={chain} perCable={design} />

                  <div style={{ width: "100%", marginTop: 8, padding: "9px 11px", borderRadius: 6,
                    background: C.panel2, border: `1px solid ${C.line}` }}>
                    <div style={{ font: "600 11px system-ui", color: C.text, marginBottom: 2 }}>
                      Override any of these
                    </div>
                    <div style={{ font: "10.5px/1.5 system-ui", color: C.muted, marginBottom: 8 }}>
                      Empty means calculated from the IEC tables. A typed value is used instead and
                      shows in blue, with the table figure struck through beside it. These apply to
                      every size on the <b>{st.refInstall === "duct" ? "buried duct" : "direct buried"}</b>
                      {" "}method, not just the one traced here, so the capacity table above moves
                      with them. Base ratings are not overridable here because each size has its
                      own; adjust the extrapolation reduction in C2 instead, or enter the run
                      directly.
                    </div>
                    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                      <AutoField label="f_temp" auto={b.bT.auto ?? b.bT.value}
                        value={o.fTemp ?? null} onChange={(v) => setMvOv("fTemp", v)} />
                      <AutoField label="f_grp" auto={b.bG.auto ?? b.bG.value}
                        value={o.fGroup ?? null} onChange={(v) => setMvOv("fGroup", v)} />
                      <AutoField label="f_soil" auto={b.bS.auto ?? b.bS.value}
                        value={o.fSoil ?? null} onChange={(v) => setMvOv("fSoil", v)}
                        hint="varies by size in the table" />
                      <AutoField label="f_depth" auto={b.bD.auto ?? b.bD.value}
                        value={o.fDepth ?? null} onChange={(v) => setMvOv("fDepth", v)} />
                    </div>
                    {(b.bT.manual || b.bG.manual || b.bS.manual || b.bD.manual) && (
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 9,
                        font: "10.5px system-ui", color: HL.manual.text }}>
                        <span>
                          These ratings are no longer purely the standard&#8217;s. Record where the
                          entered figures came from.
                        </span>
                        <button className="btn" style={{ padding: "3px 10px" }}
                          onClick={() => set({ ...st, ov: { ...(st.ov || {}), [st.refInstall]: {} } })}>
                          Reset all to auto
                        </button>
                      </div>
                    )}
                  </div>
                  {design === 0 && (
                    <div style={{ font: "10.5px system-ui", color: C.muted, marginTop: 5 }}>
                      No run in the schedule uses {c.size} mm&#178; in
                      {" "}{st.refInstall === "duct" ? "duct" : "direct burial"}, so the design
                      current shows zero. The derating chain above is still the one that size
                      would get.
                    </div>
                  )}
                </div>

                <RefCard title={`Base rating, 3 × 1c aluminium XLPE 19/33 kV, trefoil`}
                  source="IEC 60502-2 Table B.3"
                  note={`Read at 20 °C ground, 1.5 K·m/W soil, 0.8 m deep, one circuit. Every factor below corrects away from those conditions. The 500 and 630 mm² rows are extrapolated, not IEC data.`}>
                  <TableCCC table={caps.map((x) => ({ size: x.size,
                    duct: x.extrap ? null : x.duct.base, direct: x.extrap ? null : x.direct.base }))}
                    size={c.size} install={st.refInstall}
                    methods={[{ value: "duct", label: "Buried duct" }, { value: "direct", label: "Direct buried" }]}
                    extrapolated={c.extrap ? b.base : null} />
                </RefCard>

                <RefCard emphasis={!b.bT.exact || b.bT.manual} title="Ground temperature factor"
                  source="IEC 60502-2 Table B.11" note="Base 20 °C.">
                  <Table1D table={MV_TEMP_GROUND} xLabel="Ground °C" yLabel="f_temp"
                    bracket={b.bT} dp={2} />
                </RefCard>

                <RefCard title="Grouping factor by circuit count and centre spacing"
                  source={st.refInstall === "duct" ? "IEC 60502-2 Table B.21" : "IEC 60502-2 Table B.19"}
                  note={`Looked up on ${circuits} circuit${circuits === 1 ? "" : "s"} at ${MV_SPACINGS.find((x) => x.value === spacing)?.label.toLowerCase()} centres. This is almost always the factor that costs the most capacity.`}>
                  <TableGroup rows={st.refInstall === "duct" ? MV_GROUP_DUCT : MV_GROUP_DIRECT}
                    cols={MV_SPACINGS} activeCol={spacing} circuits={circuits} bracket={b.bG} />
                </RefCard>

                {b.soilTable && (
                  <RefCard emphasis={!b.bS.exact || b.bS.manual} title={`Soil thermal resistivity, ${c.size} mm²`}
                    source={st.refInstall === "duct" ? "IEC 60502-2 Table B.15" : "IEC 60502-2 Table B.14"}
                    note="Base 1.5 K·m/W — not the 2.5 K·m/W base of the LV standard. The two are tabulated separately and a factor must never be carried across from the DC or AC tab.">
                    <Table1D table={b.soilTable} xLabel="K·m/W" yLabel="f_soil"
                      bracket={b.bS} dp={2} />
                  </RefCard>
                )}

                <RefCard emphasis={!b.bD.exact || b.bD.manual} title={`Burial depth, ${c.size <= 185 ? "≤185" : ">185"} mm²`}
                  source="IEC 60502-2 Tables B.12 / B.13" note="Base 0.8 m. Deeper is hotter, so the factor falls.">
                  <Table1D table={b.depthTable} xLabel="Depth m" yLabel="f_depth"
                    bracket={b.bD} dp={3} />
                </RefCard>
              </>
            );
          })()}
        </div>
      </Section>

      <Section code="C6" title="Cable schedule">
        <Num label="Spares allowance" unit="%" value={st.spares} step={5}
          onChange={(v) => set({ ...st, spares: v })} />
        <Scroll min={620}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead><tr>
              <Th>Size mm²</Th><Th>Runs</Th><Th>Total length m</Th><Th>With spares m</Th>
              <Th>Bill of materials description</Th>
            </tr></thead>
            <tbody>
              {bom.map((b) => (
                <tr key={b.size} style={{ borderTop: `1px solid ${C.line}` }}>
                  <Td>{b.size}</Td>
                  <Td dim>{b.count}</Td>
                  <Td>{fmt(b.len, 0)}</Td>
                  <Td><b>{fmt(b.withSpares, 0)}</b></Td>
                  <Td dim style={{ whiteSpace: "normal" }}>
                    3 × 1c {b.size} mm² aluminium XLPE 19/33 kV to IEC 60502-2, + {fmt(st.spares, 0)} % spares
                  </Td>
                </tr>
              ))}
              {bom.length > 0 && (
                <tr style={{ borderTop: `2px solid ${C.line}` }}>
                  <Td><b>Total</b></Td>
                  <Td dim>{bom.reduce((a, b) => a + b.count, 0)}</Td>
                  <Td><b>{fmt(totalLen, 0)}</b></Td>
                  <Td><b>{fmt(bom.reduce((a, b) => a + b.withSpares, 0), 0)}</b></Td>
                  <Td />
                </tr>
              )}
            </tbody>
          </table>
        </Scroll>
      </Section>
    </Page>
  );
}

/* =====================================================================
   4.  SHORT-CIRCUIT WITHSTAND

   The adiabatic check asks one question: does the conductor reach its
   permitted short-circuit temperature before the protection clears?
   Adiabatic means no heat leaves the conductor during the fault, which
   is true enough below about five seconds and conservative above it.

       S ≥ I·√t / k

   The tool derives k from the conductor material and the two
   temperatures rather than reading it from a table, so any insulation
   system or pre-fault loading can be evaluated and the derivation is
   visible.
   ===================================================================== */

/** Log-log withstand chart: cable curves against the fault point. */
function WithstandCurve({ curves, faultKA, tClear, sizeSel }) {
  const W = 560, H = 340, L = 56, R = W - 16, T = 16, B = H - 40;
  const tMin = 0.01, tMax = 10;
  const iMin = 0.1, iMax = Math.max(100, faultKA * 4);
  const lx = (i) => L + ((Math.log10(i) - Math.log10(iMin)) / (Math.log10(iMax) - Math.log10(iMin))) * (R - L);
  const ly = (t) => T + ((Math.log10(tMax) - Math.log10(t)) / (Math.log10(tMax) - Math.log10(tMin))) * (B - T);
  const decades = (lo, hi) => {
    const out = [];
    for (let d = Math.floor(Math.log10(lo)); d <= Math.ceil(Math.log10(hi)); d++) {
      for (let m = 1; m <= 9; m++) {
        const v = m * Math.pow(10, d);
        if (v >= lo && v <= hi) out.push({ v, major: m === 1 });
      }
    }
    return out;
  };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }}>
      <rect x="0" y="0" width={W} height={H} fill={C.paper} />
      {decades(iMin, iMax).map(({ v, major }) => (
        <g key={`x${v}`}>
          <line x1={lx(v)} y1={T} x2={lx(v)} y2={B} stroke={major ? C.gridMajor : C.grid} strokeWidth="1" />
          {major && <text x={lx(v)} y={B + 15} textAnchor="middle" fill={C.muted}
            style={{ font: "9.5px var(--mono)" }}>{v < 1 ? v : fmt(v, 0)}</text>}
        </g>
      ))}
      {decades(tMin, tMax).map(({ v, major }) => (
        <g key={`y${v}`}>
          <line x1={L} y1={ly(v)} x2={R} y2={ly(v)} stroke={major ? C.gridMajor : C.grid} strokeWidth="1" />
          {major && <text x={L - 6} y={ly(v) + 3} textAnchor="end" fill={C.muted}
            style={{ font: "9.5px var(--mono)" }}>{v < 1 ? v : fmt(v, 0)}</text>}
        </g>
      ))}
      {/* unsafe region: to the right of the selected cable's curve */}
      {curves.filter((c) => c.size === sizeSel).map((c) => {
        const pts = [];
        for (let e = Math.log10(tMin); e <= Math.log10(tMax) + 1e-9; e += 0.05) {
          const t = Math.pow(10, e);
          const i = c.kS / Math.sqrt(t) / 1000;
          pts.push(`${lx(Math.min(iMax, Math.max(iMin, i)))},${ly(t)}`);
        }
        return <polygon key="shade" points={`${pts.join(" ")} ${lx(iMax)},${ly(tMin)} ${lx(iMax)},${ly(tMax)}`}
          fill="#d64545" opacity="0.10" />;
      })}
      {curves.map((c) => {
        const pts = [];
        for (let e = Math.log10(tMin); e <= Math.log10(tMax) + 1e-9; e += 0.05) {
          const t = Math.pow(10, e);
          const i = c.kS / Math.sqrt(t) / 1000;
          if (i >= iMin && i <= iMax) pts.push(`${lx(i)},${ly(t)}`);
        }
        const sel = c.size === sizeSel;
        return (
          <g key={c.size}>
            <polyline points={pts.join(" ")} fill="none"
              stroke={sel ? C.accent : C.steel} strokeWidth={sel ? 2.2 : 1}
              opacity={sel ? 1 : 0.55} />
            {pts.length > 0 && (
              <text x={lx(Math.min(iMax, c.kS / Math.sqrt(tMax) / 1000)) + 5} y={ly(tMax) + 11}
                fill={sel ? C.accent : C.muted} style={{ font: `${sel ? 600 : 400} 9.5px var(--mono)` }}>
                {c.size}
              </text>
            )}
          </g>
        );
      })}
      {/* the fault */}
      {faultKA > iMin && tClear > tMin && (
        <>
          <line x1={lx(faultKA)} y1={T} x2={lx(faultKA)} y2={B}
            stroke="#d64545" strokeWidth="1.4" strokeDasharray="5 3" />
          <line x1={L} y1={ly(tClear)} x2={R} y2={ly(tClear)}
            stroke="#d64545" strokeWidth="1.4" strokeDasharray="5 3" />
          <circle cx={lx(faultKA)} cy={ly(tClear)} r="5.5" fill="#d64545" stroke="#fff" strokeWidth="1.2" />
          <text x={lx(faultKA) - 8} y={ly(tClear) - 10} textAnchor="end" fill="#e08a8a"
            style={{ font: "600 10px var(--mono)" }}>
            {fmt(faultKA, 1)} kA / {fmt(tClear, 2)} s
          </text>
        </>
      )}
      <text x={(L + R) / 2} y={H - 6} textAnchor="middle" fill={C.muted}
        style={{ font: "10px system-ui" }}>Prospective short-circuit current (kA)</text>
      <text x="12" y={(T + B) / 2} textAnchor="middle" fill={C.muted}
        transform={`rotate(-90 12 ${(T + B) / 2})`} style={{ font: "10px system-ui" }}>
        Clearing time (s)
      </text>
      <text x={R - 6} y={T + 12} textAnchor="end" fill={C.muted} style={{ font: "9.5px system-ui" }}>
        Below/left of a curve the cable survives
      </text>
    </svg>
  );
}

/** Cross-section with the temperature excursion the fault imposes. */
function CableSection({ size, insName, thetaI, thetaF, thetaReached, screen }) {
  const W = 300, H = 230;
  const cx = 108, cy = 100;
  const rCond = Math.max(20, Math.min(46, 13 * Math.sqrt(size / 3.14) + 12));
  const over = thetaReached > thetaF;
  const frac = Math.max(0, Math.min(1.15, (thetaReached - 20) / (thetaF - 20)));
  const barY = 176, barW = W - 40;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }}>
      <rect x="0" y="0" width={W} height={H} fill={C.paper} />
      <circle cx={cx} cy={cy} r={rCond + 26} fill="#2a2f38" stroke={C.line} />
      {screen && <circle cx={cx} cy={cy} r={rCond + 17} fill="none" stroke="#b98a3f" strokeWidth="3" strokeDasharray="4 3" />}
      <circle cx={cx} cy={cy} r={rCond + 12} fill="#2f2a1e" stroke={C.line} />
      <circle cx={cx} cy={cy} r={rCond}
        fill={over ? "#c04a3f" : C.accent} stroke={over ? "#ff9d92" : "#f0b070"} strokeWidth="1.5" />
      <text x={cx} y={cy + 4} textAnchor="middle" fill="#181206" style={{ font: "700 12px var(--mono)" }}>
        {size}
      </text>
      <g style={{ font: "9.5px system-ui" }}>
        <line x1={cx + rCond + 26} y1={cy - 30} x2={W - 96} y2={cy - 30} stroke={C.muted} />
        <text x={W - 92} y={cy - 27} fill={C.muted}>Oversheath</text>
        {screen && (<>
          <line x1={cx + rCond + 17} y1={cy - 8} x2={W - 96} y2={cy - 8} stroke="#b98a3f" />
          <text x={W - 92} y={cy - 5} fill="#c99b52">Screen</text>
        </>)}
        <line x1={cx + rCond + 12} y1={cy + 14} x2={W - 96} y2={cy + 14} stroke={C.muted} />
        <text x={W - 92} y={cy + 17} fill={C.muted}>{insName}</text>
        <line x1={cx} y1={cy + rCond} x2={cx} y2={cy + rCond + 22} stroke={C.muted} />
        <text x={cx - 12} y={cy + rCond + 33} fill={C.muted}>Conductor</text>
      </g>
      {/* temperature excursion */}
      <text x="20" y={barY - 8} fill={C.muted} style={{ font: "10px system-ui" }}>
        Conductor temperature during the fault
      </text>
      <rect x="20" y={barY} width={barW} height="12" rx="3" fill={C.panel2} />
      <rect x="20" y={barY} width={Math.min(barW, barW * frac)} height="12" rx="3"
        fill={over ? "#c04a3f" : "#59b56f"} />
      <line x1={20 + barW} y1={barY - 4} x2={20 + barW} y2={barY + 16} stroke={C.warn} strokeWidth="1.5" />
      <text x="20" y={barY + 30} fill={C.muted} style={{ font: "9.5px var(--mono)" }}>
        {fmt(thetaI, 0)} °C at fault inception
      </text>
      <text x={20 + barW} y={barY + 30} textAnchor="end" fill={over ? "#e08a8a" : "#7fc78f"}
        style={{ font: "600 9.5px var(--mono)" }}>
        reaches {fmt(thetaReached, 0)} °C / limit {fmt(thetaF, 0)} °C
      </text>
    </svg>
  );
}

/** Where the fault current comes from, and which cable sees it. */
function FaultPath({ level, gridKA, txKA, invKA, totalKA }) {
  const W = 620, H = 190;
  const box = (x, y, w, h, fill, stroke) => (
    <rect x={x} y={y} width={w} height={h} rx="4" fill={fill} stroke={stroke} strokeWidth="1.3" />
  );
  const at = { mv: 300, ac: 430, dc: 556 }[level] ?? 300;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }}>
      <rect x="0" y="0" width={W} height={H} fill={C.paper} />
      {/* grid */}
      <g>
        {box(18, 62, 66, 40, "#232a34", C.navyLight)}
        <text x={51} y={80} textAnchor="middle" fill={C.navyLight} style={{ font: "600 10px system-ui" }}>GRID</text>
        <text x={51} y={94} textAnchor="middle" fill={C.muted} style={{ font: "9.5px var(--mono)" }}>
          {fmt(gridKA, 1)} kA
        </text>
      </g>
      <line x1="84" y1="82" x2="140" y2="82" stroke={C.steel} strokeWidth="1.6" />
      {/* transformer */}
      <g>
        <circle cx="158" cy="72" r="17" fill="none" stroke="#3d95ea" strokeWidth="1.6" />
        <circle cx="158" cy="92" r="17" fill="none" stroke="#3d95ea" strokeWidth="1.6" />
        <text x="158" y="130" textAnchor="middle" fill={C.muted} style={{ font: "9.5px system-ui" }}>
          MV/LV tx
        </text>
      </g>
      <line x1="176" y1="82" x2="240" y2="82" stroke={C.steel} strokeWidth="1.6" />
      {/* MV busbar */}
      <line x1="240" y1="40" x2="240" y2="124" stroke={C.accent} strokeWidth="3" />
      <text x="240" y="32" textAnchor="middle" fill={C.accent} style={{ font: "600 9.5px system-ui" }}>MV ring</text>
      <line x1="240" y1="82" x2="372" y2="82" stroke={C.steel} strokeWidth="1.6" />
      {/* inverter transformer */}
      <g>
        <circle cx="390" cy="72" r="16" fill="none" stroke="#3d95ea" strokeWidth="1.6" />
        <circle cx="390" cy="92" r="16" fill="none" stroke="#3d95ea" strokeWidth="1.6" />
        <text x="390" y="130" textAnchor="middle" fill={C.muted} style={{ font: "9.5px system-ui" }}>
          {fmt(txKA, 1)} kA thro'
        </text>
      </g>
      <line x1="406" y1="82" x2="470" y2="82" stroke={C.steel} strokeWidth="1.6" />
      {/* inverter */}
      <g>
        {box(470, 62, 58, 40, "#1e2a22", "#3fb457")}
        <text x={499} y={80} textAnchor="middle" fill="#3fb457" style={{ font: "600 10px system-ui" }}>INV</text>
        <text x={499} y={94} textAnchor="middle" fill={C.muted} style={{ font: "9.5px var(--mono)" }}>
          {fmt(invKA, 2)} kA
        </text>
      </g>
      <line x1="528" y1="82" x2="580" y2="82" stroke={C.steel} strokeWidth="1.6" />
      <g>
        {box(580, 66, 26, 32, "#2a2118", C.moduleRed)}
        <text x={593} y={112} textAnchor="middle" fill={C.muted} style={{ font: "9px system-ui" }}>PV</text>
      </g>
      {/* fault marker */}
      <g>
        <line x1={at} y1="82" x2={at} y2="150" stroke="#d64545" strokeWidth="1.6" strokeDasharray="4 3" />
        <path d={`M${at - 8} 150 L${at + 8} 150 M${at} 150 l-6 -8 M${at} 150 l6 -8`}
          stroke="#d64545" strokeWidth="2" fill="none" />
        <circle cx={at} cy="82" r="5" fill="#d64545" />
        <text x={at} y="170" textAnchor="middle" fill="#e08a8a" style={{ font: "600 10px var(--mono)" }}>
          fault — {fmt(totalKA, 1)} kA
        </text>
      </g>
    </svg>
  );
}

export function ShortCircuitTab({ mod, inv, elec, st, set }) {
  const level = st.level;
  const U = level === "mv" ? st.uMv * 1000 : st.uLv;   // volts
  const c = level === "mv" ? 1.1 : 1.05;               // IEC 60909 voltage factor

  /* ---- fault level ---- */
  const zGrid = st.skMva > 0 ? (c * U * U) / (st.skMva * 1e6) : Infinity;
  const zTx = st.txKva > 0 && st.uk > 0 ? ((st.uk / 100) * U * U) / (st.txKva * 1000) : 0;
  // zGrid is already evaluated at U, so on the LV side it is the grid
  // impedance referred through the transformer and simply adds to Z_tx.
  const zTotal = level === "mv" ? zGrid : zGrid + zTx;
  const ikGrid = zGrid === Infinity ? 0 : (c * U) / (Math.sqrt(3) * zGrid) / 1000;
  const ikTx = zTotal > 0 ? (c * U) / (Math.sqrt(3) * zTotal) / 1000 : 0;
  const ikNetwork = level === "mv" ? ikGrid : ikTx;
  const iInvRated = inv.acKva ? (inv.acKva * 1000) / (Math.sqrt(3) * (inv.vAc || 800)) : 0;
  // Inverters sit on the LV side. Seen from the MV ring their contribution
  // is divided by the turns ratio, the same way any current refers across.
  const referral = level === "mv" ? st.uLv / U : 1;
  const ikInv = (st.nInv * iInvRated * st.invFactor * referral) / 1000;
  const ikTotal = st.ikOv ?? (ikNetwork + ikInv);

  const kappa = peakFactor(st.rOverX);
  const ip = kappa * Math.SQRT2 * ikTotal;
  const m = dcHeatFactor(kappa, st.freq, st.t);
  const ith = ikTotal * Math.sqrt(m + 1);

  /* ---- adiabatic ---- */
  const mat = CONDUCTOR[st.material];
  const ins = INSULATION[st.insulation];
  const thetaI = st.thetaI ?? ins.cont;
  const K = materialK(mat);
  const k = adiabaticK(mat, thetaI, ins.sc);
  const iUse = (st.useIth ? ith : ikTotal) * 1000;      // A
  const perCond = iUse / Math.max(1, st.par);
  const sMin = (perCond * Math.sqrt(st.t)) / k;
  const sInst = st.size * Math.max(1, st.par);
  const iWithstand1s = (k * st.size) / 1000;            // kA for 1 s per conductor
  const tMax = perCond > 0 ? Math.pow((k * st.size) / perCond, 2) : Infinity;
  const pass = st.size >= (perCond * Math.sqrt(st.t)) / k;
  /* Temperature actually reached, by inverting the adiabatic equation. */
  const thetaReached = (mat.beta + thetaI)
    * Math.exp(Math.pow(perCond * Math.sqrt(st.t) / (materialK(mat) * st.size), 2)) - mat.beta;

  /* ---- screen / armour earth fault ---- */
  const scrMat = CONDUCTOR[st.scrMaterial];
  const kScr = adiabaticK(scrMat, st.scrThetaI, st.scrThetaF);
  const sMinScr = (st.iEarth * 1000 * Math.sqrt(st.tEarth)) / kScr;
  const scrPass = st.scrArea >= sMinScr;

  /* ---- DC side ---- */
  const dcFault = 1.25 * mod.isc * Math.max(0, st.dcStrings - 1);
  const dcSmin = (dcFault * Math.sqrt(st.dcT)) / adiabaticK(CONDUCTOR.copper, 90, 250);

  const curves = useMemo(() => {
    const sizes = [4, 6, 16, 35, 70, 120, 185, 300, 400, 630];
    if (!sizes.includes(st.size)) sizes.push(st.size);
    return sizes.sort((a, b) => a - b).map((s) => ({ size: s, kS: k * s }));
  }, [k, st.size]);

  return (
    <Page wide>
      <div className="tbl" style={{ marginBottom: 10 }}>
        SHORT-CIRCUIT WITHSTAND — IEC 60949 ADIABATIC CHECK, IEC 60909 FAULT LEVELS
      </div>
      <div className="readout" style={{ marginBottom: 12 }}>
        A cable sized only for load current and volt drop can still be destroyed by a fault it
        has to hold for a few hundred milliseconds. The check is thermal, not mechanical: the
        conductor must not exceed the temperature at which its insulation is damaged before the
        protection clears. <b>Nothing about normal operation reveals a failure of this check</b>
        {" "}— the cable runs perfectly until the day it does not.
      </div>

      <Section code="S1" title="Where the fault current comes from">
        <Sel label="Fault location" value={st.level} onChange={(v) => set({ ...st, level: v })}
          options={[
            { value: "mv", label: "MV collector / ring" },
            { value: "ac", label: "LV AC — inverter to transformer" },
            { value: "dc", label: "DC array side" },
          ]} />
        <Num label="MV system voltage" unit="kV" value={st.uMv} step={1}
          onChange={(v) => set({ ...st, uMv: v })} />
        <Num label="LV system voltage" unit="V" value={st.uLv} step={5}
          onChange={(v) => set({ ...st, uLv: v })} />
        <Num label="Grid fault level at POC" unit="MVA" value={st.skMva} step={10}
          onChange={(v) => set({ ...st, skMva: v })} />
        <Num label="Transformer rating" unit="kVA" value={st.txKva} step={50}
          onChange={(v) => set({ ...st, txKva: v })} />
        <Num label="Transformer impedance uk" unit="%" value={st.uk} step={0.5}
          onChange={(v) => set({ ...st, uk: v })} />
        <Num label="Inverters contributing" value={st.nInv} step={1} min={0}
          onChange={(v) => set({ ...st, nInv: v })} />
        <Num label="Inverter fault contribution" unit="× I_rated" value={st.invFactor} step={0.05}
          onChange={(v) => set({ ...st, invFactor: v })} />
        <div style={{ width: "100%", background: C.paper, border: `1px solid ${C.line}`,
          borderRadius: 6, padding: 8 }}>
          <FaultPath level={level} gridKA={ikGrid} txKA={ikNetwork} invKA={ikInv} totalKA={ikTotal} />
        </div>
        <Working n="S1a" title="Network contribution"
          formula={level === "mv" ? "I″k = c·U / (√3·Z_grid),  Z_grid = c·U² / S″k"
            : "I″k = c·U / (√3·(Z_grid + Z_tx)),  Z_tx = (uk/100)·U² / S_tx"}
          sub={level === "mv"
            ? `1.1 × ${fmt(st.uMv, 0)} kV over Z = ${fmt(zGrid, 3)} Ω from ${fmt(st.skMva, 0)} MVA`
            : `1.05 × ${fmt(st.uLv, 0)} V over Z = ${fmt(zTotal * 1000, 2)} mΩ (${fmt(zTx * 1000, 2)} mΩ of it the transformer)`}
          result={fmt(ikNetwork, 2)} unit="kA"
          why="The voltage factor c (1.1 on MV, 1.05 on LV) covers the highest voltage the system is allowed to sit at, tap changer position and load flow. On the LV side the transformer impedance dominates completely — a 1 MVA unit at 6 % uk limits the fault to roughly 24 kA however stiff the grid behind it is." />
        <Working n="S1b" title="Inverter contribution"
          formula="I_inv = n × I_rated × k_inv"
          sub={`${st.nInv} × ${fmt(iInvRated, 0)} A × ${fmt(st.invFactor, 2)}${level === "mv" ? ` × ${fmt(referral, 3)} turns ratio` : ""}`}
          result={fmt(ikInv, 2)} unit="kA"
          why="A grid-forming or grid-following inverter is a current source, not a voltage source behind an impedance: it cannot deliver several times its rating the way a synchronous machine can. Typical limits are 1.1 to 1.2 × rated for a few cycles before the controller trips. This is why PV plants have modest fault levels — and why protection grading on a PV collector network is harder than on a conventional network, not easier." />
        <Working n="S1c" title="Peak and thermal equivalent current"
          formula="κ = 1.02 + 0.98·e^(−3R/X);  i_p = κ√2·I″k;  I_th = I″k·√(m + n)"
          sub={`R/X = ${fmt(st.rOverX, 2)} → κ = ${fmt(kappa, 3)}, m = ${fmt(m, 3)}, n = 1`}
          result={`i_p ${fmt(ip, 1)} kA,  I_th ${fmt(ith, 2)}`} unit="kA"
          why="i_p is the mechanical duty — what the busbar bracing and the switchgear making capacity have to survive. I_th is the thermal duty, and it is what the cable check should use: m accounts for the heat in the decaying d.c. offset, which matters for fast clearing and is negligible above about half a second." />
      </Section>

      <Section code="S2" title="Adiabatic conductor check">
        <Sel label="Conductor material" value={st.material}
          onChange={(v) => set({ ...st, material: v })}
          options={[{ value: "copper", label: "Copper" }, { value: "aluminium", label: "Aluminium" }]} />
        <Sel label="Insulation" value={st.insulation}
          onChange={(v) => set({ ...st, insulation: v, thetaI: INSULATION[v].cont })}
          options={Object.entries(INSULATION).map(([k2, v]) => ({ value: k2, label: v.name }))} />
        <Num label="Temperature at fault inception" unit="°C" value={thetaI} step={5}
          onChange={(v) => set({ ...st, thetaI: v })} />
        <Num label="Fault clearing time" unit="s" value={st.t} step={0.05} min={0.01}
          onChange={(v) => set({ ...st, t: v })} />
        <Num label="Fault current override" unit="kA" value={st.ikOv ?? 0} step={0.5}
          onChange={(v) => set({ ...st, ikOv: v > 0 ? v : null })} />
        <Sel label="Current used for the check" value={st.useIth ? "ith" : "ik"}
          onChange={(v) => set({ ...st, useIth: v === "ith" })}
          options={[{ value: "ith", label: "I_th (with d.c. component)" },
            { value: "ik", label: "I″k (symmetrical only)" }]} />
        <Sel label="Installed size" value={String(st.size)}
          onChange={(v) => set({ ...st, size: Number(v) })}
          options={[1.5, 2.5, 4, 6, 10, 16, 25, 35, 50, 70, 95, 120, 150, 185, 240, 300, 400, 500, 630]
            .map((s) => ({ value: String(s), label: `${s} mm²` }))} />
        <Num label="Conductors in parallel per pole" value={st.par} step={1} min={1}
          onChange={(v) => set({ ...st, par: v })} />
        <Num label="R/X at the fault" value={st.rOverX} step={0.05} min={0}
          onChange={(v) => set({ ...st, rOverX: v })} />
        <Num label="System frequency" unit="Hz" value={st.freq} step={10}
          onChange={(v) => set({ ...st, freq: v })} />

        <Working n="S2a" title="Material constant"
          formula="K = √( Q_c·(β + 20) / ρ₂₀ )"
          sub={`√( ${mat.Qc} J/K·mm³ × (${mat.beta} + 20) / ${(mat.rho20 * 1e6).toFixed(3)}e−6 Ω·mm )`}
          result={fmt(K, 1)} unit="A·√s/mm²"
          why="A property of the metal alone — 226 for copper, 148 for aluminium. It says how much charge a square millimetre can pass per root-second per degree of allowable rise, and it is the reason aluminium needs roughly 1.5 times the area of copper to survive the same fault." />
        <Working n="S2b" title="Adiabatic constant k"
          formula="k = K · √( ln((β + θ_f) / (β + θ_i)) )"
          sub={`${fmt(K, 1)} × √( ln((${mat.beta} + ${fmt(ins.sc, 0)}) / (${mat.beta} + ${fmt(thetaI, 0)})) )`}
          result={fmt(k, 1)} unit="A·√s/mm²"
          why={`Copper in XLPE from 90 °C to 250 °C gives 143 and aluminium 94 — the tabulated values in IEC 60364-5-54, reproduced here from the physics rather than looked up, so a cable that is only lightly loaded when the fault arrives (a lower θ_i) correctly gets credit for the extra headroom. The current θ_i of ${fmt(thetaI, 0)} °C assumes the cable was ${thetaI >= ins.cont ? "at full load" : "part loaded"} at fault inception.`} />
        <Working n="S2c" title="Minimum conductor area"
          formula="S_min = I · √t / k"
          sub={`${fmt(perCond / 1000, 2)} kA × √${fmt(st.t, 2)} s / ${fmt(k, 1)}`}
          result={fmt(sMin, 1)} unit="mm²"
          status={pass ? "OK" : "Undersized"}
          why={`Installed ${st.size} mm²${st.par > 1 ? ` × ${st.par} in parallel = ${sInst} mm² total` : ""}, so the margin is ${fmt(st.size - sMin, 1)} mm² per conductor. Note the √t: halving the clearing time only reduces the required area by 29 %, so protection speed buys less than intuition suggests — and doubling the fault current costs a full doubling of area.`} />
        <Working n="S2d" title="Temperature actually reached"
          formula="θ_f = (β + θ_i)·exp[ (I√t / (K·S))² ] − β"
          sub={`(${mat.beta} + ${fmt(thetaI, 0)}) × exp[ (${fmt(perCond / 1000, 2)} kA × √${fmt(st.t, 2)} / (${fmt(K, 0)} × ${st.size}))² ] − ${mat.beta}`}
          result={fmt(thetaReached, 0)} unit="°C"
          status={thetaReached <= ins.sc ? "OK" : "Over limit"}
          why={`The limit for ${ins.name} is ${fmt(ins.sc, 0)} °C. Above it the insulation does not necessarily fail at once — it loses mechanical strength, the conductor moves, and the cable fails later at a joint or a bend, which is why this check has to pass on paper rather than being proved in service.`} />
        <Working n="S2e" title="Withstand rating and maximum clearing time"
          formula="I_1s = k·S / 1000;   t_max = (k·S / I)²"
          sub={`k ${fmt(k, 1)} × ${st.size} mm²`}
          result={`${fmt(iWithstand1s, 1)} kA for 1 s,  t_max ${fmt(tMax, 3)} s`}
          status={tMax >= st.t ? "OK" : "Too slow"}
          why={`The one-second rating is the number cable schedules quote. Maximum permitted clearing time at ${fmt(perCond / 1000, 1)} kA is ${fmt(tMax, 3)} s against the ${fmt(st.t, 2)} s assumed — that difference is the protection engineer's grading margin, and it has to survive the slowest credible backup stage, not just the fastest main one.`} />

        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", width: "100%" }}>
          <div style={{ flex: "2 1 420px", minWidth: 320, background: C.paper,
            border: `1px solid ${C.line}`, borderRadius: 6, padding: 8 }}>
            <WithstandCurve curves={curves} faultKA={perCond / 1000} tClear={st.t} sizeSel={st.size} />
          </div>
          <div style={{ flex: "1 1 260px", minWidth: 250, background: C.paper,
            border: `1px solid ${C.line}`, borderRadius: 6, padding: 8 }}>
            <CableSection size={st.size} insName={ins.name} thetaI={thetaI} thetaF={ins.sc}
              thetaReached={thetaReached} screen={level === "mv"} />
          </div>
        </div>
        <div className="readout">
          Each curve is <b>I = k·S / √t</b> for one size — a straight line of slope −½ on log-log
          axes. The fault point must sit <b>below and to the left</b> of the curve for the size
          you have installed; the shaded region to its right is where the conductor exceeds its
          temperature limit. Moving up a size shifts the whole curve right by the size ratio,
          which is why upsizing is a far more effective remedy than shaving milliseconds off the
          protection.
        </div>
      </Section>

      <Section code="S3" title="Screen and armour — earth fault">
        <Sel label="Screen material" value={st.scrMaterial}
          onChange={(v) => set({ ...st, scrMaterial: v })}
          options={[{ value: "copper", label: "Copper wire screen" },
            { value: "aluminium", label: "Aluminium tape / wire" },
            { value: "steel", label: "Steel wire armour" },
            { value: "lead", label: "Lead sheath" }]} />
        <Num label="Screen cross-section" unit="mm²" value={st.scrArea} step={1}
          onChange={(v) => set({ ...st, scrArea: v })} />
        <Num label="Earth fault current" unit="kA" value={st.iEarth} step={0.5}
          onChange={(v) => set({ ...st, iEarth: v })} />
        <Num label="Earth fault clearing time" unit="s" value={st.tEarth} step={0.05}
          onChange={(v) => set({ ...st, tEarth: v })} />
        <Num label="Screen initial temperature" unit="°C" value={st.scrThetaI} step={5}
          onChange={(v) => set({ ...st, scrThetaI: v })} />
        <Num label="Screen final temperature" unit="°C" value={st.scrThetaF} step={5}
          onChange={(v) => set({ ...st, scrThetaF: v })} />
        <Working n="S3a" title="Screen withstand"
          formula="S_screen ≥ I_earth · √t / k_screen"
          sub={`${fmt(st.iEarth, 1)} kA × √${fmt(st.tEarth, 2)} s / ${fmt(kScr, 1)}`}
          result={fmt(sMinScr, 1)} unit="mm²"
          status={scrPass ? "OK" : "Undersized"}
          why={`Installed screen is ${fmt(st.scrArea, 0)} mm². The screen usually governs on an MV cable, not the conductor: a 240 mm² aluminium core with a 25 mm² copper screen has a phase withstand of about 22 kA for one second and a screen withstand of about 3.5 kA, so a solidly earthed system with a high earth fault level needs the screen sized deliberately rather than taken as standard. The screen starts cooler than the conductor, which is why its initial temperature is a separate input — IEC 60949 also permits a non-adiabatic credit for screens, which this check does not claim, so the answer here is on the safe side.`} />
      </Section>

      <Section code="S4" title="DC array side">
        <Num label="Strings in parallel on the combiner" value={st.dcStrings} step={1} min={1}
          onChange={(v) => set({ ...st, dcStrings: v })} />
        <Num label="DC fault clearing time" unit="s" value={st.dcT} step={0.1}
          onChange={(v) => set({ ...st, dcT: v })} />
        <Working n="S4a" title="Backfeed into a faulted string"
          formula="I_fault = 1.25 × Isc × (N_parallel − 1)"
          sub={`1.25 × ${fmt(mod.isc, 2)} A × (${st.dcStrings} − 1)`}
          result={fmt(dcFault, 1)} unit="A"
          why="The DC side has no fault current worth the name from the array's own string — a shorted PV string delivers barely more than its operating current. The hazard is the other strings on the same busbar backfeeding into the faulted one, which is exactly what string fuses exist to interrupt and why IEC 62548 requires them once more than two strings are paralleled." />
        <Working n="S4b" title="Minimum string cable area for the backfeed"
          formula="S_min = I_fault · √t / k"
          sub={`${fmt(dcFault, 0)} A × √${fmt(st.dcT, 2)} s / 143`}
          result={fmt(dcSmin, 2)} unit="mm²"
          why="Copper in XLPO from 90 °C to 250 °C, k = 143. This is nearly always trivially satisfied by the 4 or 6 mm² the ampacity check demands — which is the point: on the DC side the fuse rating and the ampacity govern, and the adiabatic check is there to confirm it rather than to size anything. It stops being trivial on the array cable downstream of a large combiner." />
      </Section>
    </Page>
  );
}
