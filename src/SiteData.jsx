/* =====================================================================
   SITE DATA — the weather a model runs on, and the yield it is scaled to.

   Both the Pitch & Yield tab and the Yield report need these, and each
   used to pull its own copy with its own buttons and its own account of
   why the pull had failed. This is the one set of controls, writing to
   one piece of state in the shell, so a year loaded on either tab is
   the year both of them use.

   Weather is a button, because Open-Meteo answers a web page. PVGIS is
   two clicks, because it does not: the query is opened in a browser
   tab, where the cross-origin rule does not apply, and the answer is
   handed back by dropping the saved file or pasting it. That is slower
   than a button and it is the truth about how the service can be
   reached from a hosted page.
   ===================================================================== */

import React, { useState } from "react";
import { fmt, C } from "./ui.jsx";
import {
  fetchTypicalYear, WEATHER_SOURCES, pvgisFaces, pvgisUrl, readPvgis, combineFaces, aspectName,
} from "./pvgis.js";

const GOOD = "#7fd694";
const box = {
  width: "100%", background: C.panel2, border: `1px solid ${C.line}`,
  borderRadius: 5, padding: "9px 11px",
};
const small = { font: "11px/1.5 system-ui", color: C.muted };

/**
 * Open the PVGIS query in a tab, then hand the answer back.
 *
 * The link is a real link rather than a button that opens a window, so
 * it can be middle-clicked, copied or sent to a colleague, and so a
 * popup blocker has nothing to object to.
 */
export function HandBack({ url, kind, expect, onRead, what, read, note = " — PVGIS answers there in a few seconds." }) {
  const [err, setErr] = useState("");
  const [over, setOver] = useState(false);
  const take = (text) => {
    const r = read ? read(text) : readPvgis(kind, text, expect);
    if (!r.ok) { setErr(r.msg); return; }
    setErr("");
    onRead(r.data, r.warnings || []);
  };
  const takeFile = (file) => {
    if (!file) return;
    const fr = new FileReader();
    fr.onload = () => take(String(fr.result || ""));
    fr.onerror = () => setErr("That file could not be read.");
    fr.readAsText(file);
  };
  return (
    <div style={{ marginTop: 7 }}>
      <div style={{ ...small, color: C.text }}>
        <b style={{ color: C.accent }}>1</b>{" "}
        <a href={url} target="_blank" rel="noreferrer" style={{ color: C.accent }}>
          Open {what} in a new tab
        </a>
        <span style={{ color: C.muted }}>{note}</span>
      </div>
      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); takeFile(e.dataTransfer.files?.[0]); }}
        style={{ marginTop: 6, border: `1px dashed ${over ? C.accent : C.line}`, borderRadius: 5,
          padding: "8px 9px", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
          background: over ? "rgba(232,130,12,0.08)" : "transparent" }}>
        <span style={{ ...small, color: C.text }}>
          <b style={{ color: C.accent }}>2</b> Save that tab (Ctrl+S) and drop the file here,
        </span>
        <label className="btn" style={{ cursor: "pointer" }}>
          or choose it
          <input type="file" accept=".json,application/json,text/plain" style={{ display: "none" }}
            onChange={(e) => { takeFile(e.target.files?.[0]); e.target.value = ""; }} />
        </label>
        <textarea rows={1} value="" placeholder="or select all in that tab, copy, and paste here"
          onChange={(e) => { if (e.target.value.trim()) take(e.target.value); }}
          style={{ flex: "1 1 220px", minWidth: 160, resize: "none", background: C.panel,
            border: `1px solid ${C.line}`, borderRadius: 4, color: C.text,
            font: "11.5px var(--mono)", padding: "6px 8px" }} />
      </div>
      {err && <div className="warn" style={{ marginTop: 6 }}>⚠ {err}</div>}
    </div>
  );
}

const WHY_TWO_CLICKS = "PVGIS does not let a web page fetch from it — on any host, by its own "
  + "stated policy — so this takes two clicks rather than one.";

/* ---------------------------------------------------------------
   Weather
   --------------------------------------------------------------- */

export function WeatherSource({ loc, weather, onWeather }) {
  const [st, setSt] = useState({ state: "idle", msg: "" });
  const [showPvgis, setShowPvgis] = useState(false);
  const pull = async () => {
    setSt({ state: "busy", msg: "" });
    const r = await fetchTypicalYear(loc.lat, loc.lon);
    if (r.ok) { onWeather(r.data); setSt({ state: "idle", msg: "" }); }
    else setSt({ state: "err", msg: r.msg });
  };
  const src = weather ? WEATHER_SOURCES[weather.source] : null;
  /* A year pulled for one pin and still loaded after the pin has moved
     is weather for somewhere else. */
  const moved = weather && Number.isFinite(weather.lat) && Number.isFinite(weather.lon)
    && (Math.abs(weather.lat - loc.lat) > 0.05 || Math.abs(weather.lon - loc.lon) > 0.05);
  return (
    <div style={box}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 260px", minWidth: 200 }}>
          <div style={{ font: "600 12px system-ui", color: C.text }}>
            Weather — a typical year of hourly irradiance
            <span style={{ font: "600 10.5px system-ui", marginLeft: 8, letterSpacing: "0.07em",
              textTransform: "uppercase", color: weather ? GOOD : st.state === "err" ? "#d67070" : C.warn }}>
              {st.state === "busy" ? "fetching" : weather ? "loaded" : st.state === "err" ? "unavailable" : "clear-sky model"}
            </span>
          </div>
          <div style={{ ...small, marginTop: 2 }}>
            {weather
              ? <><span style={{ color: C.text }}>{weather.label}.</span> {src?.standing}</>
              : "Using a clear-sky model — geometry is right, absolute yield runs high. "
                + "Pull a real year and the row-shading model runs on real mornings and real cloud."}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button className="btn primary" disabled={st.state === "busy"} onClick={pull}>
            {st.state === "busy" ? "Fetching…" : weather ? "Pull again" : "Pull a typical year"}
          </button>
          {weather && <button className="btn" onClick={() => onWeather(null)}>Back to clear-sky</button>}
        </div>
      </div>
      {st.state === "err" && <div className="warn" style={{ marginTop: 7 }}>⚠ {st.msg}</div>}
      {weather && (
        <div className="readout" style={{ marginTop: 7 }}>
          Global horizontal <b>{fmt(weather.ghiYear, 0)} kWh/m²</b> a year over 8,760 hours.
          {weather.picks ? <> Each month is a real month, from the year whose irradiation was
            nearest that month&apos;s average over {weather.years[0]}–{weather.years[weather.years.length - 1]}:{" "}
            <span style={{ color: C.muted }}>{weather.picks.map((p) => p.year).join(" · ")}</span>.</> : null}
          {weather.tempFrom === null ? " No temperature could be joined to it, so 25 °C is used throughout." : null}
          {weather.fellBack ? <> The satellite record was tried first and could not be used:{" "}
            {weather.fellBack}.</> : null}
        </div>
      )}
      {moved && (
        <div className="warn" style={{ marginTop: 7 }}>
          ⚠ This year was pulled for {fmt(weather.lat, 3)}, {fmt(weather.lon, 3)} and the site is
          now at {fmt(loc.lat, 3)}, {fmt(loc.lon, 3)}. Pull it again.
        </div>
      )}
      <div style={{ marginTop: 7 }}>
        <button className="btn" onClick={() => setShowPvgis(!showPvgis)}>
          {showPvgis ? "▴ Hide" : "▾ Use PVGIS's own typical year instead"}
        </button>
        {showPvgis && (
          <div style={{ marginTop: 6 }}>
            <div style={small}>{WHY_TWO_CLICKS} Its typical year is the reference one, and worth
              the two clicks for anything going to a client.</div>
            <HandBack kind="tmy" what="PVGIS's typical year" url={pvgisUrl("tmy", loc)}
              expect={{ lat: loc.lat, lon: loc.lon }}
              onRead={(data) => { onWeather(data); setShowPvgis(false); }} />
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   The absolute baseline
   --------------------------------------------------------------- */

export function BaselineSource({ loc, mounting, tilt, loss, baseline, onBaseline }) {
  const faces = pvgisFaces({ lat: loc.lat, mounting, tilt });
  const [answers, setAnswers] = useState({});
  const [notes, setNotes] = useState({});
  const [open, setOpen] = useState(!baseline);
  const take = (face) => (data, warnings) => {
    const next = { ...answers, [face.key]: data };
    setAnswers(next);
    setNotes({ ...notes, [face.key]: warnings });
    const combined = combineFaces(faces, next);
    if (combined) { onBaseline({ ...combined, at: new Date().toISOString() }); setOpen(false); }
  };
  /* A baseline restored from a saved project, or left over after the
     site or the mounting changed, is checked against what is on screen
     now. PVGIS records what it was asked, so this is a comparison of
     two facts rather than a guess. */
  const stale = [];
  if (baseline?.asked) {
    const a = baseline.asked;
    if (Number.isFinite(a.lat) && (Math.abs(a.lat - loc.lat) > 0.02 || Math.abs(a.lon - loc.lon) > 0.02)) {
      stale.push(`it is for ${a.lat}, ${a.lon} and the site is now at ${fmt(loc.lat, 4)}, ${fmt(loc.lon, 4)}`);
    }
    const wantKind = faces[0].kind;
    if (a.mounting && a.mounting !== wantKind) {
      stale.push(`it is for ${a.mounting === "fixed" ? "a fixed plane" : "a tracker"} and the layout is now ${wantKind === "fixed" ? "fixed" : "a tracker"}`);
    } else if (wantKind === "fixed" && (baseline.faces?.length || 1) === faces.length
        && Number.isFinite(a.slope) && Math.abs(a.slope - tilt) > 0.5) {
      stale.push(`it is for a ${a.slope}° tilt and the layout is now at ${tilt}°`);
    }
    if ((baseline.faces?.length || 1) !== faces.length) {
      stale.push("the number of planes it covers no longer matches the mounting");
    }
  }
  return (
    <div style={box}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 260px", minWidth: 200 }}>
          <div style={{ font: "600 12px system-ui", color: C.text }}>
            PVGIS — the yield baseline
            <span style={{ font: "600 10.5px system-ui", marginLeft: 8, letterSpacing: "0.07em",
              textTransform: "uppercase", color: baseline ? (stale.length ? C.warn : GOOD) : C.muted }}>
              {baseline ? (stale.length ? "out of date" : "loaded") : "not loaded"}
            </span>
          </div>
          <div style={{ ...small, marginTop: 2 }}>
            {baseline
              ? <><b style={{ color: C.text }}>{fmt(baseline.specYield, 0)} kWh/kWp</b> unshaded
                  {baseline.irradiation ? <>, from {fmt(baseline.irradiation, 0)} kWh/m² in plane</> : null}
                  {baseline.sdYear ? <>, year-to-year spread ±{fmt(baseline.sdYear, 0)}</> : null}.
                  {" "}PVGIS says it modelled{" "}
                  {(baseline.faces || []).join(" and ") || (baseline.asked?.mounting === "fixed" ? "a fixed plane" : "a tracker")}
                  {baseline.asked?.loss !== null && baseline.asked?.loss !== undefined ? ` at ${baseline.asked.loss}% system loss` : ""}
                  {baseline.asked?.radDb ? `, on ${baseline.asked.radDb}` : ""}
                  {baseline.asked?.years ? ` ${baseline.asked.years}` : ""}
                  {baseline.asked?.horizon ? ", terrain horizon included" : ""}.</>
              : "Their own PV model, terrain horizon included, for one kWp of this mounting. The "
                + "only absolute yield figure in the tool that is not ours, and the one the row "
                + "geometry is applied to."}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button className="btn" onClick={() => setOpen(!open)}>
            {open ? "▴ Hide" : baseline ? "Replace it" : "▾ Load it"}
          </button>
          {baseline && <button className="btn" onClick={() => { onBaseline(null); setAnswers({}); setNotes({}); setOpen(true); }}>
            Clear</button>}
        </div>
      </div>
      {stale.length > 0 && (
        <div className="warn" style={{ marginTop: 7 }}>
          ⚠ This baseline no longer matches what is on screen: {stale.join("; ")}. Load it again.
        </div>
      )}
      {open && (
        <div style={{ marginTop: 7 }}>
          <div style={small}>{WHY_TWO_CLICKS}
            {faces.length > 1 ? " An east-west pair is two planes, and PVGIS models one at a time, so it needs both; the baseline is the mean of the two." : ""}</div>
          {faces.map((f) => (
            <div key={f.key} style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${C.line}` }}>
              <div style={{ font: "600 11.5px system-ui", color: C.text }}>
                {f.name[0].toUpperCase() + f.name.slice(1)}
                {answers[f.key] && <span style={{ color: GOOD, marginLeft: 8, font: "11.5px var(--mono)" }}>
                  ✓ {fmt(answers[f.key].specYield, 0)} kWh/kWp</span>}
              </div>
              {(notes[f.key] || []).map((w, i) => <div className="warn" key={i} style={{ marginTop: 5 }}>⚠ {w}</div>)}
              <HandBack kind="pvcalc" what="the PVGIS answer" url={pvgisUrl("pvcalc", { ...loc, loss, face: f })}
                expect={{ lat: loc.lat, lon: loc.lon, face: f }} onRead={take(f)} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export { aspectName };
