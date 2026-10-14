/* =====================================================================
   Shared UI atoms, palette and formatters.

   Pulled out of App.jsx so the cable-sizing and short-circuit tools can
   use the same input fields, section headers and derivation cards
   without importing the whole application back into themselves. Nothing
   here knows anything about PV — it is presentation only.
   ===================================================================== */
import React, { useState, useEffect } from "react";

const fmt = (v, dp = 2) =>
  Number(v).toLocaleString("en-GB", { maximumFractionDigits: dp, minimumFractionDigits: 0 });
const fmtDim = (v) => {
  const s = Number(v).toFixed(3);
  return s.replace(/\.?0+$/, "");
};
const fmtKm = (m) => (m >= 2000 ? `${fmt(m / 1000, 2)} km` : `${fmt(m, 0)} m`);
/** Area in m² up to 1 km², then km² — no hectares. */
const fmtArea = (m2) =>
  m2 >= 1e6 ? `${fmt(m2 / 1e6, 3)} km²` : `${fmt(m2, 0)} m²`;
const areaUnit = (m2) => (m2 >= 1e6 ? "km²" : "m²");
const areaVal = (m2) => (m2 >= 1e6 ? fmt(m2 / 1e6, 3) : fmt(m2, 0));

/* ---------------- palette ---------------- */
const C = {
  chrome: "#14171c", panel: "#1c2128", panel2: "#22272f", line: "#2c333d",
  text: "#dde3ea", muted: "#8b95a3", accent: "#e8820c",
  paper: "#1b1e24", grid: "#22262e", gridMajor: "#2c313b",
  boundary: "#e8820c", frame: "#8b95a3", moduleRed: "#d4564f",
  inverter: "#3fb457", transformer: "#3d95ea", ac: "#d8dade", warn: "#e0a63a",
  navy: "#31435f", navyLight: "#9fb4d8", steel: "#7d838c", soil: "#33362e", soilLine: "#5d6355",
};

/* ---------------- small UI atoms ---------------- */
function Num({ label, unit, value, onChange, step = 0.01, min, max, width }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    if (draft === "" || Number(draft) !== value) setDraft(String(value));
    // eslint-disable-next-line
  }, [value]);
  return (
    <label className="fld" style={width ? { width } : undefined}>
      <span className="fld-l">{label}</span>
      <span className="fld-box">
        <input
          type="number" value={draft} step={step} min={min} max={max}
          onChange={(e) => {
            const s = e.target.value;
            setDraft(s);
            const v = Number(s);
            if (s !== "" && !Number.isNaN(v)) onChange(v);
          }}
          onBlur={() => { if (draft === "" || Number.isNaN(Number(draft))) setDraft(String(value)); }}
        />
        {unit ? <span className="fld-u">{unit}</span> : null}
      </span>
    </label>
  );
}

function Sel({ label, value, onChange, options, width }) {
  return (
    <label className="fld" style={width ? { width } : undefined}>
      <span className="fld-l">{label}</span>
      <span className="fld-box">
        <select value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </span>
    </label>
  );
}

function Section({ code, title, children }) {
  return (
    <details open className="sec">
      <summary>
        <span className="sec-code">{code}</span>
        <span className="sec-title">{title}</span>
        <span className="sec-caret">▾</span>
      </summary>
      <div className="sec-body">{children}</div>
    </details>
  );
}

function WarnList({ items }) {
  if (!items.length) return null;
  return (
    <div className="warns">
      {items.map((w, i) => (
        <div key={i} className="warn">⚠ {w}</div>
      ))}
    </div>
  );
}

function useNarrow(bp = 900) {
  const [n, setN] = useState(typeof window !== "undefined" && window.innerWidth <= bp);
  useEffect(() => {
    const on = () => setN(window.innerWidth <= bp);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, [bp]);
  return n;
}
const COARSE = typeof window !== "undefined" &&
  window.matchMedia && window.matchMedia("(pointer: coarse)").matches;


/* =====================================================================
   ROWS  —  a table on a desk, cards on a phone

   A twelve-column table does not become usable on a 390 px screen by
   gaining a horizontal scrollbar. It becomes a table whose first four
   columns you can see and whose remaining eight you will never look at,
   which is worse than useless when the columns you cannot see are the
   ones that matter — the pricing date on a quote, the verdict on a
   cable, the module count on a roof plane.

   So below the breakpoint each row becomes a card: the primary column
   as its heading, every other column as a labelled line. Nothing is
   hidden, nothing needs scrolling sideways, and the labels that were
   column headings are now beside their values where they can be read.

   `cols` is [{ key, label, align, render, hideNarrow }]. `render(row,
   index)` returns a node; without it the row's own `key` is printed.
   ===================================================================== */
function Rows({ cols, rows, keyOf, primary = 0, rowStyle, min = 700, foot = null, empty = null }) {
  const narrow = useNarrow(760);
  if (!rows.length && empty) return empty;

  if (narrow) {
    return (
      <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map((r, i) => {
          const extra = rowStyle ? rowStyle(r, i) : null;
          const head = cols[primary];
          return (
            <div key={keyOf ? keyOf(r, i) : i} style={{
              background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 7,
              padding: "9px 11px", ...extra,
            }}>
              <div style={{ font: "650 13.5px var(--mono)", color: C.text, marginBottom: 6 }}>
                {head.render ? head.render(r, i) : r[head.key]}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "3px 10px" }}>
                {cols.map((c, ci) => {
                  if (ci === primary || c.hideNarrow) return null;
                  const v = c.render ? c.render(r, i) : r[c.key];
                  if (v === null || v === undefined || v === "") return null;
                  return (
                    <React.Fragment key={c.key || ci}>
                      <span style={{ font: "11px system-ui", color: C.muted, whiteSpace: "nowrap" }}>
                        {c.label}
                      </span>
                      <span style={{ font: "12.5px var(--mono)", color: C.text, textAlign: "left",
                        overflowWrap: "anywhere" }}>{v}</span>
                    </React.Fragment>
                  );
                })}
              </div>
            </div>
          );
        })}
        {foot && (
          <div style={{ background: C.panel2, border: `2px solid ${C.line}`, borderRadius: 7,
            padding: "9px 11px" }}>{foot}</div>
        )}
      </div>
    );
  }

  return (
    <div style={{ width: "100%", overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", minWidth: min }}>
        <thead><tr>
          {cols.map((c, ci) => (
            <th key={c.key || ci} style={{ padding: "5px 9px", borderBottom: `1px solid ${C.line}`,
              textAlign: c.align || "right", font: "600 10.5px system-ui", textTransform: "uppercase",
              letterSpacing: "0.05em", color: C.muted, whiteSpace: "nowrap" }}>{c.label}</th>
          ))}
        </tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={keyOf ? keyOf(r, i) : i}
              style={{ borderTop: `1px solid ${C.line}`, ...(rowStyle ? rowStyle(r, i) : null) }}>
              {cols.map((c, ci) => (
                <td key={c.key || ci} style={{ padding: "4px 9px", font: "12px var(--mono)",
                  textAlign: c.align || "right", color: C.text }}>
                  {c.render ? c.render(r, i) : r[c.key]}
                </td>
              ))}
            </tr>
          ))}
          {foot}
        </tbody>
      </table>
    </div>
  );
}

function Working({ n, title, formula, sub, result, unit, why, status }) {
  return (
    <div className="wk">
      <div className="wk-head">
        <span className="wk-n">{n}</span>
        <span className="wk-title">{title}</span>
        {status && (
          <span className={`wk-status ${status === "OK" || status === "Within window" ? "ok" : "bad"}`}>
            {status}
          </span>
        )}
      </div>
      <div className="wk-formula">{formula}</div>
      <div className="wk-sub">{sub} <b>= {result}{unit ? ` ${unit}` : ""}</b></div>
      <div className="wk-why">{why}</div>
    </div>
  );
}


function NumS({ label, unit, obj, set, k, step = 0.01 }) {
  return (
    <Num label={label} unit={unit} value={obj[k]} step={step}
      onChange={(v) => set({ ...obj, [k]: v })} />
  );
}

function NumO({ label, unit, value, onChange, step = 0.01, ph = "optional" }) {
  return (
    <label className="fld">
      <span className="fld-l">{label}</span>
      <span className="fld-box">
        <input type="number" value={value === null || value === undefined ? "" : value}
          step={step} placeholder={ph}
          onChange={(e) => {
            const t = e.target.value;
            if (t === "") { onChange(null); return; }
            const v = Number(t);
            if (!Number.isNaN(v)) onChange(v);
          }} />
        {unit ? <span className="fld-u">{unit}</span> : null}
      </span>
    </label>
  );
}

function Page({ children, wide }) {
  return <div className="pv-page" style={{ flex: 1, overflowY: "auto", padding: "20px 24px", minWidth: 0 }}>
    <div style={{ maxWidth: wide ? 1500 : 860 }}>{children}</div></div>;
}

export {
  fmt, fmtDim, fmtKm, fmtArea, areaUnit, areaVal,
  C, Num, Sel, Section, WarnList, useNarrow, COARSE,
  Working, NumS, NumO, Page, Rows,
};
