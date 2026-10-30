/* =====================================================================
   GUIDED FLOW TAB
   ---------------------------------------------------------------------
   Seven steps from a map pin to a quotable number. The engineering is
   all borrowed — string sizing from src/stringSizing.js, the sweep file
   from src/pvsystBatch.js, the temperature pull from src/pvgis.js — so
   nothing here can disagree with the full tools. See src/bdFlow.js for
   why the sweep comes before the layout.
   ===================================================================== */

import React, { useState } from "react";
import { fmt, C, Num, Section, Page, Working, WarnList } from "./ui.jsx";
import {
  STEPS, assess, stepState, nextStep, derive, summarise, sanityChecks,
} from "./bdFlow.js";
import { sizeStrings, RISE_TABLE } from "./stringSizing.js";
import { fetchEra5 } from "./pvgis.js";
import { buildBatchParamsCsv, paramById, range, pitchFromGap, GAP_DEFAULT } from "./pvsystBatch.js";

const TONE = { done: "#4fb06a", provisional: "#e0a63a", blocked: "#6b7480", todo: "#6fa8dc" };
const MARK = { done: "✓", provisional: "~", blocked: "·", todo: "•" };

function Txt({ label, value, onChange, placeholder, width = 200 }) {
  return (
    <label className="fld" style={{ width }}>
      <span className="fld-l">{label}</span>
      <span className="fld-box">
        <input type="text" value={value} placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)} />
      </span>
    </label>
  );
}

const Big = ({ label, value, unit, how, tone }) => (
  <div style={{ background: C.panel2, border: `1px solid ${tone || C.line}`, borderRadius: 7,
    padding: "10px 13px", minWidth: 150, flex: "1 1 150px" }}>
    <div style={{ font: "10.5px system-ui", color: C.muted }}>{label}</div>
    <div style={{ font: "650 20px var(--mono)", color: tone || C.text }}>
      {value}<span style={{ font: "11px system-ui", color: C.muted }}> {unit}</span>
    </div>
    {how && <div style={{ font: "10.5px system-ui", color: C.muted, marginTop: 3 }}>{how}</div>}
  </div>
);

export function BdFlowTab({ st, set }) {
  const p = st || {};
  const upd = (patch) => set({ ...p, ...patch });
  const g = (k, d) => (p[k] === undefined || p[k] === null ? d : p[k]);
  const [busy, setBusy] = useState(null);
  const [notes, setNotes] = useState([]);

  const state = assess(p);
  const d = derive(p);
  const sum = summarise(p);
  const checks = sanityChecks(p);
  const next = nextStep(state);

  /* --- step 1: coordinates, and the temperature extremes --- */
  const pullTemps = async () => {
    setBusy("Pulling ten years of daily extremes from ERA5…");
    setNotes([]);
    try {
      const e = await fetchEra5(p.lat, p.lon);
      upd({ tLo: e.lo, tHi: e.hi, tempPulled: true });
      setNotes([`ERA5 gives ${fmt(e.lo, 1)} °C to ${fmt(e.hi, 1)} °C over the last `
        + "ten years. These are the extremes the string sizing runs on, never an average."]);
    } catch (err) {
      setNotes([`The temperature pull failed (${err && err.message ? err.message : "no reply"}). `
        + "Type the extremes you have instead — the sizing runs the same either way, it "
        + "just cannot say where the numbers came from."]);
    } finally { setBusy(null); }
  };

  /* --- step 3: string length, from the same function the String tab uses --- */
  const tLo = g("tLo", null), tHi = g("tHi", null);
  const sizing = (tLo !== null && tHi !== null && g("moduleWp", 0) > 0)
    ? sizeStrings({
      mod: { voc: g("voc", 49.97), vmp: g("vmp", 41.23), isc: g("isc", 16.48),
        imp: g("imp", 15.77), pmax: g("moduleWp", 650), bVoc: g("bVoc", -0.22),
        bVmp: g("bVmp", -0.29), gPmax: null, aIsc: null, vSysMax: 1500,
        vmpNoct: null, noct: null, cells: null, ideality: null },
      inv: { vMax: g("invVmax", 1500), fpLo: g("invFpLo", 600), trackLo: null, vStart: null,
        iMppt: null, connMax: null, nMppt: 1, acKva: g("inverterKwac", 350) },
      tSrc: [{ lo: tLo, hi: tHi }],
      siteT: { riseIdx: g("riseIdx", 2), margin: g("margin", 2) },
      frameP: 1, nSel: null,
    })
    : null;

  /* --- step 4: the sweep file --- */
  const downloadSweep = () => {
    const cw = g("collectorWidthM", 0);
    const tilts = range(g("tiltFrom", 15), g("tiltTo", 25), 2);
    const gaps = range(GAP_DEFAULT.from, GAP_DEFAULT.to, GAP_DEFAULT.step);
    const columns = [paramById("tilt"), paramById("pitch")];
    const rows = [];
    for (const t of tilts) for (const gap of gaps) rows.push([t, pitchFromGap(gap, cw, t)]);
    const csv = buildBatchParamsCsv({
      project: g("pvsystProject", ""), baseVariant: g("pvsystVariant", ""),
      columns, rows, comment: "PVhub guided sweep",
    });
    const blob = new Blob([csv], { type: "text/csv;charset=windows-1252" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "GuidedSweep_BatchParams.CSV";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const Step = ({ s, children }) => {
    const stt = stepState(s.id, state);
    const tone = TONE[stt];
    const miss = (state[s.id] || {}).missing || [];
    return (
      <div style={{ display: "flex", gap: 12, marginBottom: 4, width: "100%" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 26 }}>
          <div style={{ width: 24, height: 24, borderRadius: 12, flexShrink: 0,
            background: stt === "done" ? tone : "transparent", border: `2px solid ${tone}`,
            color: stt === "done" ? "#0d1014" : tone,
            font: "700 12px system-ui", display: "flex", alignItems: "center",
            justifyContent: "center" }}>
            {stt === "done" ? MARK.done : s.n}
          </div>
          {s.n < STEPS.length && <div style={{ flex: 1, width: 2, background: C.line, minHeight: 14 }} />}
        </div>
        <div style={{ flex: 1, minWidth: 0, paddingBottom: 16 }}>
          <div style={{ display: "flex", gap: 9, alignItems: "baseline", flexWrap: "wrap" }}>
            <span style={{ font: "650 14px system-ui", color: stt === "blocked" ? C.muted : C.text }}>
              {s.title}
            </span>
            <span style={{ font: "10.5px system-ui", color: tone, textTransform: "uppercase",
              letterSpacing: "0.06em" }}>
              {stt === "provisional" ? "assumed" : stt}
            </span>
            {next && next.id === s.id && (
              <span style={{ font: "10.5px system-ui", color: C.accent }}>&larr; you are here</span>
            )}
          </div>
          <div style={{ font: "11px/1.55 system-ui", color: C.muted, margin: "3px 0 8px" }}>
            {s.gives}
            {miss.length > 0 && (
              <span style={{ color: TONE.provisional }}> Still wants: {miss.join(", ")}.</span>
            )}
          </div>
          {/* Shown even when blocked, at reduced contrast. Hiding the
              inputs of a step whose prerequisite is unmet makes the flow
              a dead end for anyone who already has the answer and only
              wants to record it. */}
          <div style={{ opacity: stt === "blocked" ? 0.55 : 1 }}>{children}</div>
        </div>
      </div>
    );
  };

  return (
    <Page wide>
      <div className="tbl">GUIDED FLOW — FROM A MAP PIN TO A QUOTABLE NUMBER</div>

      <Section code="G0" title="Where this gets to">
        {sum.ready || d.dcKwp !== null ? (
          <>
            <div style={{ display: "flex", gap: 9, flexWrap: "wrap", width: "100%", marginBottom: 9 }}>
              <Big label="DC capacity" value={d.dcKwp === null ? "—" : fmt(d.dcKwp, 0)}
                unit="kWp" how={d.dcKwpHow} />
              <Big label="DC/AC" value={d.dcac === null ? "—" : fmt(d.dcac, 2)} unit="" />
              <Big label="Annual energy" value={d.annualMwh === null ? "—" : fmt(d.annualMwh, 0)}
                unit="MWh/yr" how={d.annualHow}
                tone={sum.provisional ? TONE.provisional : undefined} />
              <Big label="Capex" value={d.capex === null ? "—" : d.capex.toLocaleString("en-GB")}
                unit="" how={d.capexHow} />
            </div>
            {sum.caveat && (
              <div className="warns" style={{ width: "100%" }}>
                <div className="warn">{sum.caveat}</div>
              </div>
            )}
          </>
        ) : (
          <div className="readout" style={{ width: "100%", font: "10.5px/1.65 system-ui" }}>
            Fill the steps below and the headline figures appear here. Nothing is guessed on
            your behalf: a step with a gap in it says what the gap is rather than substituting
            a plausible number.
          </div>
        )}
        {checks.length > 0 && (
          <WarnList items={checks.map((c) => c.text)} />
        )}
      </Section>

      <Section code="G1" title="The seven steps">
        <div style={{ width: "100%" }}>

          <Step s={STEPS[0]}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
              <Num label="Latitude" unit="°" step={0.0001} value={g("lat", 0)}
                onChange={(v) => upd({ lat: v })} />
              <Num label="Longitude" unit="°" step={0.0001} value={g("lon", 0)}
                onChange={(v) => upd({ lon: v })} />
              <Num label="Site area" unit="ha" step={0.5} value={g("areaHa", 0)}
                onChange={(v) => upd({ areaHa: v })} />
              <button className="btn" onClick={pullTemps}
                disabled={!g("lat", 0) && !g("lon", 0)}>
                Pull temperature extremes
              </button>
            </div>
            {busy && <Working label={busy} />}
            {notes.length > 0 && <WarnList items={notes} />}
            {/* Always shown. The pull is a convenience; a site with no
                network, or a client with their own met data, must still
                be able to type the two numbers that matter. */}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              <Num label="Record low" unit="°C" step={0.5} value={g("tLo", 0)}
                onChange={(v) => upd({ tLo: v })} />
              <Num label="Record high" unit="°C" step={0.5} value={g("tHi", 0)}
                onChange={(v) => upd({ tHi: v })} />
              <span style={{ font: "10.5px system-ui", color: C.muted, alignSelf: "center",
                maxWidth: 300 }}>
                {g("tempPulled", false)
                  ? "Pulled from ERA5. Overwrite either if you have better data."
                  : "Type them, or pull ten years of daily extremes from ERA5 above."}
              </span>
            </div>
          </Step>

          <Step s={STEPS[1]}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Num label="Module" unit="Wp" step={5} value={g("moduleWp", 0)}
                onChange={(v) => upd({ moduleWp: v })} />
              <Num label="Module Voc" unit="V" step={0.1} value={g("voc", 49.97)}
                onChange={(v) => upd({ voc: v })} />
              <Num label="Module Vmp" unit="V" step={0.1} value={g("vmp", 41.23)}
                onChange={(v) => upd({ vmp: v })} />
              <Num label="Inverter" unit="kWac" step={5} value={g("inverterKwac", 0)}
                onChange={(v) => upd({ inverterKwac: v })} />
              <Num label="Inverters" unit="" step={1} value={g("nInverter", 0)}
                onChange={(v) => upd({ nInverter: v })} />
            </div>
            <div style={{ font: "10.5px system-ui", color: C.muted, marginTop: 6 }}>
              A PVsyst .PAN or .OND read in the Module and Inverter tabs fills these exactly;
              typing the four headline figures is enough to get a size.
            </div>
          </Step>

          <Step s={STEPS[2]}>
            {sizing ? (
              <>
                <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
                  <Big label="Longest string" value={sizing.bad ? "—" : sizing.nMax} unit="modules"
                    how="cold Voc against the inverter ceiling" />
                  <Big label="Shortest string" value={sizing.bad ? "—" : sizing.nMin} unit="modules"
                    how="hot Vmp against the full-power floor" />
                  <Big label="Use" value={sizing.valid ? sizing.nRec : "—"} unit="modules"
                    tone={sizing.valid ? TONE.done : TONE.provisional} />
                </div>
                {!sizing.valid && (
                  <div className="warns" style={{ width: "100%" }}>
                    <div className="warn">
                      No string length works: the coldest morning puts {sizing.nMax} modules at
                      the inverter's ceiling while the hottest afternoon needs at least
                      {" "}{sizing.nMin} to hold full power. A different inverter, or a module
                      with a flatter temperature coefficient, is the fix.
                    </div>
                  </div>
                )}
                <div style={{ font: "10.5px/1.6 system-ui", color: C.muted, marginTop: 7 }}>
                  Cell temperature {fmt(sizing.tcMin, 0)} to {fmt(sizing.tcMax, 0)} °C, from
                  air of {fmt(sizing.tLo, 0)} to {fmt(sizing.tHi, 0)} °C plus a
                  {" "}{sizing.rise} °C rise and a {g("margin", 2)} °C margin. The extremes
                  are the most extreme of every source, never an average — averaging softens
                  exactly the morning the check exists to catch.
                </div>
                {sizing.valid && g("modulesInSeries", 0) !== sizing.nRec && (
                  <button className="btn" style={{ marginTop: 8 }}
                    onClick={() => upd({ modulesInSeries: sizing.nRec })}>
                    Use {sizing.nRec} modules in series
                  </button>
                )}
              </>
            ) : (
              <div style={{ font: "10.5px system-ui", color: C.muted }}>
                Needs the temperatures from step 1 and the module from step 2.
              </div>
            )}
          </Step>

          <Step s={STEPS[3]}>
            <div style={{ font: "10.5px/1.6 system-ui", color: C.muted, marginBottom: 8 }}>
              PVsyst decides this, not PVhub. Write the sweep file here, run it there, and the
              Batch analyser tab reads the results back and recommends a tilt and pitch. It is
              hours of simulation, so do step 5 while it runs rather than waiting.
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
              <Txt label="PVsyst project" value={g("pvsystProject", "")} placeholder="Site.PRJ"
                onChange={(v) => upd({ pvsystProject: v })} />
              <Txt label="Base variant" value={g("pvsystVariant", "")} placeholder="VC1" width={120}
                onChange={(v) => upd({ pvsystVariant: v })} />
              <Num label="Collector width" unit="m" step={0.05} value={g("collectorWidthM", 0)}
                onChange={(v) => upd({ collectorWidthM: v })} />
              <button className="btn" onClick={downloadSweep} disabled={!(g("collectorWidthM", 0) > 0)}>
                Write the sweep file
              </button>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
              <Num label="Tilt chosen" unit="°" step={0.5} value={g("tiltDeg", 0)}
                onChange={(v) => upd({ tiltDeg: v })} />
              <Num label="Pitch chosen" unit="m" step={0.1} value={g("pitchM", 0)}
                onChange={(v) => upd({ pitchM: v })} />
              <Num label="Specific yield from PVsyst" unit="kWh/kWp" step={10}
                value={g("specificYield", 0)} onChange={(v) => upd({ specificYield: v })} />
            </div>
          </Step>

          <Step s={STEPS[4]}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Num label="Modules that fit" unit="" step={10} value={g("moduleCount", 0)}
                onChange={(v) => upd({ moduleCount: v })} />
            </div>
            <div style={{ font: "10.5px/1.6 system-ui", color: C.muted, marginTop: 7 }}>
              The Layout tool tiles the real boundary at this pitch and gives the count. Its
              capacity is the one to use: PVsyst's 3D scene is a regular field, so its module
              count will not match a layout fitted to a real site.
              {state.layout.onProvisionalPitch && (
                <span style={{ color: TONE.provisional }}> The pitch has not been simulated
                  yet, so re-run the fill once the sweep lands.</span>
              )}
            </div>
          </Step>

          <Step s={STEPS[5]}>
            <div style={{ font: "10.5px/1.6 system-ui", color: C.muted }}>
              {d.annualMwh !== null
                ? `${fmt(d.annualMwh, 0)} MWh a year: ${d.annualHow}.`
                : "Needs the specific yield from step 4 and the capacity from step 5."}
            </div>
          </Step>

          <Step s={STEPS[6]}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Num label="Capex rate" unit="per Wp" step={0.01} value={g("capexPerWp", 0)}
                onChange={(v) => upd({ capexPerWp: v })} />
            </div>
            <div style={{ font: "10.5px/1.6 system-ui", color: C.muted, marginTop: 7 }}>
              A rate per watt is the quickest answer. The Costing tab does it properly: your own
              quotes, their pricing dates, and an LCOE. No price is built in here, deliberately
              — an embedded default ends up in a board paper with nobody remembering where
              it came from.
            </div>
          </Step>

        </div>
      </Section>

      <Section code="G2" title="What this is and is not">
        <div className="readout" style={{ width: "100%", font: "10.5px/1.65 system-ui" }}>
          <p><strong style={{ color: C.accent }}>It is the same engines, fewer questions.</strong>{" "}
          The string sizing is the function the String Sizing tab runs, the sweep file is the one
          the Batch analyser writes, the temperatures come from the same ERA5 pull. Nothing here
          is a simplified second copy, so nothing here can disagree with the full tool.</p>
          <p><strong style={{ color: C.accent }}>The order is not arbitrary.</strong> The sweep
          settles the pitch, and the pitch is an input to the layout — so the sweep comes
          first. The sweep does not need the layout back, because it reports yield per kWp. The
          layout then says how many kWp the site holds, and the two multiply. The only reason to
          overlap them is time: a sweep is hours, so the layout runs on a provisional pitch and
          everything downstream is marked as assumed until the results land.</p>
          <p><strong style={{ color: C.accent }}>It will not invent a number.</strong> A step
          with a gap says what the gap is. The guards above catch the figures that look fine on
          screen and are obviously wrong to anyone who sizes plants — a DC/AC of five, a
          rate entered per kWp, more megawatts than the hectares can hold.</p>
        </div>
      </Section>
    </Page>
  );
}
