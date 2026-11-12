/* ---------------------------------------------------------------
   The OpenStreetMap offer in the layout's exclusions section.

   One request for what is mapped in and around the boundary, shown
   by kind, and nothing added until a button is pressed: the same rule
   as every hand-off from the layout. What is added comes with no
   buffer, because OSM records where a line runs and not how wide its
   easement is.

   The substations near the site are listed too, with a button that
   moves the grid point to the edge of the boundary facing one. The
   distance left between them is the off-site connection, which this
   tool does not route and says so.
   --------------------------------------------------------------- */

import React, { useState } from "react";
import { fmt, fmtArea, fmtKm, C } from "./ui.jsx";
import { HandBack } from "./SiteData.jsx";
import { ZONE_KINDS } from "./siteConstraints.js";
import { pointInPolygon } from "./roofGeom.js";
import {
  queryBox, overpassQuery, overpassLink, fetchOverpass, readOverpass, byKind,
  nearestOnBoundary, compass, OSM_ATTRIBUTION, OSM_MARGIN, SUBSTATION_RADIUS, LINE_STRIP,
} from "./osmPull.js";

const small = { font: "11px/1.5 system-ui", color: C.muted };

export function OsmPanel({ polygon, geo, zones, onAddZones, ss, onGridPoint }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [res, setRes] = useState(null);
  const [handBack, setHandBack] = useState(false);
  const [off, setOff] = useState({});
  const box = geo && polygon && polygon.length >= 3 ? queryBox(polygon, geo) : null;
  const q = box ? overpassQuery(box) : "";

  const take = (r) => {
    /* Every kind starts ticked: nothing is added until the button, and
       leaving buildings out by default would be a guess about intent. */
    setErr(""); setRes(r); setOff({});
  };
  const pull = async () => {
    setBusy(true); setErr("");
    const f = await fetchOverpass(q);
    setBusy(false);
    if (!f.ok) { setErr(f.msg); setHandBack(true); return; }
    const r = readOverpass(f.text, { geo, box, boundary: polygon });
    if (!r.ok) { setErr(r.msg); return; }
    take(r);
  };

  const have = new Set((zones || []).map((z) => z.osm).filter(Boolean));
  const groups = res ? byKind(res.candidates) : [];
  /* One OSM way can clip into several pieces, so the key carries the piece. */
  const keyOf = (c) => `${c.osm}#${c.part}#${Math.round(c.pts[0].x)},${Math.round(c.pts[0].y)}`;
  const fresh = (g) => g.items.filter((c) => !have.has(keyOf(c)));
  const chosen = groups.filter((g) => !off[g.kind]).flatMap(fresh);
  const add = () => {
    onAddZones(chosen.map((c) => ({
      kind: c.kind, name: c.name, pts: c.pts, buffer: 0,
      osm: keyOf(c),
    })));
  };

  if (!box) {
    return (
      <div style={{ ...small, width: "100%" }}>
        OpenStreetMap features need a boundary with a position on the earth: import it as KML or
        KMZ, or set the site's coordinates.
      </div>
    );
  }

  return (
    <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <button className="btn" disabled={busy} onClick={pull}>
          {busy ? "Asking OpenStreetMap…" : "Read mapped features from OpenStreetMap"}
        </button>
        {!handBack && (
          <button className="btn" onClick={() => setHandBack(true)}>or by hand</button>
        )}
      </div>
      <div style={small}>
        Overhead lines, buried cables, water, buildings, woods, hedges and protected areas in the
        boundary and {OSM_MARGIN} m round it, and substations within {SUBSTATION_RADIUS / 1000} km.
      </div>
      {geo.source !== "kml" && (
        <div className="warn">
          ⚠ This boundary has no position of its own on the earth, so it is placed with its middle at
          the site's coordinates. What comes back is mapped round that point; if the boundary is not
          really there, it is somebody else's hedges. Import the boundary as KML or KMZ to place it exactly.
        </div>
      )}
      {err && <div className="warn">⚠ {err}</div>}
      {handBack && (
        <HandBack url={overpassLink(q)} what="the OpenStreetMap query"
          note=" — Overpass answers there, usually within half a minute."
          read={(t) => { const r = readOverpass(t, { geo, box, boundary: polygon }); return r.ok ? { ok: true, data: r } : r; }}
          onRead={(r) => { take(r); setHandBack(false); }} />
      )}

      {res && (
        <div style={{ border: `1px solid ${C.line}`, borderRadius: 5, padding: "8px 9px",
          display: "flex", flexDirection: "column", gap: 6 }}>
          {groups.length === 0 ? (
            <div style={{ ...small, color: C.text }}>
              OpenStreetMap has nothing of these kinds mapped within {OSM_MARGIN} m of the boundary. In open
              country that usually means nobody has mapped it yet, not that the ground is clear: walk it.
            </div>
          ) : (
            <>
              <div style={{ ...small, color: C.text }}>
                Mapped in and round the site. Each comes in as an exclusion with <b>no buffer</b>: OSM says
                where a thing is, not how far to keep from it. A line has no width in OSM, so it comes in
                as a strip {LINE_STRIP} m wide along the mapped line, and its easement is the buffer you enter.
              </div>
              {groups.map((g) => {
                const n = fresh(g).length;
                return (
                  <label key={g.kind} style={{ display: "flex", gap: 7, alignItems: "flex-start", font: "11.5px/1.5 system-ui", color: C.text }}>
                    <input type="checkbox" checked={!off[g.kind] && n > 0} disabled={n === 0}
                      onChange={(e) => setOff((o) => ({ ...o, [g.kind]: !e.target.checked }))} />
                    <span>
                      <b>{ZONE_KINDS[g.kind]?.name || g.kind}</b>: {g.items.length}
                      {" "}({g.inside} in the site{g.near ? `, ${g.near} only near it` : ""})
                      {g.length > 0 && <>, {fmtKm(g.length)} of line</>}
                      {g.area > 0 && <>, {fmtArea(g.area)}</>}
                      {g.maxShare >= 0.005 && <>, the largest covering {fmt(g.maxShare * 100, 0)}% of the site</>}
                      {n < g.items.length && <span style={{ color: C.muted }}> · {g.items.length - n} already added</span>}
                      {g.kind === "protected" && g.maxShare >= 0.5 && (
                        <span style={{ display: "block", color: C.warn }}>
                          Most of the site is inside a protected area. That is a planning question before it
                          is a layout one.
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                <button className="btn" disabled={!chosen.length} onClick={add}>
                  Add {chosen.length} as exclusion{chosen.length === 1 ? "" : "s"}
                </button>
              </div>
            </>
          )}
          {res.warnings.map((w, i) => <div key={i} style={small}>{w}</div>)}

          {res.substations.length > 0 ? (
            <>
              <div className="tbl" style={{ marginTop: 4 }}>Substations mapped nearby</div>
              {res.substations.map((s) => {
                const mid = polygon.reduce((a, p) => ({ x: a.x + p.x / polygon.length, y: a.y + p.y / polygon.length }), { x: 0, y: 0 });
                const within = pointInPolygon(s.local, polygon);
                const edge = within ? { ...s.local, dist: 0 } : nearestOnBoundary(s.local, polygon);
                const here = ss && edge && Math.hypot(ss.x - edge.x, ss.y - edge.y) < 1;
                return (
                  <div key={s.osm} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", ...small, color: C.text }}>
                    <span style={{ flex: "1 1 200px" }}>
                      <b>{s.name || "Unnamed"}</b>
                      {s.kv ? ` · ${fmt(s.kv, s.kv < 1 ? 1 : 0)} kV` : " · voltage not mapped"}
                      {s.operator ? ` · ${s.operator}` : ""}
                      {" · "}{within ? "inside the boundary"
                        : `${fmtKm(s.dist)} ${compass(mid, s.local)}, ${fmtKm(edge.dist)} beyond the boundary`}
                    </span>
                    <button className="btn" disabled={here} onClick={() => onGridPoint({ x: edge.x, y: edge.y })}>
                      {here ? (within ? "Grid point is here" : "Grid point faces it") : (within ? "Grid point here" : "Grid point towards it")}
                    </button>
                  </div>
                );
              })}
              <div style={small}>
                Distances are straight lines. The connection route will be longer, and whether a
                substation has capacity is the network operator's answer, not the map's. The off-site
                run is not in the MV total.
              </div>
            </>
          ) : (
            <div style={small}>No substation is mapped within {SUBSTATION_RADIUS / 1000} km.</div>
          )}
          <div style={{ ...small, fontSize: 10.5 }}>Data {OSM_ATTRIBUTION}.</div>
        </div>
      )}
    </div>
  );
}
