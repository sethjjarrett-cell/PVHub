import React, { useState, useMemo } from "react";
import { C, Num, Sel, Section, Page, Rows, useNarrow } from "./ui.jsx";
import { RefCard, HL } from "./CableRefTables.jsx";
import { SIZES } from "./cableData.js";
import {
  K_TABLES, K_TABLE_LIST, kFor, PE_TABLE_54_2, peFromTable54_2, nextStandardSize,
  transformerSource, solveNetwork, checkCable, defaultNetwork, hasR,
  C_FACTOR, X_PER_M, hasRTable,
} from "./faultNetwork.js";

/* ---------------------------------------------------------------
   Fault study — a radial LV network, cascading from the transformer
   down through boards to final circuits.

   The arithmetic is in src/faultNetwork.js. This file is the display
   layer: the editor, the results, the working behind every number and
   the IEC tables with the row that was read picked out, which is the
   convention the cable tabs already follow.
   --------------------------------------------------------------- */

const n0 = (v, d = 0) => (v === null || v === undefined || Number.isNaN(+v) ? d : +v);
const amps = (a) => (a === null || a === undefined ? "—"
  : a >= 10000 ? `${(a / 1000).toFixed(1)} kA` : `${Math.round(a)} A`);
const ohms = (z) => (z === null || z === undefined ? "—"
  : z >= 1 ? `${z.toFixed(3)} Ω` : `${(z * 1000).toFixed(1)} mΩ`);

const MATERIALS = [
  { value: "copper", label: "Copper" }, { value: "aluminium", label: "Aluminium" }, { value: "steel", label: "Steel" },
];
const ARRANGEMENTS = [
  { value: "multicore", label: "Multicore" }, { value: "trefoil", label: "Single-core trefoil" },
  { value: "flat", label: "Single-core flat" },
];
/* For copper and aluminium the list is what IEC 60228 tabulates. For
   steel armour it is every standard area, because the area is still
   needed for the adiabatic check even though no resistance exists for
   it — the solver reports the missing impedance separately rather than
   leaving the reader with an empty dropdown and no explanation. */
const sizeOptions = (material) => (hasRTable(material) ? SIZES.filter((s) => hasR(s, material)) : SIZES)
  .map((s) => ({ value: s, label: `${s} mm²` }));

/* A pass/fail chip. Three states, because "no verdict" has to look
   different from "passed" — a missing input must never read green. */
function Chip({ state, children }) {
  const c = state === true ? HL.used : state === false
    ? { bg: "rgba(214,90,90,0.18)", line: "#d65a5a", text: "#f0a0a0" }
    : HL.bypassed;
  return (
    <span style={{
      display: "inline-block", background: c.bg, border: `1px solid ${c.line}`, color: c.text,
      borderRadius: 4, padding: "2px 7px", font: "600 10.5px system-ui", whiteSpace: "nowrap",
    }}>{children}</span>
  );
}

/* The house working block: a numbered badge, the formula, the numbers
   put into it, a verdict and a line on why the rule exists at all.
   A bare number with no derivation would be out of place here. */
/* The citation prop is called `cite`, not `ref`: `ref` is reserved, and
   passing a string to it on a function component throws at render —
   React error #290, which in a production build names only the string
   that was passed and nothing about where. */
function Derivation({ n, title, formula, subs, result, state, verdict, why, cite }) {
  return (
    <div style={{ width: "100%", background: C.panel2, border: `1px solid ${C.line}`,
      borderRadius: 6, padding: "10px 12px", marginBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
        <span style={{ background: C.accent, color: "#181206", borderRadius: 3, padding: "1px 6px",
          font: "700 10.5px var(--mono)" }}>{n}</span>
        <span style={{ font: "600 12.5px system-ui", color: C.text }}>{title}</span>
        {cite && <span style={{ font: "10.5px system-ui", color: C.muted }}>{cite}</span>}
        <span style={{ flex: 1 }} />
        {verdict !== undefined && <Chip state={state}>{verdict}</Chip>}
      </div>
      {formula && (
        <div style={{ font: "12px var(--mono)", color: C.muted, marginBottom: 3 }}>{formula}</div>
      )}
      {subs && (
        <div style={{ font: "12.5px var(--mono)", color: C.text, marginBottom: result ? 3 : 0,
          overflowWrap: "anywhere" }}>{subs}</div>
      )}
      {result && (
        <div style={{ font: "650 14px var(--mono)", color: C.accent, marginBottom: 2 }}>{result}</div>
      )}
      {why && (
        <div style={{ font: "10.5px/1.55 system-ui", color: C.muted, marginTop: 6 }}>{why}</div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------
   One node's inputs
   --------------------------------------------------------------- */

function NodeCard({ node, all, onChange, onRemove, open, onToggle, result }) {
  const c = node.cable || {};
  const d = node.device || {};
  const setC = (patch) => onChange({ ...node, cable: { ...c, ...patch } });
  const setD = (patch) => onChange({ ...node, device: { ...d, ...patch } });
  /* A node may hang off anything except itself or its own descendants,
     which is what keeps the network radial. */
  const descendants = useMemo(() => {
    const kids = new Set([node.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const x of all) if (x.parent && kids.has(x.parent) && !kids.has(x.id)) { kids.add(x.id); grew = true; }
    }
    return kids;
  }, [all, node.id]);
  const parentOptions = [{ value: "", label: "The source" }]
    .concat(all.filter((x) => !descendants.has(x.id) && x.kind !== "load")
      .map((x) => ({ value: x.id, label: x.name || x.id })));

  return (
    <div style={{ width: "100%", background: C.panel2, border: `1px solid ${C.line}`,
      borderRadius: 6, marginBottom: 8, overflow: "hidden" }}>
      <button onClick={onToggle} style={{ width: "100%", textAlign: "left", background: "none",
        border: "none", cursor: "pointer", padding: "9px 11px", display: "flex",
        alignItems: "baseline", gap: 9, flexWrap: "wrap" }}>
        <span style={{ font: "600 12.5px system-ui", color: C.text }}>{node.name || node.id}</span>
        <span style={{ font: "10.5px system-ui", color: C.muted }}>
          {c.size ? `${c.size} mm² ${c.material || "copper"}, ${c.lengthM ?? "?"} m` : "no cable yet"}
        </span>
        <span style={{ flex: 1 }} />
        {result && <span style={{ font: "11.5px var(--mono)", color: C.muted }}>
          {amps(result.rec.ik3max)}
        </span>}
        <span style={{ color: C.muted, fontSize: 10.5 }}>{open ? "▴ hide" : "▾ edit"}</span>
      </button>
      {open && (
        <div style={{ padding: "0 11px 11px", display: "flex", flexWrap: "wrap", gap: 10 }}>
          <label className="fld" style={{ width: "100%" }}>
            <span className="fld-l">Name</span>
            <span className="fld-box">
              <input value={node.name || ""} onChange={(e) => onChange({ ...node, name: e.target.value })} />
            </span>
          </label>
          <Sel label="Fed from" value={node.parent || ""} options={parentOptions}
            onChange={(v) => onChange({ ...node, parent: v || null })} />
          <Sel label="This node is" value={node.kind || "board"}
            options={[{ value: "board", label: "Distribution board" }, { value: "load", label: "Load / final circuit" }]}
            onChange={(v) => onChange({ ...node, kind: v })} />

          <div className="tbl" style={{ width: "100%", marginTop: 4 }}>THE CABLE FEEDING IT</div>
          <Sel label="Line conductor" value={c.size ?? ""} options={sizeOptions(c.material || "copper")}
            onChange={(v) => setC({ size: +v })} />
          <Sel label="Conductor material" value={c.material || "copper"} options={MATERIALS}
            onChange={(v) => setC({ material: v })} />
          <Num label="Run length" unit="m" value={n0(c.lengthM)} step={1}
            onChange={(v) => setC({ lengthM: v })} />
          <Num label="Cables in parallel" unit="" value={n0(c.parallel, 1)} step={1} min={1}
            onChange={(v) => setC({ parallel: v })} />
          <Sel label="Insulation" value={c.insulation || "xlpe"}
            options={K_TABLES[c.kTable || "a544"].rows.map((r) => ({ value: r.ins, label: r.name }))}
            onChange={(v) => setC({ insulation: v })} />
          <Sel label="Arrangement" value={c.arrangement || "multicore"} options={ARRANGEMENTS}
            onChange={(v) => setC({ arrangement: v })} />
          <Num label="Operating temperature" unit="°C" value={n0(c.operatingC, 90)} step={1}
            onChange={(v) => setC({ operatingC: v })} />
          <Sel label="Protective conductor" value={c.peSize ?? ""}
            options={sizeOptions(c.peMaterial || c.material || "copper")}
            onChange={(v) => setC({ peSize: +v })} />
          <Sel label="Protective conductor material" value={c.peMaterial || c.material || "copper"}
            options={MATERIALS} onChange={(v) => setC({ peMaterial: v })} />
          <Sel label="Where the earth sits" value={c.kTable || "a544"}
            options={K_TABLE_LIST.map((id) => ({ value: id, label: K_TABLES[id].ref.replace("IEC 60364-5-54 ", "") }))}
            onChange={(v) => {
              /* The insulation lists differ between tables, so a switch
                 that leaves a row name behind would silently lose k. */
              const rows = K_TABLES[v].rows;
              const keep = rows.some((r) => r.ins === c.insulation) ? c.insulation : rows[0].ins;
              setC({ kTable: v, insulation: keep });
            }} />

          <div className="tbl" style={{ width: "100%", marginTop: 4 }}>THE DEVICE PROTECTING IT</div>
          <Num label="Device rating" unit="A" value={n0(d.ratingA)} step={1}
            onChange={(v) => setD({ ratingA: v })} />
          <Num label="Instantaneous at" unit="× In" value={n0(d.magneticMultiple, 10)} step={0.5}
            onChange={(v) => setD({ magneticMultiple: v })} />
          <Num label="Instantaneous clearing time" unit="s" value={n0(d.clearingS, 0.1)} step={0.01}
            onChange={(v) => setD({ clearingS: v })} />
          <Num label="Thermal backup time" unit="s" value={n0(d.backupS, 5)} step={0.5}
            onChange={(v) => setD({ backupS: v })} />
          <Num label="Breaking capacity Icu" unit="kA" value={n0(d.icuKa)} step={1}
            onChange={(v) => setD({ icuKa: v })} />
          <div style={{ width: "100%", display: "flex", justifyContent: "flex-end" }}>
            <button className="btn" onClick={onRemove}>Remove this node</button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------
   The IEC tables, with the row that was used picked out
   --------------------------------------------------------------- */

function KTableCard({ tableId, used }) {
  const t = K_TABLES[tableId];
  const active = used && used.table === tableId && used.source === "table";
  const cell = (row, mat) => {
    const v = row[mat];
    if (!v) return <span style={{ color: C.muted }}>—</span>;
    const big = used && used.size > 300;
    const hit = active && used.row === row.name && used.material === mat;
    const show = v[0] === v[1] ? `${v[0]}` : `${v[0]} / ${v[1]}`;
    return (
      <span style={hit ? {
        background: HL.used.bg, border: `1px solid ${HL.used.line}`, color: HL.used.text,
        borderRadius: 3, padding: "1px 5px", fontWeight: 700,
      } : undefined}>
        {hit && v[0] !== v[1] ? (
          <>
            <span style={{ opacity: big ? 0.4 : 1, textDecoration: big ? "line-through" : "none" }}>{v[0]}</span>
            {" / "}
            <span style={{ opacity: big ? 1 : 0.4, textDecoration: big ? "none" : "line-through" }}>{v[1]}</span>
          </>
        ) : show}
      </span>
    );
  };
  return (
    <RefCard title={t.ref.replace("IEC 60364-5-54 ", "")} source={t.title}
      note={t.hint} open={!!active} emphasis={!!active}>
      <table style={{ borderCollapse: "collapse", font: "11.5px var(--mono)", minWidth: 480 }}>
        <thead>
          <tr style={{ color: C.muted, font: "600 10.5px system-ui" }}>
            <th style={{ textAlign: "left", padding: "4px 10px 4px 0" }}>Conductor insulation</th>
            <th style={{ padding: "4px 8px" }}>θi °C</th>
            <th style={{ padding: "4px 8px" }}>θf °C</th>
            <th style={{ padding: "4px 8px" }}>Copper</th>
            <th style={{ padding: "4px 8px" }}>Aluminium</th>
            <th style={{ padding: "4px 8px" }}>Steel</th>
          </tr>
        </thead>
        <tbody>
          {t.rows.map((r) => {
            const hit = active && used.row === r.name;
            return (
              <tr key={r.ins} style={{ borderTop: `1px solid ${C.line}`,
                background: hit ? "rgba(79,176,106,0.07)" : undefined }}>
                <td style={{ padding: "4px 10px 4px 0", color: hit ? C.text : C.muted,
                  font: "11px system-ui", whiteSpace: "nowrap" }}>{r.name}</td>
                <td style={{ padding: "4px 8px", textAlign: "center" }}>{r.ti}</td>
                <td style={{ padding: "4px 8px", textAlign: "center" }}>
                  {r.tfBy ? Object.values(r.tfBy).join(" / ")
                    : r.tf[0] === r.tf[1] ? r.tf[0] : `${r.tf[0]} / ${r.tf[1]}`}
                </td>
                <td style={{ padding: "4px 8px", textAlign: "center" }}>{cell(r, "copper")}</td>
                <td style={{ padding: "4px 8px", textAlign: "center" }}>{cell(r, "aluminium")}</td>
                <td style={{ padding: "4px 8px", textAlign: "center" }}>{cell(r, "steel")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ font: "10.5px/1.5 system-ui", color: C.muted, marginTop: 7 }}>
        Where two values are printed, the lower one applies above 300 mm². The struck-through
        figure is the one that does <i>not</i> apply at the size in use.
      </div>
    </RefCard>
  );
}

function PeTableCard({ used }) {
  return (
    <RefCard title="Table 54.2" source="Minimum cross-sectional area of protective conductors"
      note={"The alternative to calculating, written into the standard. It is generous at small "
        + "sizes and tight at large ones, which is why 543.1.2 lets you calculate instead — and "
        + "why this tool runs both and takes the larger."}
      open={!!used} emphasis={!!used}>
      <table style={{ borderCollapse: "collapse", font: "12px var(--mono)", minWidth: 420 }}>
        <thead>
          <tr style={{ color: C.muted, font: "600 10.5px system-ui" }}>
            <th style={{ textAlign: "left", padding: "4px 14px 4px 0" }}>Line conductor S</th>
            <th style={{ textAlign: "left", padding: "4px 14px" }}>PE of the same material</th>
            <th style={{ textAlign: "left", padding: "4px 0" }}>PE of a different material</th>
          </tr>
        </thead>
        <tbody>
          {PE_TABLE_54_2.rows.map((r) => {
            const hit = used && used.row === r.label;
            const st = hit ? { background: HL.used.bg, color: HL.used.text, fontWeight: 700 } : undefined;
            return (
              <tr key={r.label} style={{ borderTop: `1px solid ${C.line}` }}>
                <td style={{ padding: "5px 14px 5px 0", ...st }}>{r.label}</td>
                <td style={{ padding: "5px 14px", ...st }}>{r.same}</td>
                <td style={{ padding: "5px 0", ...st }}>
                  {r.same === "16" ? "(k₁/k₂) × 16" : r.same === "S" ? "(k₁/k₂) × S" : "(k₁/k₂) × S/2"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ font: "10.5px/1.5 system-ui", color: C.muted, marginTop: 7 }}>
        k₁ is the line conductor's k, k₂ the protective conductor's. Where both are the same
        material the ratio is 1 and the correction drops out, which is why most references
        quote the rule as simply S/2.
      </div>
    </RefCard>
  );
}

/* ---------------------------------------------------------------
   The tab
   --------------------------------------------------------------- */

export function FaultStudyTab({ st, set }) {
  const net = st && st.nodes ? st : defaultNetwork();
  const narrow = useNarrow(760);
  const [openNode, setOpenNode] = useState(net.nodes[0]?.id ?? null);
  const [sel, setSel] = useState(net.nodes[0]?.id ?? null);

  const setSrc = (patch) => set({ ...net, source: { ...net.source, ...patch } });
  const setNode = (id, next) => set({ ...net, nodes: net.nodes.map((n) => (n.id === id ? next : n)) });
  const addNode = () => {
    const id = `n${Date.now().toString(36)}`;
    const parent = net.nodes.length ? (net.nodes.find((n) => n.id === sel)?.kind === "board" ? sel : null) : null;
    const node = {
      id, name: `Board ${net.nodes.length + 1}`, kind: "board", parent,
      cable: { size: 95, material: "copper", insulation: "xlpe", kTable: "a544",
               peSize: 50, peMaterial: "copper", lengthM: 50, parallel: 1,
               arrangement: "multicore", operatingC: 90 },
      device: { ratingA: 160, magneticMultiple: 10, clearingS: 0.1, backupS: 5, icuKa: 36 },
    };
    set({ ...net, nodes: [...net.nodes, node] });
    setOpenNode(id); setSel(id);
  };
  const removeNode = (id) => {
    /* Anything hanging off a removed board is re-parented to that
       board's own parent rather than orphaned, because silently
       dropping half the network off the results would be worse than
       moving it up one level and saying nothing. */
    const gone = net.nodes.find((n) => n.id === id);
    set({ ...net, nodes: net.nodes.filter((n) => n.id !== id)
      .map((n) => (n.parent === id ? { ...n, parent: gone?.parent ?? null } : n)) });
    if (sel === id) setSel(null);
  };

  const solved = useMemo(() => solveNetwork(net), [net]);
  const checks = useMemo(() => {
    const m = new Map();
    for (const n of net.nodes) {
      if (!solved.nodes.has(n.id)) continue;
      m.set(n.id, checkCable({ node: n, solved, source: solved.source }));
    }
    return m;
  }, [net, solved]);

  const src = solved.source;
  const srcAtC1 = useMemo(() => (net.source.kind === "grid" ? null
    : transformerSource({ kva: net.source.kva, ukPct: net.source.ukPct, uSecV: net.source.uSecV,
                          xOverR: net.source.xOverR, c: 1 })), [net.source]);

  const selNode = net.nodes.find((n) => n.id === sel) || null;
  const selChk = sel ? checks.get(sel) : null;

  const rows = net.nodes.filter((n) => checks.has(n.id)).map((n) => ({ n, c: checks.get(n.id) }));

  const cols = [
    { key: "name", label: "Node", render: ({ n, c }) => (
      <span style={{ paddingLeft: narrow ? 0 : (c.rec.depth - 1) * 12 }}>
        {c.rec.depth > 1 && !narrow ? "└ " : ""}{n.name || n.id}
      </span>) },
    { key: "cable", label: "Cable", render: ({ n }) =>
      `${n.cable.size ?? "?"} mm² ${(n.cable.material || "cu").slice(0, 2)} / ${n.cable.peSize ?? "?"} PE, ${n.cable.lengthM ?? "?"} m` },
    { key: "ik3", label: "Ik3 max", render: ({ c }) => amps(c.rec.ik3max) },
    { key: "ik1", label: "Ik1 min", render: ({ c }) => amps(c.rec.ik1min) },
    { key: "t", label: "Clears in", render: ({ c }) => `${c.dev.t} s` },
    { key: "line", label: "Line conductor", render: ({ c }) => (
      <Chip state={c.line.pass}>{c.line.miss ? "—" : `${c.line.sMin} vs ${c.line.installed} mm²`}</Chip>) },
    { key: "pe", label: "Protective conductor", render: ({ c }) => (
      <Chip state={c.peOk}>{`${c.peRequired} vs ${n0(c.rec && net.nodes.find((x) => x.id === c.rec.id)?.cable.peSize, 0) || "?"} mm²`}</Chip>) },
    { key: "dev", label: "Device", render: ({ c }) => (
      <Chip state={c.dev.reaches === null ? null : c.dev.reaches && (c.dev.breaking ? c.dev.breaking.pass : true)}>
        {c.dev.reaches === null ? "no rating" : !c.dev.reaches ? "will not trip"
          : c.dev.breaking && !c.dev.breaking.pass ? "Icu too low" : "clears"}
      </Chip>) },
  ];

  /* Everything wrong with the network, gathered in one place rather
     than scattered down the table, because a fault study that needs
     scrolling to find its own failures is not doing its job. */
  const problems = [];
  if (src.miss) problems.push(`The source is incomplete: give it ${src.miss}.`);
  for (const { n, c } of rows) {
    const who = n.name || n.id;
    for (const m of c.miss) problems.push(`${who}: ${m}.`);
    if (c.line.pass === false) problems.push(
      `${who}: the ${c.line.installed} mm² line conductor needs to be ${c.line.standard} mm² to `
      + `survive ${amps(c.rec.ik3max)} for ${c.dev.t} s.`);
    if (c.peOk === false) problems.push(
      `${who}: the protective conductor needs to be ${c.peStandard} mm², governed by `
      + `${c.governedBy === "table" ? "Table 54.2" : "the adiabatic check"}.`);
    if (c.dev.reaches === false) problems.push(
      `${who}: ${amps(c.rec.ik1min)} of earth-fault current does not reach the device's `
      + `${Math.round(c.dev.trip)} A instantaneous threshold, so it will not disconnect quickly.`);
    if (c.dev.breaking && !c.dev.breaking.pass) problems.push(
      `${who}: the device breaks ${c.dev.breaking.icuA / 1000} kA and the fault level here is `
      + `${amps(c.rec.ik3max)}.`);
  }
  for (const o of solved.orphans) problems.push(`${o} is fed from a node that no longer exists.`);

  return (
    <Page wide>
      <div className="tbl" style={{ marginBottom: 10 }}>
        FAULT STUDY — CASCADING FAULT LEVELS, IEC 60909 AND IEC 60364-5-54
      </div>
      <div className="readout" style={{ marginBottom: 12 }}>
        Build the network downwards from the transformer. Each cable gets the fault current that
        actually reaches it, and three questions are asked of it: does the line conductor survive
        the fault for as long as the device takes to clear, is the protective conductor big enough
        by both Table 54.2 and the adiabatic equation, and <b>will the device operate at all</b>.
        The last one catches what the others miss — a long circuit can be thermally safe and still
        never disconnect.
      </div>

      <Section code="F1" title="The source">
        <Sel label="Supply is" value={net.source.kind || "tx"}
          options={[{ value: "tx", label: "A transformer" }, { value: "grid", label: "A network fault level" }]}
          onChange={(v) => setSrc({ kind: v })} />
        {net.source.kind === "grid" ? (
          <Num label="Fault level at the point of supply" unit="MVA" value={n0(net.source.skMva, 500)}
            step={10} onChange={(v) => setSrc({ skMva: v })} />
        ) : (
          <>
            <Num label="Transformer rating" unit="kVA" value={n0(net.source.kva)} step={50}
              onChange={(v) => setSrc({ kva: v })} />
            <Num label="Impedance uk" unit="%" value={n0(net.source.ukPct)} step={0.1}
              onChange={(v) => setSrc({ ukPct: v })} />
            <Num label="X/R ratio" unit="" value={n0(net.source.xOverR, 10)} step={1}
              onChange={(v) => setSrc({ xOverR: v })} />
          </>
        )}
        <Num label="Secondary voltage, line to line" unit="V" value={n0(net.source.uSecV, 400)} step={10}
          onChange={(v) => setSrc({ uSecV: v })} />
        <Num label="Phase voltage U₀" unit="V" value={n0(net.source.u0V, 230)} step={5}
          onChange={(v) => setSrc({ u0V: v })} />

        {src.miss ? (
          <div className="warn" style={{ width: "100%", marginTop: 8 }}>
            The source needs {src.miss} before anything downstream can be worked out.
          </div>
        ) : (
          <div style={{ width: "100%", marginTop: 10 }}>
            <Derivation n="1" title="Fault level at the source terminals"
              cite="IEC 60909-0"
              formula={net.source.kind === "grid"
                ? "Z = c · U² / S_k        I_k = c · U / (√3 · Z)"
                : "Z = (u_k / 100) · U² / S        I_k = c · U / (√3 · Z)"}
              subs={src.arithmetic}
              result={`${amps(src.ik3max)} three-phase at c = ${C_FACTOR.max}`
                + (srcAtC1 ? `   ·   ${amps(srcAtC1.ik3)} at c = 1.00` : "")}
              why={"IEC 60909 applies a voltage factor c because the nominal voltage is not the "
                + "worst case. c = 1.05 raises the fault current for rating equipment; c = 0.95 "
                + "lowers it for checking that a device still operates. A hand calculation at "
                + "c = 1.00 sits between the two, which is why both are shown rather than one."} />
            {net.source.kind !== "grid" && (
              <div className="readout">
                Rated current <b>{Math.round(src.iRated)} A</b>, and the fault level is{" "}
                <b>{Math.round(src.ik3max / src.iRated)}×</b> that — which is simply 100/u_k adjusted
                for c, and a useful sanity check on the impedance entered.
              </div>
            )}
          </div>
        )}
      </Section>

      <Section code="F2" title="The network">
        <div style={{ width: "100%", display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
          <button className="btn primary" onClick={addNode}>Add a board or circuit</button>
          <button className="btn" onClick={() => set(defaultNetwork())}>Reset to the worked example</button>
        </div>
        <div style={{ width: "100%" }}>
          {net.nodes.map((n) => (
            <NodeCard key={n.id} node={n} all={net.nodes} result={checks.get(n.id)}
              open={openNode === n.id} onToggle={() => { setOpenNode(openNode === n.id ? null : n.id); setSel(n.id); }}
              onChange={(next) => setNode(n.id, next)} onRemove={() => removeNode(n.id)} />
          ))}
          {!net.nodes.length && (
            <div className="readout">Nothing on the network yet. Add a board to start.</div>
          )}
        </div>
      </Section>

      <Section code="F3" title="Every node, every check">
        {rows.length ? (
          <div style={{ width: "100%" }}>
            <Rows cols={cols} rows={rows} keyOf={({ n }) => n.id} primary={0} min={860}
              rowStyle={({ n }) => (n.id === sel ? { outline: `1px solid ${C.accent}` } : null)} />
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
              <span style={{ font: "10.5px system-ui", color: C.muted, alignSelf: "center" }}>
                Show the working for:
              </span>
              {net.nodes.filter((n) => checks.has(n.id)).map((n) => (
                <button key={n.id} className={`btn${sel === n.id ? " on" : ""}`}
                  onClick={() => setSel(n.id)}>{n.name || n.id}</button>
              ))}
            </div>
          </div>
        ) : (
          <div className="readout">No node reaches the source yet.</div>
        )}

        {problems.length > 0 && (
          <div className="warns" style={{ marginTop: 10 }}>
            {problems.map((p, i) => <div className="warn" key={i}>{p}</div>)}
          </div>
        )}
        {!problems.length && rows.length > 0 && (
          <div className="readout" style={{ marginTop: 10, border: `1px solid ${HL.used.line}` }}>
            Every cable on the network survives its fault, every protective conductor meets the
            larger of Table 54.2 and the adiabatic requirement, and every device both sees enough
            current to operate and can break what is there.
          </div>
        )}
      </Section>

      {selNode && selChk && (
        <Section code="F4" title={`The working — ${selNode.name || selNode.id}`}>
          <div style={{ width: "100%" }}>
            <Derivation n="2" title="Impedance back to the source"
              formula="Z = √(R² + X²),  accumulated from the source down"
              subs={`R = ${ohms(selChk.rec.rMax)} at 20 °C, X = ${ohms(selChk.rec.xMax)} `
                + `→ Z = ${ohms(selChk.rec.zMax)};  earth loop at ${n0(selNode.cable.operatingC, 90)} °C `
                + `= ${ohms(selChk.rec.zLoopMin)}`}
              result={`${amps(selChk.rec.ik3max)} three-phase   ·   ${amps(selChk.rec.ik1min)} line to earth`}
              why={"Two currents, and they are not interchangeable. The three-phase figure is taken "
                + "with the conductors cold, because cold copper has the least resistance and so "
                + "passes the most current — that is the number the conductor has to survive. The "
                + "earth-fault figure is taken hot, and over the line plus the protective conductor, "
                + "because that is the smallest current the device will ever have to detect."} />

            <Derivation n="3" title="Line conductor withstand"
              cite={`${selChk.lineK.ref} · k = ${selChk.lineK.k ?? "—"}`}
              formula="S ≥ √(I² · t) / k"
              subs={selChk.line.miss ? "Not enough entered yet." : selChk.line.arithmetic}
              result={selChk.line.miss ? null
                : `needs ${selChk.line.sMin} mm², has ${selChk.line.installed} mm²`
                  + ` — would hold this fault for ${selChk.line.tWithstand} s`}
              state={selChk.line.pass} verdict={selChk.line.pass === null ? "no verdict"
                : selChk.line.pass ? "passes" : "fails"}
              why={"The conductor is allowed to heat from its operating temperature to the point "
                + "its insulation is damaged, and no further. Nothing about normal running reveals "
                + "a failure here. On the source fault level instead of the local one — the more "
                + `conservative basis a hand calculation usually takes — it would need `
                + `${selChk.lineConservative ? `${selChk.lineConservative.sMin} mm².` : "—"}`} />

            <Derivation n="4" title="Protective conductor, by Table 54.2"
              cite={selChk.table.ref}
              formula={selChk.table.differing ? "S_pe = (k₁/k₂) × (rule for the band)" : "the rule for the band"}
              subs={`${selChk.table.row}: ${selChk.table.arithmetic}`}
              result={`${selChk.table.standard} mm² at the next standard size`}
              why={"A rule of thumb written into the standard, so that a design does not have to "
                + "calculate. It knows nothing about the fault current actually present, which is "
                + "why it is checked against the adiabatic figure below rather than trusted alone."} />

            <Derivation n="5" title="Protective conductor, by calculation"
              cite={`${selChk.peK.ref} · k = ${selChk.peK.k ?? "—"}`}
              formula="S ≥ √(I² · t) / k,  on the earth-fault current"
              subs={selChk.pe.miss ? "Not enough entered yet." : selChk.pe.arithmetic}
              result={selChk.pe.miss ? null : `needs ${selChk.pe.sMin} mm²`}
              why={"543.1.2. The earth-fault current is the one this conductor carries, not the "
                + "three-phase current, and it is the smaller of the two — but the protective "
                + "conductor is usually the smaller conductor too."} />

            <Derivation n="6" title="Protective conductor, the governing figure"
              formula="S_pe = max(Table 54.2, adiabatic)"
              subs={`max(${selChk.table.raw ?? "—"}, ${selChk.pe.sMin ?? "—"}) = ${selChk.peRequired} mm², `
                + `governed by ${selChk.governedBy === "table" ? "Table 54.2" : "the adiabatic check"}`}
              result={`${selChk.peStandard} mm² required, ${selNode.cable.peSize ?? "—"} mm² installed`}
              state={selChk.peOk} verdict={selChk.peOk === null ? "no verdict" : selChk.peOk ? "passes" : "fails"}
              why={"Neither alone is sufficient. Table 54.2 is generous on a small conductor and can "
                + "be badly short on a large one close to a transformer; the adiabatic figure knows "
                + "the fault current but not the mechanical and continuity reasons the table exists. "
                + "The larger of the two is the only defensible answer."} />

            <Derivation n="7" title="Will the device clear it"
              formula="I_inst = rating × multiple,  compared against the minimum earth-fault current"
              subs={selChk.dev.trip === null ? "No device rating entered."
                : `${Math.round(selChk.dev.trip)} A threshold against ${amps(selChk.rec.ik1min)} available`}
              result={`clearing time used in the checks above: ${selChk.dev.t} s`}
              state={selChk.dev.reaches} verdict={selChk.dev.reaches === null ? "no verdict"
                : selChk.dev.reaches ? "operates" : "will not operate"}
              why={selChk.dev.why} />

            {selChk.dev.breaking && (
              <Derivation n="8" title="Can the device break it"
                formula="I_cu ≥ I_k3 max at this point"
                subs={`${selChk.dev.breaking.icuA / 1000} kA rated against ${amps(selChk.dev.breaking.ik3max)} present`}
                state={selChk.dev.breaking.pass}
                verdict={selChk.dev.breaking.pass ? "adequate" : "under-rated"}
                why={"Interrupting capacity is a separate question from operating. A device that "
                  + "sees the fault and tries to break more than it is rated for does not clear it; "
                  + "it fails, and the fault carries on behind a device that looks closed."} />
            )}
          </div>
        </Section>
      )}

      <Section code="F5" title="The tables these were read from">
        <div style={{ width: "100%" }}>
          <PeTableCard used={selChk ? selChk.table : null} />
          {K_TABLE_LIST.map((id) => (
            <KTableCard key={id} tableId={id}
              used={selChk ? { ...selChk.lineK, size: selNode?.cable?.size } : null} />
          ))}
          <div className="readout" style={{ marginTop: 4 }}>
            Highlighted in green is the cell read for the <b>line conductor</b> of the node selected
            above. The protective conductor is read from{" "}
            <b>{selChk ? selChk.peK.ref.replace("IEC 60364-5-54 ", "") : "its own table"}</b>
            {selChk && selChk.peK.k ? ` at k = ${selChk.peK.k}` : ""} — the same tables, a different
            row where the earth sits somewhere else in the cable.
          </div>
        </div>
      </Section>
    </Page>
  );
}
