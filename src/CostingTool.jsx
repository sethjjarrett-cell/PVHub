/* =====================================================================
   COSTING TAB

   A library of the quotes you have actually received, and what they do
   to LCOE. Nothing here ships with a price in it — see src/costing.js
   for why that is a refusal rather than an omission.

   The tab is built around the quote rather than around the plant,
   because the question people actually ask is "what did we pay in
   Kenya, and when" long before they ask "what is the LCOE".
   ===================================================================== */

import React, { useMemo, useState } from "react";
import { fmt, C, Num, Sel, Section, Page, Working, Rows, useNarrow } from "./ui.jsx";
import {
  REGIONS, regionById, COST_LINES, SOURCES, emptyQuote,
  quoteAgeMonths, stalenessOf, escalate, quoteAt, deriveIndices,
  evaluate, compareQuotes, quotesToCsv, quotesFromCsv,
} from "./costing.js";

const TONE = { ok: "#4fb06a", warn: "#e0a63a", bad: "#d64545" };

const Stat = ({ label, value, unit, tone }) => (
  <div style={{ background: C.panel2, border: `1px solid ${tone || C.line}`, borderRadius: 6,
    padding: "8px 11px", minWidth: 112 }}>
    <div style={{ font: "10.5px system-ui", color: C.muted }}>{label}</div>
    <div style={{ font: "650 17px var(--mono)", color: tone || C.text }}>
      {value}<span style={{ font: "10.5px system-ui", color: C.muted }}> {unit}</span>
    </div>
  </div>
);

const AgeChip = ({ st }) => (
  <span style={{ font: "10.5px system-ui", padding: "2px 7px", borderRadius: 4,
    background: `${TONE[st.tone]}22`, color: TONE[st.tone], border: `1px solid ${TONE[st.tone]}66` }}>
    {st.months === null ? "no date" : `${st.months} mo · ${st.label}`}
  </span>
);

export function CostingTab({ st, set, kWpHint, yieldHint }) {
  const narrow = useNarrow(760);
  const [editing, setEditing] = useState(null);
  const [csvMsg, setCsvMsg] = useState(null);
  const asOf = new Date();

  const quotes = st.quotes || [];
  const selected = quotes.find((q) => q.id === st.selectedId) || quotes[0] || null;
  const updQuote = (id, patch) => set({ ...st,
    quotes: quotes.map((q) => (q.id === id ? { ...q, ...patch } : q)) });
  const updLine = (id, lineId, v) => set({ ...st,
    quotes: quotes.map((q) => (q.id === id ? { ...q, lines: { ...q.lines, [lineId]: v } } : q)) });

  const addQuote = () => {
    const q = emptyQuote({ name: `Quote ${quotes.length + 1}`, kWpBasis: st.kWp || 0 });
    set({ ...st, quotes: [...quotes, q], selectedId: q.id });
    setEditing(q.id);
  };
  const delQuote = (id) => {
    const rest = quotes.filter((q) => q.id !== id);
    set({ ...st, quotes: rest, selectedId: rest[0]?.id ?? null });
  };
  const dupQuote = (q) => {
    const c = emptyQuote({ ...q, id: undefined, name: `${q.name} (copy)`,
      lines: { ...q.lines } });
    set({ ...st, quotes: [...quotes, c], selectedId: c.id });
  };

  /* The quote actually used: escalated to today if asked, with the
     original kept on the object so the interface can show both. */
  const applied = useMemo(() => {
    if (!selected) return null;
    return st.escalate && st.escalationPct
      ? escalate(selected, st.escalationPct, asOf) : { ...selected, escalatedFrom: null };
  }, [selected, st.escalate, st.escalationPct]);

  const result = useMemo(() => {
    if (!applied) return null;
    return evaluate({
      quote: applied, kWp: st.kWp, specificYield: st.specificYield,
      region: regionById(applied.regionId), years: st.years,
      discountRate: st.discountOverride || null, inflationPct: st.inflationPct,
      lumpMode: st.lumpMode, lumpExponent: st.lumpExponent,
      omPerKWpYr: st.omPerKWpYr, landLeaseYr: st.landLeaseYr,
      insurancePctCapex: st.insurancePctCapex, assetMgmtYr: st.assetMgmtYr,
      inverterReplaceYear: st.inverterReplaceYear, inverterReplacePerWp: st.inverterReplacePerWp,
      tariff: st.tariff > 0 ? st.tariff : null, tariffEscalationPct: st.tariffEscalationPct,
      asOf,
    });
  }, [applied, st]);

  const comparison = useMemo(() => {
    if (quotes.length < 2) return null;
    const list = st.escalate && st.escalationPct
      ? quotes.map((q) => escalate(q, st.escalationPct, asOf)) : quotes;
    return compareQuotes(list, {
      kWp: st.kWp, specificYield: st.specificYield, years: st.years,
      inflationPct: st.inflationPct, lumpMode: st.lumpMode, lumpExponent: st.lumpExponent,
      omPerKWpYr: st.omPerKWpYr, asOf,
    });
  }, [quotes, st]);

  const derive = useMemo(() => {
    if (!st.deriveAgainst || !selected) return null;
    const other = quotes.find((q) => q.id === st.deriveAgainst);
    if (!other || other.id === selected.id) return null;
    return { other, ...deriveIndices(selected, other) };
  }, [st.deriveAgainst, selected, quotes]);

  const sym = selected?.symbol || regionById(selected?.regionId)?.sym || "";
  const money = (v, dp = 0) => `${sym}${fmt(v, dp)}`;

  const exportCsv = () => {
    const blob = new Blob([quotesToCsv(quotes)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "pvhub-quotes.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importCsv = (file) => {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const { quotes: qs, warnings } = quotesFromCsv(String(rd.result));
        set({ ...st, quotes: [...quotes, ...qs], selectedId: qs[0]?.id ?? st.selectedId });
        setCsvMsg({ ok: true, n: qs.length, warnings, name: file.name });
      } catch (e) { setCsvMsg({ ok: false, reason: e.message, name: file.name }); }
    };
    rd.readAsText(file);
  };

  return (
    <Page wide>
      <div className="tbl" style={{ marginBottom: 10 }}>
        COSTING — YOUR QUOTES, THEIR AGE, AND WHAT THEY DO TO LCOE
      </div>

      <Section code="K1" title="The quote library">
        <div className="readout" style={{ width: "100%", font: "10.5px/1.65 system-ui" }}>
          <b>Nothing here ships with a price in it, deliberately.</b> Module prices, EPC rates
          and connection charges move faster than any figure could be embedded and stay true,
          and a plausible default gets used — it ends up in a board paper with nobody
          remembering where it came from. So the money is yours: load the quotes you have
          actually received, and the tool tells you how old each one is everywhere it is used.
          A 2023 module price and a 2026 one are different numbers, and the difference is
          usually larger than the engineering.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", width: "100%" }}>
          <button className="btn" onClick={addQuote}
            style={{ background: C.accent, borderColor: C.accent, color: "#181206", fontWeight: 600 }}>
            + Add a quote
          </button>
          <label className="btn" style={{ cursor: "pointer" }}>
            Import CSV
            <input type="file" accept=".csv,.txt" style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) importCsv(f); e.target.value = ""; }} />
          </label>
          <button className="btn" onClick={exportCsv} disabled={!quotes.length}>Export CSV</button>
          <span style={{ font: "10.5px system-ui", color: C.muted }}>
            The CSV is the library — keep it in version control or a shared drive so the quotes
            outlive the browser.
          </span>
        </div>
        {csvMsg && (
          <div className={csvMsg.ok ? "readout" : "warn"} style={{ width: "100%" }}>
            {csvMsg.ok ? <>
              <b>{csvMsg.name}:</b> {csvMsg.n} quote{csvMsg.n === 1 ? "" : "s"} loaded.
              {csvMsg.warnings?.length > 0 && (
                <ul style={{ margin: "5px 0 0", paddingLeft: 18 }}>
                  {csvMsg.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              )}
            </> : <>&#9888; <b>{csvMsg.name}:</b> {csvMsg.reason}</>}
          </div>
        )}

        {!quotes.length ? (
          <div className="warn" style={{ width: "100%" }}>
            &#9888; No quotes yet. Add one, or import a CSV. Until then nothing below has a
            number in it, which is the correct state rather than a broken one.
          </div>
        ) : (
          <Rows min={940} keyOf={(q) => q.id}
            rows={quotes}
            rowStyle={(q) => (q.id === st.selectedId
              ? { background: "rgba(232,130,12,0.10)", borderColor: C.accent } : null)}
            cols={[
              { key: "pick", label: "", align: "left", render: (q) => (
                <label style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer" }}>
                  <input type="radio" checked={q.id === st.selectedId}
                    onChange={() => set({ ...st, selectedId: q.id })}
                    style={{ accentColor: C.accent }} />
                  <span style={{ font: "650 13.5px var(--mono)", color: C.text }}>
                    {q.name || "unnamed"}
                  </span>
                </label>
              ) },
              { key: "project", label: "Project", align: "left", render: (q) => q.project || "—" },
              { key: "country", label: "Country", align: "left", render: (q) => q.country || "—" },
              { key: "region", label: "Region", align: "left", render: (q) => regionById(q.regionId).name },
              { key: "datePriced", label: "Priced", render: (q) => q.datePriced || "—" },
              { key: "age", label: "Age", render: (q) => <AgeChip st={stalenessOf(q, asOf)} /> },
              { key: "currency", label: "Currency", render: (q) => q.currency },
              { key: "source", label: "Source", align: "left",
                render: (q) => SOURCES.find((x) => x.value === q.source)?.label || q.source },
              { key: "basis", label: "Priced at", render: (q) => (q.kWpBasis ? `${fmt(q.kWpBasis / 1000, 1)} MWp` : "—") },
              { key: "perWp", label: "Capex /Wp", render: (q) => (q.kWpBasis
                ? <span style={{ color: C.accent }}>
                    {q.symbol || ""}{fmt(quoteAt(q, q.kWpBasis, { lumpMode: "asQuoted" }).perWp, 3)}
                  </span>
                : "—") },
              { key: "act", label: "", render: (q) => (
                <span style={{ whiteSpace: "nowrap" }}>
                  <button className="btn" style={{ padding: "3px 9px" }}
                    onClick={() => setEditing(editing === q.id ? null : q.id)}>
                    {editing === q.id ? "close" : "edit"}
                  </button>
                  <button className="btn" style={{ padding: "3px 9px", marginLeft: 5 }}
                    onClick={() => dupQuote(q)}>copy</button>
                  <button className="btn" style={{ padding: "3px 9px", marginLeft: 5 }}
                    onClick={() => delQuote(q.id)}>remove</button>
                </span>
              ) },
            ]} />
        )}

        {editing && quotes.find((q) => q.id === editing) && (() => {
          const q = quotes.find((x) => x.id === editing);
          return (
            <div style={{ width: "100%", marginTop: 10, padding: "11px 13px", borderRadius: 6,
              background: C.panel2, border: `1px solid ${C.accent}` }}>
              <div style={{ font: "600 12px system-ui", color: C.text, marginBottom: 8 }}>
                Editing “{q.name || "unnamed"}”
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
                {[["name", "Name"], ["project", "Project"], ["country", "Country"],
                  ["incoterm", "Incoterm / delivery basis"]].map(([k, label]) => (
                  <label key={k} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <span style={{ font: "10.5px system-ui", color: C.muted }}>{label}</span>
                    <input value={q[k] || ""} onChange={(e) => updQuote(q.id, { [k]: e.target.value })}
                      style={{ width: 150, background: C.panel, border: `1px solid ${C.line}`,
                        borderRadius: 4, color: C.text, font: "12px var(--mono)",
                        padding: "5px 7px", outline: "none" }} />
                  </label>
                ))}
                <label style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <span style={{ font: "10.5px system-ui", color: C.muted }}>Date priced</span>
                  <input type="date" value={q.datePriced || ""}
                    onChange={(e) => updQuote(q.id, { datePriced: e.target.value })}
                    style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: 4,
                      color: C.text, font: "12px var(--mono)", padding: "5px 7px", outline: "none" }} />
                </label>
                <Sel label="Region" value={q.regionId}
                  onChange={(v) => updQuote(q.id, { regionId: v,
                    currency: regionById(v).ccy, symbol: regionById(v).sym })}
                  options={REGIONS.map((r) => ({ value: r.id, label: r.name }))} />
                <Sel label="Source" value={q.source}
                  onChange={(v) => updQuote(q.id, { source: v })} options={SOURCES} />
                <Sel label="Status" value={q.status} onChange={(v) => updQuote(q.id, { status: v })}
                  options={[{ value: "budget", label: "Budget" }, { value: "firm", label: "Firm" },
                    { value: "contracted", label: "Contracted" }]} />
                <Num label="Priced at" unit="kWp" value={q.kWpBasis} step={500}
                  onChange={(v) => updQuote(q.id, { kWpBasis: v })} />
              </div>
              <div style={{ font: "10.5px/1.6 system-ui", color: C.muted, marginBottom: 8 }}>
                Per-watt lines in <b>{q.symbol || q.currency} per Wp</b>; the last three are lump
                sums in {q.currency}. <b>Record what the quote covered</b> — a module price ex
                works and one delivered to site are different numbers, which is what the incoterm
                field is for.
              </div>
              <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
                {COST_LINES.map((l) => (
                  <label key={l.id} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <span style={{ font: "10.5px system-ui", color: l.unit === "lump" ? C.accent : C.muted }}>
                      {l.label}{l.unit === "lump" ? " (lump)" : ""}
                    </span>
                    <input type="number" value={q.lines?.[l.id] ?? 0}
                      step={l.unit === "lump" ? 1000 : 0.001}
                      onChange={(e) => updLine(q.id, l.id, Number(e.target.value))}
                      style={{ width: 118, background: C.panel, border: `1px solid ${C.line}`,
                        borderRadius: 4, color: C.text, font: "12px var(--mono)",
                        padding: "5px 7px", outline: "none", textAlign: "right" }} />
                  </label>
                ))}
              </div>
              <label style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 9 }}>
                <span style={{ font: "10.5px system-ui", color: C.muted }}>Notes — scope, exclusions, who gave it</span>
                <textarea value={q.notes || ""} onChange={(e) => updQuote(q.id, { notes: e.target.value })}
                  rows={2} style={{ width: "100%", background: C.panel, border: `1px solid ${C.line}`,
                    borderRadius: 4, color: C.text, font: "11.5px system-ui", padding: "6px 8px",
                    outline: "none", resize: "vertical" }} />
              </label>
            </div>
          );
        })()}
      </Section>

      {selected && (<>
        <Section code="K2" title="The plant this quote is being applied to">
          <Num label="Plant size" unit="kWp" value={st.kWp} step={500}
            onChange={(v) => set({ ...st, kWp: v })} />
          <Num label="Specific yield" unit="kWh/kWp/yr" value={st.specificYield} step={10}
            onChange={(v) => set({ ...st, specificYield: v })} />
          {(kWpHint > 0 || yieldHint > 0) && (
            <button className="btn" onClick={() => set({ ...st,
              kWp: kWpHint > 0 ? kWpHint : st.kWp,
              specificYield: yieldHint > 0 ? yieldHint : st.specificYield })}>
              Take {kWpHint > 0 ? `${fmt(kWpHint / 1000, 1)} MWp` : ""}
              {kWpHint > 0 && yieldHint > 0 ? " and " : ""}
              {yieldHint > 0 ? `${fmt(yieldHint, 0)} kWh/kWp` : ""} from the project
            </button>
          )}
          <Sel label="Lump sums at a different plant size" value={st.lumpMode}
            onChange={(v) => set({ ...st, lumpMode: v })}
            options={[
              { value: "scaled", label: "Scale by a power law — the usual rule" },
              { value: "asQuoted", label: "Keep as quoted" },
              { value: "perWp", label: "Scale linearly with size" }]} />
          {st.lumpMode === "scaled" && (
            <Num label="Scaling exponent" value={st.lumpExponent} step={0.05} min={0.1} max={1}
              onChange={(v) => set({ ...st, lumpExponent: v })} />
          )}
          <div className="readout" style={{ width: "100%", font: "10.5px/1.6 system-ui" }}>
            <b>Lump sums are the trap in reusing a quote.</b> A substation priced for a 5 MW
            plant does not cost the same at 100 MW, and it does not cost twenty times as much
            either. Scaling by size to a power — six or seven tenths is the usual range for
            plant of this kind — sits between the two and is what most estimators do. Keeping it
            as quoted understates a larger plant; scaling it linearly overstates one badly. The
            choice is yours and it is reported in the table below.
            {selected.kWpBasis > 0 && st.kWp > 0 && selected.kWpBasis !== st.kWp && (
              <> This quote was priced at <b>{fmt(selected.kWpBasis / 1000, 1)} MWp</b> and is
                being applied at <b>{fmt(st.kWp / 1000, 1)} MWp</b>, a factor of
                {" "}{fmt(st.kWp / selected.kWpBasis, 2)}.</>
            )}
          </div>
        </Section>

        <Section code="K3" title="Age, and whether to index it forward">
          <div style={{ display: "flex", gap: 9, flexWrap: "wrap", width: "100%", alignItems: "center" }}>
            <Stat label="Priced" value={selected.datePriced || "—"} unit=""
              tone={TONE[stalenessOf(selected, asOf).tone]} />
            <Stat label="Age" value={quoteAgeMonths(selected, asOf) ?? "—"} unit="months"
              tone={TONE[stalenessOf(selected, asOf).tone]} />
            <Stat label="Source" value={SOURCES.find((s) => s.value === selected.source)?.label || "—"} unit="" />
            <Stat label="Status" value={selected.status} unit="" />
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, width: "100%",
            padding: "8px 11px", borderRadius: 6, cursor: "pointer",
            background: st.escalate ? "rgba(232,130,12,0.10)" : C.panel2,
            border: `1px solid ${st.escalate ? C.accent : C.line}` }}>
            <input type="checkbox" checked={!!st.escalate}
              onChange={(e) => set({ ...st, escalate: e.target.checked })}
              style={{ width: 15, height: 15, accentColor: C.accent }} />
            <span style={{ font: "600 11.5px system-ui", color: C.text }}>
              Index quotes forward to today
            </span>
            <span style={{ font: "10.5px system-ui", color: C.muted }}>
              Off by default. An escalated figure is an assumption, not a quote.
            </span>
          </label>
          {st.escalate && (
            <Num label="Escalation" unit="% a year" value={st.escalationPct} step={0.5}
              onChange={(v) => set({ ...st, escalationPct: v })} />
          )}
          {applied?.escalatedFrom && (
            <div className="readout" style={{ width: "100%", border: `1px solid ${C.accent}` }}>
              <b>Indexed forward {applied.escalatedFrom.months} months at
              {" "}{fmt(applied.escalatedFrom.ratePctPerYear, 1)}% a year</b>, a factor of
              {" "}{fmt(applied.escalatedFrom.factor, 3)}. The quoted figures are kept and shown
              struck through in the table below — what was quoted and what was assumed stay
              distinguishable, which is the whole point.
              <br /><br />
              <span style={{ font: "10.5px system-ui", color: C.muted }}>
                A single rate across every line is a convenience, not a model: module prices and
                civils labour have not moved together in any recent year. If a line matters, get
                it requoted rather than indexed.
              </span>
            </div>
          )}
        </Section>

        <Section code="K4" title="Capex, line by line">
          <Rows min={620} rows={result?.capex.lines || []} keyOf={(l) => l.id}
            cols={[
              { key: "label", label: "Line", align: "left", render: (l) => (
                <>{l.label}{l.unit === "lump" ? <span style={{ color: C.accent }}> (lump)</span> : ""}</>
              ) },
              { key: "quoted", label: "Quoted", render: (l) => {
                const orig = applied?.escalatedFrom?.lines?.[l.id];
                const esc = orig !== undefined && Math.abs(orig - l.quoted) > 1e-12;
                return (
                  <span style={{ color: C.muted }}>
                    {esc && <span style={{ textDecoration: "line-through", opacity: 0.7, marginRight: 6 }}>
                      {fmt(orig, l.unit === "lump" ? 0 : 4)}</span>}
                    {fmt(l.quoted, l.unit === "lump" ? 0 : 4)}
                  </span>
                );
              } },
              { key: "applied", label: "Applied", render: (l) => fmt(l.applied, l.unit === "lump" ? 0 : 4) },
              { key: "scaling", label: "Scaling", render: (l) => (
                <span style={{ color: C.muted }}>{l.scaling || "per Wp"}</span>) },
              { key: "amount", label: `Amount ${sym}`, render: (l) => fmt(l.amount, 0) },
              { key: "share", label: "% of capex", render: (l) => (result.capex.capex > 0
                ? `${fmt((l.amount / result.capex.capex) * 100, 1)}%` : "—") },
            ]}
            foot={narrow ? (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ font: "600 12.5px system-ui", color: C.text }}>Total</span>
                <span style={{ font: "650 15px var(--mono)", color: C.accent }}>
                  {fmt(result?.capex.capex ?? 0, 0)} {sym}
                  <span style={{ font: "11px system-ui", color: C.muted }}>
                    {" "}· {money(result?.capex.perWp ?? 0, 3)}/Wp
                  </span>
                </span>
              </div>
            ) : (
              <tr style={{ borderTop: `2px solid ${C.line}` }}>
                <td style={{ padding: "5px 9px", font: "600 12px system-ui", color: C.text }}>Total</td>
                <td colSpan={3} />
                <td style={{ padding: "5px 9px", font: "650 13px var(--mono)", textAlign: "right", color: C.accent }}>
                  {fmt(result?.capex.capex ?? 0, 0)}
                </td>
                <td style={{ padding: "5px 9px", font: "12px var(--mono)", textAlign: "right", color: C.muted }}>
                  {money(result?.capex.perWp ?? 0, 3)}/Wp
                </td>
              </tr>
            )} />
        </Section>

        <Section code="K5" title="Operating cost and the money">
          <Num label="O&M" unit={`${sym}/kWp/yr`} value={st.omPerKWpYr} step={1}
            onChange={(v) => set({ ...st, omPerKWpYr: v })} />
          <Num label="Land lease" unit={`${sym}/yr`} value={st.landLeaseYr} step={1000}
            onChange={(v) => set({ ...st, landLeaseYr: v })} />
          <Num label="Insurance" unit="% of capex/yr" value={st.insurancePctCapex} step={0.05}
            onChange={(v) => set({ ...st, insurancePctCapex: v })} />
          <Num label="Asset management" unit={`${sym}/yr`} value={st.assetMgmtYr} step={1000}
            onChange={(v) => set({ ...st, assetMgmtYr: v })} />
          <Num label="Inverter replacement, year" value={st.inverterReplaceYear} step={1} min={0}
            onChange={(v) => set({ ...st, inverterReplaceYear: v })} />
          <Num label="Replacement cost" unit={`${sym}/Wp`} value={st.inverterReplacePerWp} step={0.005}
            onChange={(v) => set({ ...st, inverterReplacePerWp: v })} />
          <Num label="Opex inflation" unit="%/yr" value={st.inflationPct} step={0.5}
            onChange={(v) => set({ ...st, inflationPct: v })} />
          <Num label="Project life" unit="years" value={st.years} step={1} min={1}
            onChange={(v) => set({ ...st, years: v })} />
          <Num label="Discount rate — 0 uses the region's" unit="%" value={st.discountOverride} step={0.5}
            onChange={(v) => set({ ...st, discountOverride: v })} />
          <div className="readout" style={{ width: "100%", font: "10.5px/1.6 system-ui" }}>
            The region sets a discount rate band when you leave the override at zero — here
            {" "}<b>{fmt(result?.rate ?? 0, 1)}%</b> for {result?.region.name}, against a band of
            {" "}{result?.region.discountBand.join(" to ")}%. <b>That band is a judgement, not a
            published rate</b>, and it moves LCOE more than any line in the capex does: the same
            plant at 5% and at 13% differs by roughly half. If you have a real cost of capital
            for the project, put it in the override — it is the single most valuable number on
            this tab.
          </div>
        </Section>

        <Section code="K6" title="What it costs to make">
          <div style={{ display: "flex", gap: 9, flexWrap: "wrap", width: "100%" }}>
            <Stat label="Capex" value={money(result?.capex.capex ?? 0, 0)} unit={selected.currency} />
            <Stat label="Capex per Wp" value={money(result?.capex.perWp ?? 0, 3)} unit="" tone={C.accent} />
            <Stat label="LCOE" value={result?.lcoe ? `${sym}${fmt(result.lcoe, 4)}` : "—"}
              unit="/kWh" tone={TONE.ok} />
            <Stat label="Year 1 output" value={fmt((result?.year1Energy ?? 0) / 1000, 0)} unit="MWh" />
            <Stat label="Capex share of cost" value={fmt((result?.capexShare ?? 0) * 100, 0)} unit="%" />
            {result?.npv !== null && result?.npv !== undefined && (<>
              <Stat label="NPV" value={money(result.npv, 0)} unit=""
                tone={result.npv >= 0 ? TONE.ok : TONE.bad} />
              <Stat label="IRR" value={result.irr === null ? "none" : fmt(result.irr, 2)} unit="%" />
              <Stat label="Payback" value={result.payback ? fmt(result.payback, 1) : "—"} unit="years" />
            </>)}
          </div>
          <Working n="K1" title="Levelised cost of energy"
            formula="LCOE = [ Capex + Σ Opex_t/(1+r)^t ] / [ Σ E_t/(1+r)^t ]"
            sub={`[${fmt(result?.capex.capex ?? 0, 0)} + ${fmt(result?.discountedOpex ?? 0, 0)}] / ${fmt((result?.discountedEnergy ?? 0) / 1000, 0)} MWh`}
            result={result?.lcoe ? fmt(result.lcoe, 4) : "—"} unit={`${sym}/kWh`}
            why="The energy is discounted as well as the money. That looks wrong the first time — discounting kilowatt-hours has no physical meaning — but it is what makes LCOE the price at which discounted revenue exactly covers discounted cost, which is the only thing LCOE is for. Leaving the denominator undiscounted gives a smaller number that cannot be compared with anything, including another LCOE." />
          <Num label="Tariff or PPA price — 0 for none" unit={`${sym}/kWh`} value={st.tariff} step={0.005}
            onChange={(v) => set({ ...st, tariff: v })} />
          {st.tariff > 0 && (
            <Num label="Tariff escalation" unit="%/yr" value={st.tariffEscalationPct} step={0.5}
              onChange={(v) => set({ ...st, tariffEscalationPct: v })} />
          )}
          {st.tariff > 0 && result?.lcoe && (
            <div className="readout" style={{ width: "100%",
              border: `1px solid ${st.tariff >= result.lcoe ? TONE.ok : TONE.bad}` }}>
              <b>The tariff is {st.tariff >= result.lcoe ? "above" : "below"} LCOE</b> —
              {" "}{sym}{fmt(st.tariff, 4)} against {sym}{fmt(result.lcoe, 4)}. A tariff exactly
              at LCOE returns the discount rate and nothing more, so the gap between the two is
              the margin over your own cost of capital, not the profit.
            </div>
          )}
        </Section>

        {quotes.length > 1 && (
          <Section code="K7" title="Across your quotes">
            {comparison?.warnings.map((w, i) => (
              <div key={i} className="warn" style={{ width: "100%" }}>&#9888; {w}</div>
            ))}
            <Rows min={680} rows={comparison?.rows || []} keyOf={(r) => r.quote.id}
              rowStyle={(r, i) => (i === 0 ? { background: "rgba(79,176,106,0.10)" } : null)}
              cols={[
                { key: "name", label: "Quote", align: "left", render: (r) => r.quote.name || "—" },
                { key: "region", label: "Region", align: "left", render: (r) => r.region.name },
                { key: "priced", label: "Priced", render: (r) => r.quote.datePriced },
                { key: "age", label: "Age", render: (r) => <AgeChip st={r.staleness} /> },
                { key: "ccy", label: "Currency", render: (r) => r.currency },
                { key: "perWp", label: "Capex /Wp", render: (r) => `${r.symbol}${fmt(r.perWp, 3)}` },
                { key: "rate", label: "Discount", render: (r) => `${fmt(r.rate, 1)}%` },
                { key: "lcoe", label: "LCOE", render: (r, i) => (
                  <b style={{ color: i === 0 ? TONE.ok : C.text }}>
                    {r.lcoe ? `${r.symbol}${fmt(r.lcoe, 4)}` : "—"}
                  </b>) },
              ]} />
            <div className="readout" style={{ width: "100%", font: "10.5px/1.6 system-ui" }}>
              Every row is the same plant size and yield, so the differences are the quote, the
              region's physical assumptions and its discount rate — not the project. That is
              useful for a feel and misleading for a decision: a real comparison needs each
              region's own irradiance, which comes from the Yield report rather than from here.
            </div>

            <Sel label="Derive indices against" value={st.deriveAgainst || ""}
              onChange={(v) => set({ ...st, deriveAgainst: v || null })}
              options={[{ value: "", label: "— off —" },
                ...quotes.filter((q) => q.id !== selected.id)
                  .map((q) => ({ value: q.id, label: q.name || "unnamed" }))]} />
            {derive && (
              <div style={{ width: "100%" }}>
                <div className="readout" style={{ width: "100%", font: "10.5px/1.6 system-ui" }}>
                  <b>This is the only honest way to get a regional index:</b> divide one of your
                  real quotes by another. {derive.usable} line
                  {derive.usable === 1 ? "" : "s"} carry a price in both.
                  {!derive.sameCurrency && <> <b style={{ color: TONE.bad }}>They are in different
                    currencies, so these ratios include the exchange rate</b> and are not cost
                    indices until you convert.</>}
                  {derive.monthsApart >= 12 && <> They were priced {derive.monthsApart} months
                    apart, so part of each ratio is the market moving rather than the market
                    differing.</>}
                </div>
                <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 7 }}>
                  {derive.lines.filter((l) => l.ratio !== null).map((l) => (
                    <div key={l.id} style={{ background: C.panel2, border: `1px solid ${C.line}`,
                      borderRadius: 6, padding: "6px 10px", minWidth: 120 }}>
                      <div style={{ font: "10.5px system-ui", color: C.muted }}>{l.label}</div>
                      <div style={{ font: "650 14px var(--mono)",
                        color: l.ratio > 1 ? TONE.warn : TONE.ok }}>
                        ×{fmt(l.ratio, 2)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Section>
        )}
      </>)}

      <Section code="K8" title="What this tool will not do">
        <div className="readout" style={{ width: "100%", font: "11.5px/1.75 system-ui" }}>
          <p style={{ margin: "0 0 9px" }}>
            <b>It does not convert currency.</b> There is no exchange rate anywhere in it. Two
            quotes in different currencies sit side by side and are not comparable on money, and
            the comparison says so rather than quietly applying a rate that would be wrong by
            the time you read it.
          </p>
          <p style={{ margin: "0 0 9px" }}>
            <b>It does not know what your quotes covered.</b> Scope is the largest source of
            difference between two prices for the same thing — ex works against delivered,
            with or without the grid connection, with or without the development cost already
            spent. The incoterm and notes fields are there because the tool cannot work it out.
          </p>
          <p style={{ margin: "0 0 9px" }}>
            <b>It does not finance anything.</b> LCOE here is an unlevered, pre-tax figure at a
            single discount rate. No debt, no gearing, no tax, no depreciation, no residual
            value. For a feel and for ranking that is the right level; for a financial close it
            is not, and a project model in a spreadsheet is what that needs.
          </p>
          <p style={{ margin: 0 }}>
            <b>It does not refresh anything.</b> A quote stays as old as it is until you replace
            it. Indexing forward is an assumption the tool will apply if asked and label
            everywhere it appears, and it is never a substitute for getting the line requoted
            when the line matters.
          </p>
        </div>
      </Section>
    </Page>
  );
}

export const COSTING_DEFAULT = {
  quotes: [], selectedId: null,
  kWp: 10000, specificYield: 1400, years: 25,
  lumpMode: "scaled", lumpExponent: 0.7,
  omPerKWpYr: 0, landLeaseYr: 0, insurancePctCapex: 0, assetMgmtYr: 0,
  inverterReplaceYear: 0, inverterReplacePerWp: 0,
  inflationPct: 0, discountOverride: 0,
  tariff: 0, tariffEscalationPct: 0,
  escalate: false, escalationPct: 3, deriveAgainst: null,
};
