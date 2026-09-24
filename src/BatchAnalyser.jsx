/* =====================================================================
   PVSYST BATCH ANALYSER  —  the tab

   Drop in a batch results CSV, read the answer. All the maths lives in
   batchAnalyser.js; nothing here decides anything, it draws what that
   module returns.

   Charts are hand-rolled SVG, like every other chart in PVhub. Hover
   values come from SVG <title> elements, which the browser renders as
   native tooltips: no tooltip state, no layout to go wrong, and it works
   on touch through a long press.

   The decision chart is number 4. Everything above it is context and
   everything below it is diagnosis.
   ===================================================================== */

import React, { useState, useMemo, useRef } from "react";
import { fmt, C, Num, Section, Page } from "./ui.jsx";
import {
  parseBatchCsv, analyseBatch, buildRecommendation, toCsv, fmtEnergy,
  ANALYSIS_DEFAULTS,
} from "./batchAnalyser.js";

/* A categorical ramp that stays distinguishable on the dark ground and
   does not lean on red or green, which mean pass and fail elsewhere. */
const SERIES = ["#e8820c", "#4f9fe0", "#8c6fd0", "#3fb0a0", "#d1699a", "#9aa832", "#c9772f"];
const colourFor = (i) => SERIES[i % SERIES.length];

/* ---------------------------------------------------------------
   Chart scaffolding
   --------------------------------------------------------------- */

/* One axis pair, shared by every line and bar chart below, so the ticks,
   labels and gridlines are defined once rather than six times. */
function Frame({ w, h, m, xTicks, yTicks, xLabel, yLabel, fmtX, fmtY, children }) {
  const x0 = m.l, x1 = w - m.r, y0 = h - m.b, y1 = m.t;
  return (
    <>
      <rect x="0" y="0" width={w} height={h} fill={C.paper} />
      {yTicks.map((t) => (
        <g key={`y${t.v}`}>
          <line x1={x0} y1={t.p} x2={x1} y2={t.p} stroke={t.zero ? C.gridMajor : C.grid} strokeWidth="1" />
          <text x={x0 - 6} y={t.p + 3} textAnchor="end" fill={C.muted} style={{ font: "9.5px var(--mono)" }}>
            {fmtY ? fmtY(t.v) : t.v}
          </text>
        </g>
      ))}
      {xTicks.map((t) => (
        <g key={`x${t.v}`}>
          <line x1={t.p} y1={y1} x2={t.p} y2={y0} stroke={C.grid} strokeWidth="1" />
          <text x={t.p} y={y0 + 14} textAnchor="middle" fill={C.muted} style={{ font: "9.5px var(--mono)" }}>
            {fmtX ? fmtX(t.v) : t.v}
          </text>
        </g>
      ))}
      {children}
      <text x={(x0 + x1) / 2} y={h - 4} textAnchor="middle" fill={C.muted} style={{ font: "10px system-ui" }}>
        {xLabel}
      </text>
      <text x={11} y={(y0 + y1) / 2} textAnchor="middle" fill={C.muted}
        transform={`rotate(-90 11 ${(y0 + y1) / 2})`} style={{ font: "10px system-ui" }}>
        {yLabel}
      </text>
    </>
  );
}

/** Evenly spaced ticks across a numeric range. */
function makeTicks(lo, hi, n, scale) {
  if (!(hi > lo)) return [{ v: lo, p: scale(lo) }];
  const out = [];
  for (let i = 0; i <= n; i++) {
    const v = lo + ((hi - lo) * i) / n;
    out.push({ v, p: scale(v), zero: Math.abs(v) < 1e-9 });
  }
  return out;
}

/** Legend row, shared by the charts that carry more than one series. */
function Legend({ items }) {
  return (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 6 }}>
      {items.map((it) => (
        <span key={it.label} style={{ display: "flex", alignItems: "center", gap: 5,
          font: "10.5px system-ui", color: C.muted }}>
          <span style={{ width: 14, height: 0, borderTop: `${it.width || 2}px ${it.dash ? "dashed" : "solid"} ${it.colour}`,
            display: "inline-block" }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

/* A chart in a card, with its own PNG download. Serialising the SVG and
   painting it onto a canvas keeps the export offline; nothing is sent
   anywhere to make a picture. */
function ChartCard({ title, subtitle, children, legend, filename }) {
  const ref = useRef(null);
  const savePng = () => {
    const svg = ref.current?.querySelector("svg");
    if (!svg) return;
    const clone = svg.cloneNode(true);
    const vb = (svg.getAttribute("viewBox") || "0 0 800 400").split(/\s+/).map(Number);
    const scale = 2;                       // readable when dropped into a report
    clone.setAttribute("width", vb[2] * scale);
    clone.setAttribute("height", vb[3] * scale);
    const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement("canvas");
      cv.width = vb[2] * scale; cv.height = vb[3] * scale;
      const ctx = cv.getContext("2d");
      ctx.fillStyle = C.paper;
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      cv.toBlob((b) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(b);
        a.download = `${filename}.png`;
        a.click();
        URL.revokeObjectURL(a.href);
      });
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  };
  return (
    <div style={{ width: "100%", background: C.panel, border: `1px solid ${C.line}`,
      borderRadius: 6, padding: "10px 12px 12px", marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
        <div style={{ font: "600 12px system-ui", color: C.text }}>{title}</div>
        <div style={{ font: "10.5px system-ui", color: C.muted, flex: 1 }}>{subtitle}</div>
        <button className="btn" style={{ padding: "3px 9px", fontSize: 11 }} onClick={savePng}>PNG</button>
      </div>
      <div ref={ref} style={{ background: C.paper, borderRadius: 4, overflow: "hidden" }}>{children}</div>
      {legend ? <Legend items={legend} /> : null}
    </div>
  );
}

/* ---------------------------------------------------------------
   1. E_Grid against tilt, one line per pitch
   --------------------------------------------------------------- */
function ChartEgridVsTilt({ a }) {
  const w = 720, h = 330, m = { l: 62, r: 16, t: 16, b: 34 };
  const vals = a.cells.map((c) => c.eGridMwh);
  const lo = Math.min(...vals) * 0.999, hi = Math.max(...vals) * 1.001;
  const X = (t) => m.l + ((t - a.tilts[0]) / Math.max(1e-9, a.tilts[a.tilts.length - 1] - a.tilts[0])) * (w - m.l - m.r);
  const Y = (v) => (h - m.b) - ((v - lo) / Math.max(1e-9, hi - lo)) * (h - m.b - m.t);
  const bandTop = Y(a.globalMax.eGridMwh), bandBot = Y(a.globalMax.eGridMwh - a.toleranceMwh);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ display: "block" }}>
      <Frame w={w} h={h} m={m}
        xTicks={a.tilts.map((t) => ({ v: t, p: X(t) }))}
        yTicks={makeTicks(lo, hi, 5, Y)}
        xLabel="Tilt (deg)" yLabel="E_Grid (MWh/yr)"
        fmtY={(v) => fmt(v, 0)}>
        <rect x={m.l} y={bandTop} width={w - m.l - m.r} height={Math.max(1, bandBot - bandTop)}
          fill="#59b56f" opacity="0.13" />
        {a.pitches.map((p, i) => {
          const pts = a.tilts.map((t) => ({ t, c: a.at(t, p) })).filter((x) => x.c);
          return (
            <g key={p}>
              <polyline fill="none" stroke={colourFor(i)} strokeWidth="1.8"
                points={pts.map((x) => `${X(x.t)},${Y(x.c.eGridMwh)}`).join(" ")} />
              {pts.map((x) => (
                <circle key={x.t} cx={X(x.t)} cy={Y(x.c.eGridMwh)} r="3" fill={colourFor(i)}>
                  <title>{`${x.t}° at ${p} m: ${fmtEnergy(x.c.eGridMwh)}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
        <circle cx={X(a.globalMax.tilt)} cy={Y(a.globalMax.eGridMwh)} r="6.5" fill="none"
          stroke="#fff" strokeWidth="2">
          <title>{`Global maximum: ${a.globalMax.tilt}° at ${a.globalMax.pitch} m, ${fmtEnergy(a.globalMax.eGridMwh)}`}</title>
        </circle>
      </Frame>
    </svg>
  );
}

/* ---------------------------------------------------------------
   2. Heatmap
   --------------------------------------------------------------- */
function ChartHeatmap({ a }) {
  const cw = 78, ch = 30, m = { l: 62, r: 16, t: 26, b: 34 };
  const w = m.l + a.pitches.length * cw + m.r;
  const h = m.t + a.tilts.length * ch + m.b;
  const vals = a.cells.map((c) => c.eGridMwh);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const shade = (v) => {
    const f = (v - lo) / Math.max(1e-9, hi - lo);
    // A single-hue ramp: darker is worse, and the accent marks the best.
    return `rgba(232,130,12,${(0.10 + 0.78 * f).toFixed(3)})`;
  };
  const isTie = (c) => a.ties.some((t) => t.tilt === c.tilt && t.pitch === c.pitch);
  const rec = a.recommended;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ display: "block" }}>
      <rect x="0" y="0" width={w} height={h} fill={C.paper} />
      {a.pitches.map((p, j) => (
        <text key={p} x={m.l + j * cw + cw / 2} y={m.t - 9} textAnchor="middle" fill={C.muted}
          style={{ font: "9.5px var(--mono)" }}>{p}</text>
      ))}
      {a.tilts.map((t, i) => (
        <text key={t} x={m.l - 8} y={m.t + i * ch + ch / 2 + 3} textAnchor="end" fill={C.muted}
          style={{ font: "9.5px var(--mono)" }}>{t}&#176;</text>
      ))}
      {a.tilts.map((t, i) => a.pitches.map((p, j) => {
        const c = a.at(t, p);
        const x = m.l + j * cw, y = m.t + i * ch;
        if (!c) {
          return (
            <g key={`${t}|${p}`}>
              <rect x={x} y={y} width={cw - 2} height={ch - 2} fill="#1a1d23" stroke={C.line} strokeDasharray="2 2" />
              <text x={x + cw / 2} y={y + ch / 2 + 3} textAnchor="middle" fill={C.muted}
                style={{ font: "9.5px var(--mono)" }}>no run</text>
            </g>
          );
        }
        const tie = isTie(c);
        const isRec = rec && c.tilt === a.preferredTiltActual && c.pitch === rec.pitch;
        return (
          <g key={`${t}|${p}`}>
            <rect x={x} y={y} width={cw - 2} height={ch - 2} fill={shade(c.eGridMwh)}
              stroke={tie ? "#59b56f" : isRec ? "#fff" : "transparent"} strokeWidth={tie || isRec ? 2 : 0}>
              <title>{`${t}° at ${p} m: ${fmtEnergy(c.eGridMwh)}${tie ? "  (within tolerance of the maximum)" : ""}`
                + `${isRec ? "  (recommended at the preferred tilt)" : ""}`}</title>
            </rect>
            <text x={x + cw / 2} y={y + ch / 2 + 3.5} textAnchor="middle" fill={C.text}
              style={{ font: "10px var(--mono)", pointerEvents: "none" }}>
              {(c.eGridMwh / 1000).toFixed(2)}
            </text>
          </g>
        );
      }))}
      <text x={(m.l + w - m.r) / 2} y={h - 6} textAnchor="middle" fill={C.muted}
        style={{ font: "10px system-ui" }}>Pitch (m), cells in GWh/yr</text>
      <text x={11} y={h / 2} textAnchor="middle" fill={C.muted}
        transform={`rotate(-90 11 ${h / 2})`} style={{ font: "10px system-ui" }}>Tilt (deg)</text>
    </svg>
  );
}

/* ---------------------------------------------------------------
   3. E_Grid against pitch, one line per tilt
   --------------------------------------------------------------- */
function ChartEgridVsPitch({ a }) {
  const w = 720, h = 330, m = { l: 62, r: 16, t: 16, b: 34 };
  const vals = a.cells.map((c) => c.eGridMwh);
  const lo = Math.min(...vals) * 0.999, hi = Math.max(...vals) * 1.001;
  const P = a.pitches;
  const X = (p) => m.l + ((p - P[0]) / Math.max(1e-9, P[P.length - 1] - P[0])) * (w - m.l - m.r);
  const Y = (v) => (h - m.b) - ((v - lo) / Math.max(1e-9, hi - lo)) * (h - m.b - m.t);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ display: "block" }}>
      <Frame w={w} h={h} m={m}
        xTicks={P.map((p) => ({ v: p, p: X(p) }))}
        yTicks={makeTicks(lo, hi, 5, Y)}
        xLabel="Pitch (m)" yLabel="E_Grid (MWh/yr)"
        fmtY={(v) => fmt(v, 0)}>
        {a.tilts.map((t, i) => {
          const pts = P.map((p) => ({ p, c: a.at(t, p) })).filter((x) => x.c);
          const pref = t === a.preferredTiltActual;
          return (
            <g key={t}>
              <polyline fill="none" stroke={pref ? C.accent : colourFor(i)}
                strokeWidth={pref ? 3 : 1.4} opacity={pref ? 1 : 0.65}
                points={pts.map((x) => `${X(x.p)},${Y(x.c.eGridMwh)}`).join(" ")} />
              {pts.map((x) => (
                <circle key={x.p} cx={X(x.p)} cy={Y(x.c.eGridMwh)} r={pref ? 3.5 : 2.5}
                  fill={pref ? C.accent : colourFor(i)}>
                  <title>{`${t}° at ${x.p} m: ${fmtEnergy(x.c.eGridMwh)}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
        <polyline fill="none" stroke="#fff" strokeWidth="1.8" strokeDasharray="6 4" opacity="0.85"
          points={a.bestTiltPerPitch.filter((b) => b.eGridMwh !== null)
            .map((b) => `${X(b.pitch)},${Y(b.eGridMwh)}`).join(" ")} />
        {a.bestTiltPerPitch.filter((b) => b.eGridMwh !== null).map((b) => (
          <circle key={b.pitch} cx={X(b.pitch)} cy={Y(b.eGridMwh)} r="4" fill="none" stroke="#fff" strokeWidth="1.5">
            <title>{`Best at ${b.pitch} m is ${b.tilt}°: ${fmtEnergy(b.eGridMwh)}`}</title>
          </circle>
        ))}
      </Frame>
    </svg>
  );
}

/* ---------------------------------------------------------------
   4. The decision chart: penalty at the preferred tilt
   --------------------------------------------------------------- */
function ChartPenalty({ a }) {
  const w = 720, h = 330, m = { l: 62, r: 16, t: 16, b: 34 };
  const P = a.pitches;
  const ys = a.preferredSeries.flatMap((s) => [s.penaltyVsMaxPct, s.penaltyVsBestHerePct])
    .filter((v) => v !== null);
  const hi = Math.max(a.acceptablePenaltyPct * 1.3, ...ys) * 1.05;
  const X = (p) => m.l + ((p - P[0]) / Math.max(1e-9, P[P.length - 1] - P[0])) * (w - m.l - m.r);
  const Y = (v) => (h - m.b) - (v / Math.max(1e-9, hi)) * (h - m.b - m.t);
  const line = (key, colour, dash) => (
    <g>
      <polyline fill="none" stroke={colour} strokeWidth="2.2" strokeDasharray={dash}
        points={a.preferredSeries.filter((s) => s[key] !== null)
          .map((s) => `${X(s.pitch)},${Y(s[key])}`).join(" ")} />
      {a.preferredSeries.filter((s) => s[key] !== null).map((s) => (
        <circle key={s.pitch} cx={X(s.pitch)} cy={Y(s[key])} r="3.5" fill={colour}>
          <title>{`${s.pitch} m: ${fmt(s[key], 2)}% penalty`}</title>
        </circle>
      ))}
    </g>
  );
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ display: "block" }}>
      <Frame w={w} h={h} m={m}
        xTicks={P.map((p) => ({ v: p, p: X(p) }))}
        yTicks={makeTicks(0, hi, 5, Y)}
        xLabel="Pitch (m)" yLabel={`Penalty at ${a.preferredTiltActual}° (%)`}
        fmtY={(v) => fmt(v, 2)}>
        {/* everything below the threshold is acceptable */}
        <rect x={m.l} y={Y(a.acceptablePenaltyPct)} width={w - m.l - m.r}
          height={Math.max(0, (h - m.b) - Y(a.acceptablePenaltyPct))} fill="#59b56f" opacity="0.10" />
        <line x1={m.l} y1={Y(a.acceptablePenaltyPct)} x2={w - m.r} y2={Y(a.acceptablePenaltyPct)}
          stroke="#59b56f" strokeWidth="1.6" strokeDasharray="5 3" />
        <text x={w - m.r - 4} y={Y(a.acceptablePenaltyPct) - 5} textAnchor="end" fill="#7fc78f"
          style={{ font: "600 10px var(--mono)" }}>{fmt(a.acceptablePenaltyPct, 2)}% limit</text>
        {line("penaltyVsMaxPct", C.accent)}
        {line("penaltyVsBestHerePct", "#4f9fe0", "5 3")}
        {a.recommended && (
          <g>
            <line x1={X(a.recommended.pitch)} y1={m.t} x2={X(a.recommended.pitch)} y2={h - m.b}
              stroke="#fff" strokeWidth="1.5" strokeDasharray="3 3" opacity="0.7" />
            <text x={X(a.recommended.pitch)} y={m.t + 11} textAnchor="middle" fill="#fff"
              style={{ font: "600 10px var(--mono)" }}>{a.recommended.pitch} m</text>
          </g>
        )}
      </Frame>
    </svg>
  );
}

/* ---------------------------------------------------------------
   5. Marginal gain per metre of pitch
   --------------------------------------------------------------- */
function ChartMarginal({ a }) {
  const w = 720, h = 290, m = { l: 62, r: 16, t: 16, b: 34 };
  const rows = a.envelopeMarginal.map((e, i) => ({
    pitch: e.pitch,
    env: e.perMetreMwh,
    pref: a.preferredMarginal[i]?.perMetreMwh ?? null,
  })).filter((r) => r.env !== null || r.pref !== null);
  if (!rows.length) return null;
  const vals = rows.flatMap((r) => [r.env, r.pref]).filter((v) => v !== null);
  const hi = Math.max(0, ...vals) * 1.15, lo = Math.min(0, ...vals) * 1.15;
  const bw = (w - m.l - m.r) / rows.length;
  const Y = (v) => (h - m.b) - ((v - lo) / Math.max(1e-9, hi - lo)) * (h - m.b - m.t);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ display: "block" }}>
      <Frame w={w} h={h} m={m}
        xTicks={rows.map((r, i) => ({ v: r.pitch, p: m.l + i * bw + bw / 2 }))}
        yTicks={makeTicks(lo, hi, 4, Y)}
        xLabel="Pitch (m), each bar is the step up from the previous pitch"
        yLabel="Gain per metre (MWh/yr/m)" fmtY={(v) => fmt(v, 0)}>
        {rows.map((r, i) => {
          const x = m.l + i * bw;
          const bars = [["env", r.env, "#4f9fe0"], ["pref", r.pref, C.accent]];
          return bars.map(([k, v, col], j) => v === null ? null : (
            <rect key={k} x={x + bw * (0.16 + j * 0.34)} y={Math.min(Y(v), Y(0))}
              width={bw * 0.3} height={Math.max(1, Math.abs(Y(v) - Y(0)))} fill={col} opacity="0.88" rx="2">
              <title>{`${k === "env" ? "Best-tilt envelope" : `Preferred ${a.preferredTiltActual}°`}`
                + `, up to ${r.pitch} m: ${fmt(v, 1)} MWh/yr per metre`}</title>
            </rect>
          ));
        })}
      </Frame>
    </svg>
  );
}

/* ---------------------------------------------------------------
   6. Loss drivers, only where the columns exist
   --------------------------------------------------------------- */
function ChartLossDriver({ a, field, label, unit }) {
  const w = 350, h = 240, m = { l: 52, r: 12, t: 14, b: 32 };
  const vals = a.cells.map((c) => c.outputs[field]).filter((v) => v !== null && v !== undefined);
  if (!vals.length) return null;
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const X = (t) => m.l + ((t - a.tilts[0]) / Math.max(1e-9, a.tilts[a.tilts.length - 1] - a.tilts[0])) * (w - m.l - m.r);
  const Y = (v) => (h - m.b) - ((v - lo) / Math.max(1e-9, hi - lo)) * (h - m.b - m.t);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ display: "block" }}>
      <Frame w={w} h={h} m={m}
        xTicks={a.tilts.filter((_, i) => i % 2 === 0).map((t) => ({ v: t, p: X(t) }))}
        yTicks={makeTicks(lo, hi, 4, Y)}
        xLabel="Tilt (deg)" yLabel={`${label}${unit ? ` (${unit})` : ""}`}
        fmtY={(v) => fmt(v, hi - lo < 1 ? 3 : 1)}>
        {a.pitches.map((p, i) => {
          const pts = a.tilts.map((t) => ({ t, c: a.at(t, p) }))
            .filter((x) => x.c && x.c.outputs[field] !== null && x.c.outputs[field] !== undefined);
          return (
            <g key={p}>
              <polyline fill="none" stroke={colourFor(i)} strokeWidth="1.6"
                points={pts.map((x) => `${X(x.t)},${Y(x.c.outputs[field])}`).join(" ")} />
              {pts.map((x) => (
                <circle key={x.t} cx={X(x.t)} cy={Y(x.c.outputs[field])} r="2.5" fill={colourFor(i)}>
                  <title>{`${x.t}° at ${p} m: ${fmt(x.c.outputs[field], 2)} ${unit || ""}`}</title>
                </circle>
              ))}
            </g>
          );
        })}
      </Frame>
    </svg>
  );
}

/* ---------------------------------------------------------------
   The tab
   --------------------------------------------------------------- */

export function BatchAnalyserTab({ st, set }) {
  const [file, setFile] = useState(null);      // { name, parsed } or { name, error }
  const [busy, setBusy] = useState(false);

  const onFile = async (f) => {
    setBusy(true);
    try {
      const parsed = parseBatchCsv(new Uint8Array(await f.arrayBuffer()));
      setFile({ name: f.name, parsed });
    } catch (e) {
      setFile({ name: f.name, error: e.message });
    } finally { setBusy(false); }
  };

  const parsed = file?.parsed || null;
  const a = useMemo(() => {
    if (!parsed) return null;
    try {
      return analyseBatch(parsed, {
        tolerancePct: st.tolerancePct,
        preferredTilt: st.preferredTilt,
        acceptablePenaltyPct: st.acceptablePenaltyPct,
        collectorWidthM: st.collectorWidthM > 0 ? st.collectorWidthM : null,
      });
    } catch (e) { return null; }
  }, [parsed, st.tolerancePct, st.preferredTilt, st.acceptablePenaltyPct, st.collectorWidthM]);

  const recommendation = useMemo(() => (a ? buildRecommendation(a, parsed) : []), [a, parsed]);

  const downloadCsv = () => {
    const blob = new Blob([toCsv(a, parsed)], { type: "text/csv;charset=utf-8" });
    const el = document.createElement("a");
    el.href = URL.createObjectURL(blob);
    el.download = `${(parsed.meta.project || "batch").replace(/\.PRJ$/i, "")}-analysis.csv`;
    el.click();
    URL.revokeObjectURL(el.href);
  };

  const hasField = (f) => a && a.cells.some((c) => c.outputs[f] !== null && c.outputs[f] !== undefined);

  return (
    <Page wide>
      <div className="tbl" style={{ marginBottom: 10 }}>
        PVSYST BATCH RESULTS — TILT AND PITCH SELECTION
      </div>

      <Section code="B1" title="Batch results file">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", width: "100%", alignItems: "center" }}>
          <label className="btn primary" style={{ cursor: busy ? "wait" : "pointer" }}>
            {busy ? "Reading…" : "Upload batch results CSV"}
            <input type="file" accept=".csv,text/csv" style={{ display: "none" }} disabled={busy}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
          </label>
          {a && <button className="btn" onClick={downloadCsv}>Export grid and summary as CSV</button>}
          {file && <button className="btn" onClick={() => setFile(null)}>Clear</button>}
        </div>

        {file?.error && (
          <div className="warn" style={{ width: "100%" }}>⚠ {file.name}: {file.error}</div>
        )}

        {parsed && (
          <div className="readout">
            <b>{parsed.meta.project || "Unnamed project"}</b>
            {parsed.meta.baseVariant ? <> · base variant <b>{parsed.meta.baseVariant}</b></> : null}
            {parsed.meta.variantDescription ? <> · {parsed.meta.variantDescription}</> : null}
            {parsed.meta.modified ? <> · modified {parsed.meta.modified}</> : null}
            <br />
            {parsed.rows.length} usable run{parsed.rows.length === 1 ? "" : "s"},
            {" "}read as {parsed.encoding} with a
            {" "}{parsed.delimiter === ";" ? "semicolon" : parsed.delimiter === "\t" ? "tab" : "comma"} delimiter and a
            {" "}decimal {parsed.decimalComma ? "comma" : "point"}.
            {" "}Outputs found: {parsed.outputCols.map((c) => c.group).join(", ")}.
          </div>
        )}

        {!file && (
          <div className="readout" style={{ border: `1px solid ${C.accent}55` }}>
            <b>What this does.</b> PVsyst holds capacity fixed, so a wider pitch always gains energy and the
            curve never turns over on yield alone. The useful question is the other way round: a shallow tilt
            is usually the cheapest structure, so how tight a pitch still keeps that tilt within an acceptable
            penalty of the best case? Drop in a batch results CSV and the answer is on chart 4.
          </div>
        )}
      </Section>

      {parsed && !a && (
        <div className="warn" style={{ width: "100%" }}>⚠ The file parsed but could not be analysed.</div>
      )}

      {a && (<>
        <Section code="B2" title="Assumptions">
          <Num label="Noise tolerance" unit="%" value={st.tolerancePct} step={0.05} min={0}
            onChange={(v) => set({ ...st, tolerancePct: v })} />
          <Num label="Preferred tilt" unit="°" value={st.preferredTilt} step={1}
            onChange={(v) => set({ ...st, preferredTilt: v })} />
          <Num label="Acceptable energy penalty" unit="%" value={st.acceptablePenaltyPct} step={0.1} min={0}
            onChange={(v) => set({ ...st, acceptablePenaltyPct: v })} />
          <Num label="Collector width for GCR" unit="m" value={st.collectorWidthM} step={0.1} min={0}
            onChange={(v) => set({ ...st, collectorWidthM: v })} />
          <div className="readout">
            <b>Noise tolerance</b> exists because PVsyst results are not smooth: in this sample 22° beats 21°
            at 10 m, which is not physical. Anything within {fmt(a.tolerancePct, 2)}% of the best case
            ({fmtEnergy(a.toleranceMwh, 1)}) is treated as a tie rather than as a winner.
            {st.collectorWidthM > 0
              ? <> Collector width {fmt(st.collectorWidthM, 2)} m gives GCR from{" "}
                {fmt(a.geometry.byPitch[a.geometry.byPitch.length - 1].gcr, 3)} at the widest pitch to{" "}
                {fmt(a.geometry.byPitch[0].gcr, 3)} at the tightest.</>
              : <> Set a collector width (table slope length, for example 2P × 2.3 m = 4.6 m) to see GCR and
                the clear gap between rows.</>}
          </div>
        </Section>

        <Section code="B3" title="Recommendation">
          <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
            {recommendation.map((l, i) => (
              <div key={i} className={l.kind === "edge" || l.kind === "excluded" ? "warn" : "readout"}
                style={{ width: "100%", ...(l.kind === "recommend"
                  ? { border: `1px solid ${C.accent}`, background: "#241d10" } : {}) }}>
                {l.kind === "edge" || l.kind === "excluded" ? "⚠ " : ""}{l.text}
              </div>
            ))}
          </div>
          {a.recommended && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
              gap: 10, width: "100%", marginTop: 4 }}>
              {[
                [`${fmt(a.preferredTiltActual, 0)}°`, "preferred tilt"],
                [`${fmt(a.recommended.pitch, 2)} m`, "recommended pitch"],
                [fmtEnergy(a.recommended.eGridMwh), "expected E_Grid"],
                [`${fmt(a.recommended.penaltyVsMaxPct, 2)}%`, "penalty vs best"],
                [fmtEnergy(a.globalMax.eGridMwh - a.recommended.eGridMwh, 1), "energy forgone"],
                ...(a.geometry ? [[fmt(a.geometry.byPitch.find((g) => g.pitch === a.recommended.pitch)?.gcr ?? 0, 3), "GCR"]] : []),
              ].map(([v, k]) => (
                <div key={k} style={{ background: C.panel2, border: `1px solid ${C.line}`,
                  borderRadius: 6, padding: "9px 11px" }}>
                  <div style={{ font: "650 17px var(--mono)", color: C.text }}>{v}</div>
                  <div style={{ font: "11px system-ui", color: C.muted }}>{k}</div>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section code="B4" title="Charts">
          <div style={{ width: "100%" }}>
            <ChartCard title="4. Penalty at the preferred tilt against pitch"
              subtitle="the decision chart: the tightest pitch that stays under the line"
              filename="penalty-vs-pitch"
              legend={[
                { label: "vs the global best case", colour: C.accent },
                { label: "vs the best tilt at that same pitch", colour: "#4f9fe0", dash: true },
                { label: `acceptable penalty, ${fmt(a.acceptablePenaltyPct, 2)}%`, colour: "#59b56f", dash: true },
              ]}>
              <ChartPenalty a={a} />
            </ChartCard>

            <ChartCard title="2. E_Grid by tilt and pitch"
              subtitle="cells in GWh/yr; green outline marks a tie with the maximum, white outline the recommendation"
              filename="heatmap">
              <ChartHeatmap a={a} />
            </ChartCard>

            <ChartCard title="1. E_Grid against tilt, one line per pitch"
              subtitle="the shaded band is the noise tolerance beneath the global maximum"
              filename="egrid-vs-tilt"
              legend={a.pitches.map((p, i) => ({ label: `${p} m`, colour: colourFor(i) }))}>
              <ChartEgridVsTilt a={a} />
            </ChartCard>

            <ChartCard title="3. E_Grid against pitch, one line per tilt"
              subtitle="the preferred tilt is drawn heavy; the dashed white line is the best-tilt envelope"
              filename="egrid-vs-pitch"
              legend={[
                ...a.tilts.map((t, i) => ({
                  label: `${t}°${t === a.preferredTiltActual ? " (preferred)" : ""}`,
                  colour: t === a.preferredTiltActual ? C.accent : colourFor(i),
                  width: t === a.preferredTiltActual ? 3 : 2,
                })),
                { label: "best tilt at each pitch", colour: "#fff", dash: true },
              ]}>
              <ChartEgridVsPitch a={a} />
            </ChartCard>

            <ChartCard title="5. Marginal gain per metre of pitch"
              subtitle="what the next metre buys; diminishing returns are the point"
              filename="marginal-gain"
              legend={[
                { label: "best-tilt envelope", colour: "#4f9fe0" },
                { label: `preferred ${a.preferredTiltActual}°`, colour: C.accent },
              ]}>
              <ChartMarginal a={a} />
            </ChartCard>

            {(hasField("ShdLoss") || hasField("IL_Pmax")) && (
              <div style={{ width: "100%", background: C.panel, border: `1px solid ${C.line}`,
                borderRadius: 6, padding: "10px 12px 12px", marginBottom: 12 }}>
                <div style={{ font: "600 12px system-ui", color: C.text, marginBottom: 2 }}>
                  6. Loss drivers
                </div>
                <div style={{ font: "10.5px system-ui", color: C.muted, marginBottom: 8 }}>
                  why the curves bend: shading falls as the rows open up, clipping rises as the tilt steepens
                </div>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                  {hasField("ShdLoss") && (
                    <div style={{ flex: "1 1 320px", minWidth: 280, background: C.paper, borderRadius: 4 }}>
                      <ChartLossDriver a={a} field="ShdLoss" label="Shading loss"
                        unit={parsed.outputCols.find((c) => c.group === "ShdLoss")?.unit || ""} />
                    </div>
                  )}
                  {hasField("IL_Pmax") && (
                    <div style={{ flex: "1 1 320px", minWidth: 280, background: C.paper, borderRadius: 4 }}>
                      <ChartLossDriver a={a} field="IL_Pmax" label="Clipping, IL_Pmax"
                        unit={parsed.outputCols.find((c) => c.group === "IL_Pmax")?.unit || ""} />
                    </div>
                  )}
                </div>
                <Legend items={a.pitches.map((p, i) => ({ label: `${p} m`, colour: colourFor(i) }))} />
              </div>
            )}
          </div>
        </Section>

        <Section code="B5" title="Grid">
          <div style={{ overflowX: "auto", width: "100%", WebkitOverflowScrolling: "touch" }}>
            <table style={{ borderCollapse: "collapse", minWidth: 520, font: "12px var(--mono)" }}>
              <thead><tr>
                <th style={{ padding: "6px 9px", borderBottom: `1px solid ${C.line}`, textAlign: "left",
                  font: "600 9.5px system-ui", textTransform: "uppercase", letterSpacing: "0.07em", color: C.muted }}>
                  Tilt \ pitch
                </th>
                {a.pitches.map((p) => (
                  <th key={p} style={{ padding: "6px 9px", borderBottom: `1px solid ${C.line}`, textAlign: "right",
                    font: "600 9.5px system-ui", color: C.muted }}>
                    {p} m{a.geometry ? <div style={{ font: "9px var(--mono)", fontWeight: 400 }}>
                      GCR {fmt(a.geometry.byPitch.find((g) => g.pitch === p).gcr, 3)}</div> : null}
                  </th>
                ))}
              </tr></thead>
              <tbody>
                {a.tilts.map((t) => (
                  <tr key={t} style={{ borderTop: `1px solid ${C.line}`,
                    background: t === a.preferredTiltActual ? "rgba(232,130,12,0.09)" : "transparent" }}>
                    <td style={{ padding: "5px 9px", color: C.text }}>
                      {t}&#176;{t === a.preferredTiltActual ? <span style={{ color: C.accent }}> preferred</span> : null}
                    </td>
                    {a.pitches.map((p) => {
                      const c = a.at(t, p);
                      const tie = c && a.ties.some((x) => x.tilt === t && x.pitch === p);
                      return (
                        <td key={p} style={{ padding: "5px 9px", textAlign: "right",
                          color: tie ? "#7fc78f" : C.text, fontWeight: tie ? 700 : 400 }}
                          title={a.geometry && c ? `clear gap ${fmt(a.geometry.clearGap(t, p), 2)} m` : undefined}>
                          {c ? fmtEnergy(c.eGridMwh) : <span style={{ color: C.muted }}>no run</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {parsed.warnings.length > 0 && (
            <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 6, marginTop: 10 }}>
              {parsed.warnings.map((wn, i) => (
                <div key={i} className="warn" style={{ width: "100%" }}>⚠ {wn}</div>
              ))}
            </div>
          )}
        </Section>

        <Section code="B6" title="Costs">
          <div className="readout" style={{ opacity: 0.75 }}>
            <b>Not built yet.</b> The analysis above is energy only, and energy alone always prefers a wider
            pitch. The cost phase attaches a figure to each cell of the grid so the optimum becomes economic:
            structure cost per MWp as a function of tilt, land by the hectare or a fixed boundary, DC and LV
            cabling per metre scaling with pitch, fencing and roads scaling with area, then an energy price,
            discount rate, lifetime and degradation to turn it into LCOE or NPV per cell.
            <br /><br />
            The grid already carries an empty <span className="mono">costs</span> slot on every cell and the
            input schema is defined in <span className="mono">batchAnalyser.js</span>, so this panel is the
            only thing missing rather than a rewrite.
          </div>
        </Section>
      </>)}
    </Page>
  );
}

export const BATCH_DEFAULTS = {
  tolerancePct: ANALYSIS_DEFAULTS.tolerancePct,
  preferredTilt: ANALYSIS_DEFAULTS.preferredTilt,
  acceptablePenaltyPct: ANALYSIS_DEFAULTS.acceptablePenaltyPct,
  collectorWidthM: 0,
};
