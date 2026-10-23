/* =====================================================================
   PROJECT TRACKER TAB

   Drop a PVsyst simulation report in, get a project record out. The
   question it exists to answer is "what did the last fifteen prelims
   actually yield, and why did that one come out low" — which is a
   question about a set of reports, not about any one of them.

   Three conventions carried over from the rest of the application:

   - Every value shows the line of the report it was read from. A figure
     you cannot trace is a figure you cannot defend.
   - A field that could not be read is said to be missing, never shown
     as zero. Across a comparison table a silent zero is a lie that
     moves an average.
   - A re-import makes a new record rather than overwriting the old one,
     and the pair is flagged as a duplicate. Which one is current is a
     judgement, and the change between them is usually the information.
   ===================================================================== */

import React, { useMemo, useRef, useState } from "react";
import { fmt, C, Sel, Section, Page, Working, Rows, WarnList, useNarrow } from "./ui.jsx";
import { extractPdfText } from "./pdfText.js";
import {
  parsePvsystReport, recordFromReport, recordTitle, findDuplicates,
  lossMatrix, fieldSpread, projectsToCsv, projectsToJson, projectsFromJson,
  REPORT_FIELDS, FIELD_GROUPS, FIELD_BY_KEY,
} from "./pvsystReport.js";

const TONE = { ok: "#4fb06a", warn: "#e0a63a", bad: "#d64545" };

/* A tracker is worth nothing if it empties on refresh, so the records
   live in localStorage. That is a browser, not a filing cabinet — the
   JSON export is the real archive, and the interface says so rather
   than letting the user find out when they change machine. */
const KEY = "pvhub.tracker.v1";
export function loadTracked() {
  try {
    const raw = window.localStorage.getItem(KEY);
    const v = raw ? JSON.parse(raw) : null;
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}
function saveTracked(records) {
  try { window.localStorage.setItem(KEY, JSON.stringify(records)); return true; }
  catch (e) { return false; }
}

const val = (rec, key) => {
  const f = FIELD_BY_KEY[key];
  const v = rec.fields[key];
  if (v === undefined || v === null || v === "") return null;
  if (f && f.kind === "text") return String(v);
  return typeof v === "number" ? fmt(v, f && typeof f.dp === "number" ? f.dp : 2) : String(v);
};

const Missing = () => (
  <span style={{ font: "10.5px system-ui", color: C.muted, fontStyle: "italic" }}>not in report</span>
);

const Stat = ({ label, value, unit, tone }) => (
  <div style={{ background: C.panel2, border: `1px solid ${tone || C.line}`, borderRadius: 6,
    padding: "8px 11px", minWidth: 112 }}>
    <div style={{ font: "10.5px system-ui", color: C.muted }}>{label}</div>
    <div style={{ font: "650 17px var(--mono)", color: tone || C.text }}>
      {value}<span style={{ font: "10.5px system-ui", color: C.muted }}> {unit}</span>
    </div>
  </div>
);

/* ---------- where the projects are ---------------------------------
   An equirectangular plot of each report's own latitude and longitude,
   on a labelled graticule.

   It is deliberately not a map. Drawing coastlines would mean either a
   tile service — and this application makes no network call, so that
   would be the only part of it that stops working on a plane — or
   embedding outline data, and a coastline sketched from memory is worse
   than none: it looks authoritative and is wrong. A graticule with the
   degrees written on it locates a project exactly, because the numbers
   are the report's own. GAPS has the note about adding a real basemap.
   ------------------------------------------------------------------ */
function SiteMap({ records, selectedId, onPick }) {
  const W = 720, H = 364, PAD = 30;
  const X = (lon) => PAD + (lon + 180) * ((W - PAD * 2) / 360);
  const Y = (lat) => PAD + (90 - lat) * ((H - PAD * 2) / 180);
  const pts = records
    .map((r) => ({ r, lat: r.fields.lat, lon: r.fields.lon }))
    .filter((p) => typeof p.lat === "number" && typeof p.lon === "number");
  const noGeo = records.length - pts.length;
  const LATS = [-60, -30, 0, 30, 60], LONS = [-120, -60, 0, 60, 120];
  const deg = (v, pos, neg) => `${Math.abs(v)}°${v === 0 ? "" : v > 0 ? pos : neg}`;
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto",
        background: "#101317", border: `1px solid ${C.line}`, borderRadius: 7 }}>
        <rect x={PAD} y={PAD} width={W - PAD * 2} height={H - PAD * 2}
          fill="#0d1014" stroke="#242c38" />
        {LATS.map((la) => (
          <g key={`la${la}`}>
            <line x1={PAD} y1={Y(la)} x2={W - PAD} y2={Y(la)}
              stroke={la === 0 ? "#33506b" : "#1d242e"} strokeWidth={la === 0 ? 1 : 0.6} />
            <text x={PAD - 5} y={Y(la) + 3.5} textAnchor="end" fill={C.muted}
              style={{ font: "10.5px var(--mono)" }}>{deg(la, "N", "S")}</text>
          </g>
        ))}
        {LONS.map((lo) => (
          <g key={`lo${lo}`}>
            <line x1={X(lo)} y1={PAD} x2={X(lo)} y2={H - PAD}
              stroke={lo === 0 ? "#33506b" : "#1d242e"} strokeWidth={lo === 0 ? 1 : 0.6} />
            <text x={X(lo)} y={H - PAD + 14} textAnchor="middle" fill={C.muted}
              style={{ font: "10.5px var(--mono)" }}>{deg(lo, "E", "W")}</text>
          </g>
        ))}
        {/* The tropics and the equator are the one piece of geography
            that actually bears on a PV yield, so they are the one piece
            drawn. */}
        {[23.44, -23.44].map((t) => (
          <line key={t} x1={PAD} y1={Y(t)} x2={W - PAD} y2={Y(t)}
            stroke="#2d3b2f" strokeWidth={0.8} strokeDasharray="4 4" />
        ))}
        <text x={W - PAD - 4} y={Y(23.44) - 4} textAnchor="end" fill="#4d6b52"
          style={{ font: "10.5px system-ui" }}>Tropics</text>
        {pts.map(({ r, lat, lon }) => {
          const on = r.id === selectedId;
          return (
            <g key={r.id} onClick={() => onPick(r.id)} style={{ cursor: "pointer" }}>
              <circle cx={X(lon)} cy={Y(lat)} r={on ? 7 : 4.5}
                fill={on ? C.accent : "#6fa8dc"} stroke="#0d1014" strokeWidth={1.2} />
              {on && (
                <text x={X(lon)} y={Y(lat) - 11} textAnchor="middle" fill={C.accent}
                  style={{ font: "11px system-ui" }}>
                  {r.fields.siteName || r.fields.project}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 8 }}>
        {pts.map(({ r, lat, lon }) => (
          <button key={r.id} className="btn" onClick={() => onPick(r.id)}
            style={{ font: "10.5px system-ui", padding: "4px 9px",
              borderColor: r.id === selectedId ? C.accent : undefined,
              color: r.id === selectedId ? C.accent : undefined }}>
            {r.fields.siteName || r.fields.project}
            <span style={{ color: C.muted, fontFamily: "var(--mono)" }}>
              {"  "}{fmt(Math.abs(lat), 2)}°{lat >= 0 ? "N" : "S"}{" "}
              {fmt(Math.abs(lon), 2)}°{lon >= 0 ? "E" : "W"}
            </span>
          </button>
        ))}
      </div>
      <div style={{ font: "10.5px/1.6 system-ui", color: C.muted, marginTop: 7 }}>
        {pts.length} of {records.length} plotted from the latitude and longitude in the report
        itself.{noGeo > 0 && ` ${noGeo} carried no coordinates.`} This is a coordinate plot, not
        a map: there are no coastlines because drawing them would need either a tile service —
        and nothing else here touches the network — or outline data sketched from memory, which
        looks authoritative and is wrong. The degrees are exact.
      </div>
    </>
  );
}

/* ---------- the tab ------------------------------------------------- */

export function ProjectTrackerTab() {
  const [records, setRecords] = useState(() => loadTracked());
  const [busy, setBusy] = useState(null);
  const [problems, setProblems] = useState([]);
  const [selected, setSelected] = useState(null);
  const [compareKey, setCompareKey] = useState("specificYield");
  const [drag, setDrag] = useState(false);
  const fileRef = useRef(null);
  const narrow = useNarrow(760);

  const commit = (next) => {
    setRecords(next);
    if (!saveTracked(next)) {
      setProblems((p) => [...p, "The browser refused to save — the list is in this tab only. "
        + "Export it before you close the page."]);
    }
  };

  const ingest = async (files) => {
    const list = [...files];
    if (!list.length) return;
    const added = [];
    const bad = [];
    for (let i = 0; i < list.length; i += 1) {
      const file = list[i];
      setBusy(`Reading ${file.name} (${i + 1} of ${list.length})`);
      try {
        if (/\.json$/i.test(file.name)) {
          const res = projectsFromJson(await file.text());
          if (!res.ok) { bad.push(`${file.name}: ${res.error}`); continue; }
          added.push(...res.records);
          if (res.skipped) bad.push(`${file.name}: ${res.skipped} entries were not projects and were skipped.`);
          continue;
        }
        const buf = new Uint8Array(await file.arrayBuffer());
        const text = await extractPdfText(buf);
        const parsed = parsePvsystReport(text);
        if (parsed.error) { bad.push(`${file.name}: ${parsed.error}`); continue; }
        const rec = recordFromReport(parsed, { fileName: file.name });
        if (!parsed.ok) {
          bad.push(`${file.name}: read, but incomplete — ${parsed.warnings[0] || "key fields missing"}`);
        }
        added.push(rec);
      } catch (e) {
        bad.push(`${file.name}: could not be read (${e && e.message ? e.message : "unknown error"}).`);
      }
    }
    setBusy(null);
    setProblems(bad);
    if (added.length) {
      const next = [...records, ...added];
      commit(next);
      setSelected(added[added.length - 1].id);
    }
  };

  const onDrop = (e) => {
    e.preventDefault(); setDrag(false);
    if (e.dataTransfer && e.dataTransfer.files) ingest(e.dataTransfer.files);
  };

  const remove = (id) => commit(records.filter((r) => r.id !== id));
  const setNote = (id, note) =>
    commit(records.map((r) => (r.id === id ? { ...r, note } : r)));

  const download = (name, text, type) => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const dupes = useMemo(() => findDuplicates(records), [records]);
  const losses = useMemo(() => lossMatrix(records), [records]);
  const spread = useMemo(() => fieldSpread(records, compareKey), [records, compareKey]);
  const current = records.find((r) => r.id === selected) || null;
  const numericFields = REPORT_FIELDS.filter((f) => f.kind !== "text");

  const headline = REPORT_FIELDS.filter((f) => f.headline);

  return (
    <Page wide>
      <div className="tbl">PROJECT TRACKER — WHAT EACH PRELIM ACTUALLY YIELDED</div>

      <Section code="T1" title="Drop your PVsyst reports in">
        <div
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
          style={{ border: `2px dashed ${drag ? C.accent : C.line}`, borderRadius: 9,
            padding: narrow ? "22px 14px" : "30px 20px", textAlign: "center",
            background: drag ? "rgba(232,130,12,0.07)" : C.panel2, marginBottom: 10 }}>
          <div style={{ font: "650 15px system-ui", color: drag ? C.accent : C.text }}>
            {drag ? "Drop to read" : "Drag PVsyst report PDFs here"}
          </div>
          <div style={{ font: "11px/1.6 system-ui", color: C.muted, margin: "7px auto 12px", maxWidth: 560 }}>
            The exported <em>Simulation report</em>, not the parameter sheet. Several at once is
            fine. A previously exported tracker <code>.json</code> can be dropped here too, to
            merge it back in.
          </div>
          <button className="btn" onClick={() => fileRef.current && fileRef.current.click()}>
            Choose files
          </button>
          <input ref={fileRef} type="file" accept=".pdf,.json" multiple style={{ display: "none" }}
            onChange={(e) => { ingest(e.target.files); e.target.value = ""; }} />
        </div>

        {busy && <Working label={busy} />}
        <WarnList items={problems} />

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button className="btn" disabled={!records.length}
            onClick={() => download("pvhub-tracker.json", projectsToJson(records), "application/json")}>
            Export JSON
          </button>
          <button className="btn" disabled={!records.length}
            onClick={() => download("pvhub-tracker.csv", projectsToCsv(records), "text/csv")}>
            Export CSV
          </button>
          <span style={{ font: "10.5px system-ui", color: C.muted, flex: 1, minWidth: 220 }}>
            The list is held in this browser, so it survives a refresh but not a new machine or a
            cleared cache. The JSON is the archive — keep it in version control beside the
            reports. The CSV flattens to one row per project for a spreadsheet, and drops the
            monthly tables and the source lines.
          </span>
        </div>

        {dupes.length > 0 && (
          <WarnList items={dupes.map((g) =>
            `"${recordTitle(g[0])}" appears ${g.length} times. Re-importing never overwrites, `
            + "because the difference between two runs of the same variant is usually the point. "
            + "Delete the stale one if it is not.")} />
        )}
      </Section>

      {records.length === 0 ? (
        <Section code="T2" title="Nothing tracked yet">
          <div className="readout" style={{ width: "100%", font: "10.5px/1.65 system-ui" }}>
            Drop a report above and this fills in. Until then every panel below is empty, which
            is the correct state rather than a broken one.
          </div>
        </Section>
      ) : (
        <>
          <Section code="T2" title={`The projects (${records.length})`}>
            <Rows
              min={980}
              keyOf={(r) => r.id}
              rows={records}
              rowStyle={(r) => (r.id === selected
                ? { borderColor: C.accent, background: "rgba(232,130,12,0.06)" } : null)}
              cols={[
                { key: "project", label: "Project",
                  render: (r) => (
                    <span onClick={() => setSelected(r.id)} style={{ cursor: "pointer" }}>
                      <span style={{ color: r.id === selected ? C.accent : C.text }}>
                        {r.fields.project || r.fileName || "Untitled"}
                      </span>
                      {r.fields.variant && (
                        <div style={{ font: "10.5px system-ui", color: C.muted }}>{r.fields.variant}</div>
                      )}
                    </span>
                  ) },
                ...headline.filter((f) => f.key !== "project").map((f) => ({
                  key: f.key, label: f.label, align: f.kind === "text" ? "left" : "right",
                  render: (r) => val(r, f.key) ?? <Missing />,
                })),
                { key: "missing", label: "Read", align: "right",
                  render: (r) => (r.missing.length
                    ? <span style={{ color: TONE.warn }}>{r.missing.length} missing</span>
                    : <span style={{ color: TONE.ok }}>complete</span>) },
                { key: "del", label: "", align: "right",
                  render: (r) => (
                    <button className="btn" onClick={() => remove(r.id)}
                      style={{ padding: "3px 9px", font: "10.5px system-ui" }}>✕</button>
                  ) },
              ]}
            />
            <div style={{ font: "10.5px system-ui", color: C.muted, marginTop: 8 }}>
              Pick a project to see every parameter it carries, with the line of the report each
              one was read from.
            </div>
          </Section>

          <Section code="T3" title="Where they are">
            <SiteMap records={records} selectedId={selected} onPick={setSelected} />
          </Section>

          <Section code="T4" title="Compare one parameter across the set">
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end",
              marginBottom: 10 }}>
              <Sel label="Parameter" value={compareKey} onChange={setCompareKey} width={260}
                options={numericFields.map((f) => ({ value: f.key, label: f.label }))} />
            </div>
            {spread.n === 0 ? (
              <div className="readout" style={{ width: "100%", font: "10.5px/1.6 system-ui" }}>
                None of the {records.length} reports carried that figure, so there is nothing to
                compare. That is the report's content, not a failure to read it.
              </div>
            ) : (
              <>
                <div style={{ display: "flex", gap: 9, flexWrap: "wrap", marginBottom: 10 }}>
                  <Stat label="Lowest" unit={FIELD_BY_KEY[compareKey].unit}
                    value={fmt(spread.min, FIELD_BY_KEY[compareKey].dp)} />
                  <Stat label="Mean" unit={FIELD_BY_KEY[compareKey].unit}
                    value={fmt(spread.mean, FIELD_BY_KEY[compareKey].dp)} />
                  <Stat label="Highest" unit={FIELD_BY_KEY[compareKey].unit}
                    value={fmt(spread.max, FIELD_BY_KEY[compareKey].dp)} tone={TONE.ok} />
                  <Stat label="Reports with it" unit={`of ${records.length}`} value={spread.n}
                    tone={spread.absent ? TONE.warn : undefined} />
                </div>
                <BarCompare records={records} fieldKey={compareKey}
                  selectedId={selected} onPick={setSelected} />
                {spread.absent > 0 && (
                  <div style={{ font: "10.5px system-ui", color: TONE.warn, marginTop: 7 }}>
                    ⚠ {spread.absent} report{spread.absent > 1 ? "s" : ""} did not carry this
                    figure and {spread.absent > 1 ? "are" : "is"} left out of the mean rather than
                    counted as zero.
                  </div>
                )}
              </>
            )}
          </Section>

          <Section code="T5" title="The loss diagrams side by side">
            {losses.length === 0 ? (
              <div className="readout" style={{ width: "100%", font: "10.5px/1.6 system-ui" }}>
                No loss diagrams were read from these reports.
              </div>
            ) : (
              <>
                <div style={{ font: "10.5px/1.6 system-ui", color: C.muted, marginBottom: 8 }}>
                  Every row PVsyst printed, in the order the first report lists them. A blank cell
                  means that report has no such row — not that the loss was zero, which is a
                  different claim and would move any average taken across the column.
                </div>
                <Rows
                  min={300 + records.length * 110}
                  keyOf={(l) => l.key}
                  rows={losses}
                  cols={[
                    { key: "label", label: "Loss row" },
                    ...records.map((r, i) => ({
                      key: `r${i}`, align: "right",
                      label: r.fields.project || r.fileName || `#${i + 1}`,
                      render: (l) => (l.values[i] === null
                        ? <Missing />
                        : <span style={{ color: l.values[i] > 0 ? TONE.ok : C.text }}>
                            {fmt(l.values[i], 2)}%
                          </span>),
                    })),
                  ]}
                />
              </>
            )}
          </Section>

          {current && (
            <Section code="T6" title={`Everything in: ${recordTitle(current)}`}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
                <input value={current.note} placeholder="A note to your future self about this run"
                  onChange={(e) => setNote(current.id, e.target.value)}
                  style={{ flex: 1, minWidth: 240, background: C.panel2, color: C.text,
                    border: `1px solid ${C.line}`, borderRadius: 6, padding: "7px 10px",
                    font: "12px system-ui" }} />
              </div>

              {current.warnings.length > 0 && <WarnList items={current.warnings} />}

              {FIELD_GROUPS.map(([gid, gname]) => {
                const fs = REPORT_FIELDS.filter((f) => f.group === gid);
                return (
                  <div key={gid} style={{ marginBottom: 14 }}>
                    <div style={{ font: "650 11.5px system-ui", color: C.accent,
                      letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 6 }}>
                      {gname}
                    </div>
                    <Rows
                      min={760}
                      keyOf={(f) => f.key}
                      rows={fs}
                      cols={[
                        { key: "label", label: "Parameter" },
                        { key: "value", label: "Value", align: "right",
                          render: (f) => {
                            const v = val(current, f.key);
                            return v === null ? <Missing />
                              : <span style={{ font: "650 12.5px var(--mono)" }}>
                                  {v}{f.unit ? <span style={{ font: "10.5px system-ui",
                                    color: C.muted }}> {f.unit}</span> : null}
                                </span>;
                          } },
                        { key: "src", label: "Read from this line in the report", hideNarrow: false,
                          render: (f) => (
                            <span style={{ font: "10.5px var(--mono)", color: C.muted }}>
                              {current.src[f.key] || "—"}
                            </span>
                          ) },
                      ]}
                    />
                  </div>
                );
              })}

              {current.monthly.length > 0 && (
                <>
                  <div style={{ font: "650 11.5px system-ui", color: C.accent,
                    letterSpacing: "0.06em", textTransform: "uppercase", margin: "4px 0 6px" }}>
                    Monthly balance
                  </div>
                  <Rows
                    min={120 + current.monthlyCols.length * 80}
                    keyOf={(m) => m.month}
                    rows={current.monthly}
                    cols={[
                      { key: "month", label: "Month" },
                      ...current.monthlyCols.map((c) => ({
                        key: c, label: c, align: "right",
                        render: (m) => (m[c] === undefined ? <Missing /> : fmt(m[c], 1)),
                      })),
                    ]}
                  />
                  <div style={{ font: "10.5px system-ui", color: C.muted, marginTop: 6 }}>
                    Column names are read off the report's own header row, because the set
                    changes with the system type — a self-consumption run carries
                    <code> EFrGrid</code> columns a grid-feed run does not, and reading a
                    fixed slot would return the wrong series without saying so.
                  </div>
                </>
              )}

              {current.missing.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ font: "650 11.5px system-ui", color: TONE.warn,
                    letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 6 }}>
                    Not found in this report ({current.missing.length})
                  </div>
                  <div style={{ font: "10.5px/1.7 system-ui", color: C.muted }}>
                    {current.missing.map((k) => (FIELD_BY_KEY[k] ? FIELD_BY_KEY[k].label : k)).join(" · ")}
                    <div style={{ marginTop: 5 }}>
                      These are listed rather than filled with zeros. A PVsyst report's section
                      set depends on the system — a tracker plant, a stand-alone system or a
                      different PVsyst version each print a different page, and a reader that
                      invented a value here would corrupt every comparison above.
                    </div>
                  </div>
                </div>
              )}
            </Section>
          )}
        </>
      )}

      <Section code="T7" title="What this tool does not do">
        <div className="readout" style={{ width: "100%", font: "10.5px/1.65 system-ui" }}>
          <p><strong style={{ color: C.accent }}>It reads the report, it does not check it.</strong>{" "}
          Everything here is PVsyst's own output taken at face value. If the simulation used the
          wrong weather file or a shading scene that does not match the site, the tracker will
          faithfully record the consequences.</p>
          <p><strong style={{ color: C.accent }}>It has been proven against one report layout.</strong>{" "}
          A grid-connected fixed-tilt run from PVsyst 8.1 parses completely. Tracker plants,
          stand-alone systems and older versions print different sections; those will read
          partially and say which fields they could not find. Send one that reads badly and the
          patterns can be widened — that is a cheap change.</p>
          <p><strong style={{ color: C.accent }}>It does not read a layout.</strong> A DXF import
          to show the plan beside the numbers is the obvious next step and is not built. The
          layout tools already read DXF, so the geometry side exists; what is missing is tying a
          drawing to a tracked project.</p>
          <p><strong style={{ color: C.accent }}>It stores in the browser.</strong> Same limitation
          as the costing quote library. Export the JSON and keep it with the reports.</p>
        </div>
      </Section>
    </Page>
  );
}

/* A plain horizontal bar per project. Hand-rolled like the rest of the
   charts here — no chart library in this application. */
function BarCompare({ records, fieldKey, selectedId, onPick }) {
  const f = FIELD_BY_KEY[fieldKey];
  const pts = records
    .map((r) => ({ r, v: r.fields[fieldKey] }))
    .filter((p) => typeof p.v === "number" && Number.isFinite(p.v));
  if (!pts.length) return null;
  const max = Math.max(...pts.map((p) => p.v), 0);
  const min = Math.min(...pts.map((p) => p.v), 0);
  const span = max - min || 1;
  const rowH = 26, padL = 4, W = 100;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {pts.map(({ r, v }) => {
        const on = r.id === selectedId;
        const pct = ((v - min) / span) * 100;
        return (
          <div key={r.id} onClick={() => onPick(r.id)}
            style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer",
              minHeight: rowH }}>
            <div style={{ width: 150, flexShrink: 0, font: "11px system-ui",
              color: on ? C.accent : C.muted, overflow: "hidden", textOverflow: "ellipsis",
              whiteSpace: "nowrap" }}>
              {r.fields.project || r.fileName}
            </div>
            <div style={{ flex: 1, background: C.panel2, borderRadius: 4, height: 16,
              position: "relative", minWidth: 60 }}>
              <div style={{ position: "absolute", left: padL, top: 2, bottom: 2,
                width: `${Math.max(1.5, pct * (W - 2) / W)}%`, background: on ? C.accent : "#4a6fa5",
                borderRadius: 3 }} />
            </div>
            <div style={{ width: 118, flexShrink: 0, textAlign: "right",
              font: "650 12px var(--mono)", color: on ? C.accent : C.text }}>
              {fmt(v, f.dp)}<span style={{ font: "10.5px system-ui", color: C.muted }}> {f.unit}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
