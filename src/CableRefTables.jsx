/* =====================================================================
   REFERENCE TABLES, SHOWN RATHER THAN HIDDEN

   A derating factor is worthless if the reader cannot see where it came
   from. Every table the sizing chain touches is printed here with the
   value in use picked out in green, so the answer can be checked against
   the standard by eye rather than taken on trust.

   Three highlight states, and they mean different things:

     green   the value in use, read straight off a tabulated row
     amber   the two rows an interpolated value sits between, with the
             interpolated result stated separately; no such row exists
             in the standard, and pretending otherwise would be a lie
     purple  extrapolated past where the standard stops, which is not
             IEC data and is labelled as such everywhere it appears
     blue    overridden by hand. The table lookup is still shown, outlined
             rather than filled, so the reader can see both what the
             standard would have given and what was used instead. An
             override is a deliberate act, not an error, so it gets its
             own state rather than being folded in with the others.
   ===================================================================== */

import React, { useState } from "react";
import { fmt, C } from "./ui.jsx";

export const HL = {
  used: { bg: "rgba(79,176,106,0.22)", line: "#4fb06a", text: "#8fd6a3" },
  bracket: { bg: "rgba(224,166,58,0.16)", line: "#e0a63a", text: "#e8c07a" },
  extrap: { bg: "rgba(140,111,208,0.20)", line: "#8c6fd0", text: "#bfa8ee" },
  manual: { bg: "rgba(58,150,224,0.20)", line: "#3a96e0", text: "#8fc7f0" },
  /* What the table said, when something else was used instead: outlined,
     not filled, so it reads as "this is what was overridden". */
  bypassed: { bg: "transparent", line: "#5a6472", text: "#7b8695" },
};

const cellStyle = (state) => ({
  padding: "4px 9px",
  font: "12px var(--mono)",
  whiteSpace: "nowrap",
  textAlign: "right",
  ...(state ? {
    background: HL[state].bg,
    boxShadow: `inset 0 0 0 1.5px ${HL[state].line}`,
    color: HL[state].text,
    fontWeight: state === "bypassed" ? 400 : 700,
    ...(state === "bypassed" ? { textDecoration: "line-through", opacity: 0.75 } : {}),
  } : { color: C.text }),
});

const headStyle = {
  padding: "5px 9px", borderBottom: `1px solid ${C.line}`, textAlign: "right",
  font: "600 9.5px system-ui", textTransform: "uppercase", letterSpacing: "0.06em",
  color: C.muted, whiteSpace: "nowrap",
};

/** A table in a collapsible card, so six of them do not drown the page. */
export function RefCard({ title, source, note, open: openInit = true, emphasis = false, children }) {
  /* Cards start open: the whole point of this section is that the reader
     can see the row every number was read from without hunting for it.
     A card the reader has collapsed re-opens itself if its value later
     becomes interpolated or extrapolated, because that is exactly when
     the working needs to be visible rather than taken on trust. */
  const [open, setOpen] = useState(openInit);
  const [wasEmph, setWasEmph] = useState(emphasis);
  if (emphasis && !wasEmph) { setWasEmph(true); setOpen(true); }
  if (!emphasis && wasEmph) setWasEmph(false);
  return (
    <div style={{ width: "100%", background: C.panel2, border: `1px solid ${C.line}`,
      borderRadius: 6, marginBottom: 8, overflow: "hidden" }}>
      <button onClick={() => setOpen(!open)} style={{
        width: "100%", textAlign: "left", background: "none", border: "none", cursor: "pointer",
        padding: "9px 11px", display: "flex", alignItems: "baseline", gap: 9,
      }}>
        <span style={{ font: "600 12px system-ui", color: C.text }}>{title}</span>
        <span style={{ font: "10.5px system-ui", color: C.muted, flex: 1 }}>{source}</span>
        <span style={{ color: C.muted, fontSize: 10 }}>{open ? "▴ hide" : "▾ show"}</span>
      </button>
      {open && (
        <div style={{ padding: "0 11px 11px" }}>
          {note && <div style={{ font: "10.5px/1.5 system-ui", color: C.muted, marginBottom: 7 }}>{note}</div>}
          <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>{children}</div>
        </div>
      )}
    </div>
  );
}

/** Says plainly that the table below was looked up but not used. */
export function OverrideNote({ bracket, dp = 3, unit = "" }) {
  if (!bracket?.manual) return null;
  return (
    <div style={{ marginBottom: 7, padding: "5px 9px", borderRadius: 5,
      background: HL.manual.bg, border: `1px solid ${HL.manual.line}`,
      font: "11px/1.5 var(--mono)", color: HL.manual.text }}>
      Overridden by hand: using <b>{fmt(bracket.value, dp)}{unit}</b>.
      {bracket.auto !== null && bracket.auto !== undefined && (
        <> The table below gives <b>{fmt(bracket.auto, dp)}{unit}</b>, struck through, and it is
          not being used.</>
      )}
    </div>
  );
}

/** Two-column tables: temperature, soil resistivity, burial depth. */
export function Table1D({ table, xLabel, yLabel, bracket, fmtX = (v) => v, dp = 2 }) {
  const loX = bracket?.lo?.[0], hiX = bracket?.hi?.[0];
  const exact = bracket?.exact;
  const manual = !!bracket?.manual;
  const stateFor = (x) => {
    if (bracket?.lo === null) return null;
    const hit = exact ? x === loX : (x === loX || x === hiX);
    if (!hit) return null;
    if (manual) return "bypassed";
    return exact ? "used" : "bracket";
  };
  return (
    <>
      <OverrideNote bracket={bracket} dp={dp + 1} />
      <table style={{ borderCollapse: "collapse" }}>
        <thead><tr>
          <th style={{ ...headStyle, textAlign: "left" }}>{xLabel}</th>
          {table.map(([x]) => <th key={x} style={headStyle}>{fmtX(x)}</th>)}
        </tr></thead>
        <tbody><tr>
          <td style={{ padding: "4px 9px", font: "12px var(--mono)", color: C.muted, whiteSpace: "nowrap" }}>{yLabel}</td>
          {table.map(([x, y]) => <td key={x} style={cellStyle(stateFor(x))}>{fmt(y, dp)}</td>)}
        </tr></tbody>
      </table>
      {bracket && !exact && bracket.lo && !manual && (
        <div style={{ marginTop: 6, font: "11px var(--mono)", color: HL.used.text }}>
          interpolated between {fmtX(loX)} and {fmtX(hiX)}
          {" → "}<b>{fmt(bracket.auto ?? bracket.value, 3)}</b>
          {bracket.clamped && <span style={{ color: HL.bracket.text }}>
            {"  "}(input is outside the table, so the end value is held)
          </span>}
        </div>
      )}
    </>
  );
}

/** Grouping tables: rows of circuit counts, columns of spacing. */
export function TableGroup({ rows, cols, activeCol, circuits, bracket }) {
  const loC = bracket?.lo?.[0], hiC = bracket?.hi?.[0];
  const exact = bracket?.exact;
  const manual = !!bracket?.manual;
  const stateFor = (r, colKey) => {
    if (colKey !== activeCol || bracket?.lo === null) return null;
    const hit = exact ? r.circuits === loC : (r.circuits === loC || r.circuits === hiC);
    if (!hit) return null;
    if (manual) return "bypassed";
    return exact ? "used" : "bracket";
  };
  return (
    <>
      <OverrideNote bracket={bracket} />
      <table style={{ borderCollapse: "collapse" }}>
        <thead><tr>
          <th style={{ ...headStyle, textAlign: "left" }}>Circuits</th>
          {cols.map((c) => (
            <th key={c.value} style={{ ...headStyle,
              ...(c.value === activeCol ? { color: HL.used.text, borderBottom: `2px solid ${HL.used.line}` } : {}) }}>
              {c.label}
            </th>
          ))}
        </tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.circuits}>
              <td style={{ padding: "4px 9px", font: "12px var(--mono)",
                color: r.circuits === loC || r.circuits === hiC ? C.text : C.muted }}>{r.circuits}</td>
              {cols.map((c) => (
                <td key={c.value} style={cellStyle(stateFor(r, c.value))}>
                  {r[c.value] === null || r[c.value] === undefined ? "—" : fmt(r[c.value], 2)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {bracket?.beyond && !manual && (
        <div style={{ marginTop: 6, font: "11px var(--mono)", color: "#d67070" }}>
          {circuits} circuits is past the last tabulated row, so no factor can be read.
        </div>
      )}
      {bracket && !exact && !bracket.beyond && bracket.lo && !manual && (
        <div style={{ marginTop: 6, font: "11px var(--mono)", color: HL.used.text }}>
          interpolated between {loC} and {hiC} circuits {"→ "}<b>{fmt(bracket.value, 3)}</b>
        </div>
      )}
    </>
  );
}

/** Base current-carrying capacity, with the chosen size and method picked out. */
export function TableCCC({ table, size, install, methods, extrapolated, manual = false,
  manualValue = null, autoValue = null, alsoPicks = [] }) {
  /* The other two methods' choices are outlined rather than filled, so
     all three are visible at once without three things competing to be
     read as "the answer". */
  const isAlso = (sz, mv) => alsoPicks.some((a) => a.install === mv && a.size === sz);
  return (
    <>
    {manual && (
      <div style={{ marginBottom: 7, padding: "5px 9px", borderRadius: 5,
        background: HL.manual.bg, border: `1px solid ${HL.manual.line}`,
        font: "11px/1.5 var(--mono)", color: HL.manual.text }}>
        Overridden by hand: using <b>{fmt(manualValue, 0)} A</b>.
        {autoValue !== null && autoValue !== undefined
          ? <> The table below gives <b>{fmt(autoValue, 0)} A</b>, struck through, and it is not
              being used.</>
          : <> IEC does not tabulate this size for this method, so there was nothing to use.</>}
      </div>
    )}
    <table style={{ borderCollapse: "collapse" }}>
      <thead><tr>
        <th style={{ ...headStyle, textAlign: "left" }}>Size mm&#178;</th>
        {methods.map((m) => (
          <th key={m.value} style={{ ...headStyle,
            ...(m.value === install ? { color: HL.used.text, borderBottom: `2px solid ${HL.used.line}` } : {}) }}>
            {m.label}
          </th>
        ))}
      </tr></thead>
      <tbody>
        {table.map((r) => (
          <tr key={r.size}>
            <td style={{ padding: "4px 9px", font: "12px var(--mono)",
              color: r.size === size || alsoPicks.some((a) => a.size === r.size) ? C.text : C.muted,
              fontWeight: r.size === size ? 700 : 400 }}>
              {r.size}
            </td>
            {methods.map((m) => {
              const v = r[m.value];
              const isPick = r.size === size && m.value === install;
              const also = !isPick && isAlso(r.size, m.value);
              const missing = v === null || v === undefined;
              return (
                <td key={m.value} style={{
                  ...cellStyle(isPick ? (manual ? "bypassed" : missing ? "extrap" : "used") : null),
                  ...(also ? { boxShadow: `inset 0 0 0 1.5px ${HL.used.line}`,
                    color: HL.used.text, fontWeight: 600 } : {}),
                }}>
                  {missing
                    ? <span style={{ color: isPick ? HL.extrap.text : C.muted }}>
                        {isPick && extrapolated ? fmt(extrapolated, 0) : "not tabulated"}
                      </span>
                    : fmt(v, 0)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
    </>
  );
}

/* ---------------------------------------------------------------
   The derating chain, as one readable line of arithmetic
   --------------------------------------------------------------- */

function Chip({ label, value, state, sub, was }) {
  const col = state ? HL[state] : null;
  return (
    <div style={{
      background: col ? col.bg : C.panel2, border: `1px solid ${col ? col.line : C.line}`,
      borderRadius: 6, padding: "6px 10px", minWidth: 78, textAlign: "center",
    }}>
      <div style={{ font: "10px system-ui", color: C.muted, letterSpacing: "0.03em" }}>{label}</div>
      <div style={{ font: "650 15px var(--mono)", color: col ? col.text : C.text }}>{value}</div>
      {was !== null && was !== undefined && (
        <div style={{ font: "9.5px var(--mono)", color: HL.bypassed.text,
          textDecoration: "line-through", marginTop: 1 }}>{was}</div>
      )}
      {sub && <div style={{ font: "9.5px system-ui", color: C.muted, marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

const Times = () => (
  <div style={{ font: "600 15px var(--mono)", color: C.muted, alignSelf: "center" }}>&#215;</div>
);

/**
 * base × f_temp × f_grp × f_soil × f_depth = derated, drawn as chips so
 * the reader can see at a glance which factor cost the capacity. It is
 * nearly always grouping.
 */
export function FactorChain({ chain, perCable }) {
  const f = (b) => (b?.value === null || b?.value === undefined ? "—" : fmt(b.value, 3));
  const st = (b) => (b?.manual ? "manual"
    : b?.value === null ? null : b?.exact ? "used" : b?.lo ? "bracket" : null);
  /* When a factor was overridden, the chip carries what the table would
     have given, struck through underneath, so the substitution is visible
     in the arithmetic itself rather than only in the table below. */
  const was = (b) => (b?.manual && b.auto !== null && b.auto !== undefined ? fmt(b.auto, 3) : null);
  const sub = (b, d) => (b?.manual ? "entered" : d);
  const pass = chain.derated !== null && perCable <= chain.derated;
  return (
    <div style={{ display: "flex", gap: 7, flexWrap: "wrap", alignItems: "stretch", width: "100%" }}>
      <Chip label="Base rating" value={chain.base === null ? "—" : fmt(chain.base, 0)}
        state={chain.baseManual ? "manual" : chain.extrapolated ? "extrap" : "used"}
        was={chain.baseManual && chain.baseAuto !== null ? fmt(chain.baseAuto, 0) : null}
        sub={chain.baseManual ? "A, entered" : chain.extrapolated ? "extrapolated" : "A, from IEC"} />
      <Times />
      <Chip label="f_temp" value={f(chain.fTemp)} state={st(chain.fTemp)}
        was={was(chain.fTemp)} sub={sub(chain.fTemp, null)} />
      <Times />
      <Chip label="f_grp" value={f(chain.fGroup)} state={st(chain.fGroup)}
        was={was(chain.fGroup)} sub={sub(chain.fGroup, "grouping")} />
      <Times />
      <Chip label="f_soil" value={f(chain.fSoil)} state={st(chain.fSoil)}
        was={was(chain.fSoil)} sub={sub(chain.fSoil, null)} />
      <Times />
      <Chip label="f_depth" value={f(chain.fDepth)} state={st(chain.fDepth)}
        was={was(chain.fDepth)} sub={sub(chain.fDepth, null)} />
      <div style={{ font: "600 15px var(--mono)", color: C.muted, alignSelf: "center" }}>=</div>
      <Chip label="Derated" value={chain.derated === null ? "—" : fmt(chain.derated, 1)}
        state={pass ? "used" : null} sub="A per cable" />
      <div style={{ font: "600 15px var(--mono)", color: C.muted, alignSelf: "center" }}>vs</div>
      <Chip label="Design" value={fmt(perCable, 1)} sub="A per cable" />
    </div>
  );
}

/** Green when the value came straight off a row, amber when interpolated. */
export function HighlightKey() {
  return (
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", font: "10.5px system-ui",
      color: C.muted, marginBottom: 8 }}>
      {[["used", "read from the table"], ["bracket", "interpolated between these rows"],
        ["extrap", "extrapolated, not IEC data"],
        ["manual", "entered by hand, overriding the table"]].map(([k, label]) => (
        <span key={k} style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 12, height: 12, borderRadius: 3, background: HL[k].bg,
            boxShadow: `inset 0 0 0 1.5px ${HL[k].line}`, display: "inline-block" }} />
          {label}
        </span>
      ))}
    </div>
  );
}
