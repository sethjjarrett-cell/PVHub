/* ---------- where the projects are ---------------------------------
   A world map with each report placed from its own latitude and
   longitude.

   This used to be a bare graticule, on the reasoning that coastlines
   needed either a tile service or outlines drawn from memory. There
   was a third option, which is what this is: Natural Earth's country
   outlines, bundled. They are the same data, in the same projection,
   as the map on the author's travel page, and src/worldMap.js says why
   they ship with the application rather than being fetched.

   What a map adds over the plot is not decoration. Two reports for
   sites forty kilometres apart were two dots with nothing to say they
   were neighbours, and a longitude with its sign flipped put a project
   in the South Pacific with no visible reason to doubt it.
   ------------------------------------------------------------------ */

import React, { useEffect, useMemo, useState } from "react";
import { feature } from "topojson-client";
import world from "world-atlas/countries-110m.json";
import { fmt, C, useNarrow } from "./ui.jsx";
import {
  MAP_W, MAP_H, FOCUS_SPAN, regionAround, drawWorld, countryOf, groupBySpot, clusterOnScreen, siteCard,
} from "./worldMap.js";

const FEATURES = feature(world, world.objects.countries).features;

/* The palette is this application's, not the travel page's: that map
   sits on cream paper and this one on a dark panel. What carries over
   is the idea — the countries that matter are tinted and the rest are
   left quiet. */
const INK = {
  ocean: "#0d1014", land: "#1b222b", edge: "#313c4a", held: "#2c4a37", heldEdge: "#47705a",
  grid: "#171d25", equator: "#33506b", tropic: "#3d5943",
};

export function SiteMap({ records, selectedId, onPick }) {
  const [view, setView] = useState("world");
  /* The spot whose card is open: on hover with a mouse, on tap with a
     finger, since a touch screen has no hover to show it. */
  const [hover, setHover] = useState(null);
  /* On a phone the map is narrower than the card, so the card goes
     under the map, full width, instead of floating off the edge. */
  const narrow = useNarrow(760);
  /* A finer outline for the zoomed views. At 1:110 million Britain is
     about forty straight edges, which is fine across a whole world and
     blunt across a single country. The 1:50 million set is seven times
     the size, so it is not in the main bundle: it is a separate file of
     this application's own, asked for the first time a view closes in.
     If it cannot be had, the coarse outline simply stays. */
  const [fine, setFine] = useState(null);
  useEffect(() => {
    if (view === "world" || fine) return undefined;
    let live = true;
    import("world-atlas/countries-50m.json")
      .then((m) => { const w = m.default || m; if (live) setFine(feature(w, w.objects.countries).features); })
      .catch(() => {});
    return () => { live = false; };
  }, [view, fine]);
  const shapes = view !== "world" && fine ? fine : FEATURES;
  const pts = useMemo(() => records
    .map((r) => ({ r, lat: r.fields.lat, lon: r.fields.lon }))
    .filter((p) => typeof p.lat === "number" && typeof p.lon === "number"), [records]);
  const noGeo = records.length - pts.length;
  const sel = pts.find((p) => p.r.id === selectedId) || null;

  /* Which country each spot is in, worked out once per set of records
     rather than on every redraw: it is a point-in-polygon test against
     a hundred and seventy-seven countries. */
  const spots = useMemo(() => groupBySpot(pts).map((g) => ({
    ...g, country: countryOf(FEATURES, g.lon, g.lat),
  })), [pts]);
  const held = useMemo(() => new Set(spots.map((s) => s.country?.id).filter(Boolean)), [spots]);

  const region = view === "all" ? regionAround(pts)
    : view === "sel" && sel ? regionAround([sel], FOCUS_SPAN, 0) : null;
  const regionKey = region ? Object.values(region.box).map((v) => v.toFixed(2)).join(",") : "world";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const map = useMemo(() => drawWorld(shapes, region), [regionKey, shapes]);

  const inFrame = (p) => p && p.x >= -4 && p.x <= MAP_W + 4 && p.y >= -4 && p.y <= MAP_H + 4;
  const placed = clusterOnScreen(
    spots.map((s) => ({ ...s, p: map.at(s.lon, s.lat) })).filter((s) => inFrame(s.p)));
  /* The selected spot is drawn last so its label is never under a
     neighbour's dot. */
  placed.sort((a, b) => (a.items.some((i) => i.r.id === selectedId) ? 1 : 0)
    - (b.items.some((i) => i.r.id === selectedId) ? 1 : 0));

  const nameOf = (r) => r.fields.siteName || r.fields.project;
  const tropicLabel = map.at(region ? (region.box.w + region.box.e) / 2 : 150, 23.44);
  const offMap = spots.filter((s) => !s.country);

  const ViewBtn = ({ id, children, disabled }) => (
    <button className={`btn${view === id ? " on" : ""}`} disabled={disabled}
      onClick={() => setView(id)} style={{ font: "10.5px system-ui", padding: "4px 10px" }}>
      {children}
    </button>
  );

  return (
    <>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8, alignItems: "center" }}>
        <ViewBtn id="world">World</ViewBtn>
        <ViewBtn id="all" disabled={!pts.length}>All projects</ViewBtn>
        <ViewBtn id="sel" disabled={!sel}>Selected project</ViewBtn>
        <span style={{ font: "10.5px system-ui", color: C.muted }}>
          {held.size > 0 ? `${held.size} ${held.size === 1 ? "country" : "countries"} with a project, tinted` : ""}
        </span>
      </div>
      <div style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${MAP_W} ${MAP_H}`} role="img"
        aria-label={`World map with ${pts.length} project${pts.length === 1 ? "" : "s"} placed on it`}
        style={{ width: "100%", height: "auto", display: "block", background: "#101317",
          border: `1px solid ${C.line}`, borderRadius: 7 }}
        onClick={(e) => { if (e.target === e.currentTarget || e.target.tagName === "path") setHover(null); }}>
        <path d={map.sphere} fill={INK.ocean} />
        <path d={map.graticule} fill="none" stroke={INK.grid} strokeWidth="0.6" />
        {map.countries.map((c) => (
          <path key={c.id + c.name} d={c.d} fill={held.has(c.id) ? INK.held : INK.land}
            stroke={held.has(c.id) ? INK.heldEdge : INK.edge} strokeWidth="0.5">
            <title>{c.name}</title>
          </path>
        ))}
        {/* The equator and the tropics are the piece of geography that
            actually bears on a PV yield, so they stay drawn. */}
        <path d={map.equator} fill="none" stroke={INK.equator} strokeWidth="0.8" />
        {map.tropics.map((d, i) => (
          <path key={i} d={d} fill="none" stroke={INK.tropic} strokeWidth="0.8" strokeDasharray="4 4" />
        ))}
        {inFrame(tropicLabel) && (
          <text x={tropicLabel.x} y={tropicLabel.y - 4} textAnchor="middle" fill="#5a8062"
            style={{ font: "10.5px system-ui" }}>Tropic of Cancer</text>
        )}
        <path d={map.sphere} fill="none" stroke="#2a3340" strokeWidth="1" />

        {placed.map((s) => {
          const on = s.items.some((i) => i.r.id === selectedId);
          const many = s.items.length > 1;
          /* A spot holding several reports steps through them on each
             click, so none of them is unreachable under the others. */
          const next = () => {
            const k = s.items.findIndex((i) => i.r.id === selectedId);
            onPick(s.items[(k + 1) % s.items.length].r.id);
          };
          const shown = on ? s.items.find((i) => i.r.id === selectedId) : s.items[0];
          const key = `${s.lat},${s.lon}`;
          return (
            <g key={key} style={{ cursor: "pointer" }} tabIndex={0} role="button"
              aria-label={`${[...new Set(s.items.map((i) => nameOf(i.r)))].join(", ")}${s.country ? `, ${s.country.name}` : ""}`}
              onClick={() => { next(); setHover(key); }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); next(); setHover(key); } }}
              onPointerEnter={(e) => { if (e.pointerType === "mouse") setHover(key); }}
              onPointerLeave={(e) => { if (e.pointerType === "mouse") setHover((h) => (h === key ? null : h)); }}
              onFocus={() => setHover(key)} onBlur={() => setHover((h) => (h === key ? null : h))}>
              {/* a larger invisible disc, so the dot can be hit with a thumb */}
              <circle cx={s.p.x} cy={s.p.y} r="14" fill="transparent" />
              <circle cx={s.p.x} cy={s.p.y} r={on ? 7 : 5}
                fill={on ? C.accent : "#6fa8dc"} stroke="#0d1014" strokeWidth="1.3" />
              {many && (
                <text x={s.p.x + (on ? 10 : 8)} y={s.p.y + 3.5} fill={on ? C.accent : "#9cc3e8"}
                  style={{ font: "600 10.5px var(--mono)" }}>×{s.items.length}</text>
              )}
              {on && (
                <text x={s.p.x} y={s.p.y - 12} textAnchor="middle" fill={C.accent}
                  stroke="#0d1014" strokeWidth="3" paintOrder="stroke"
                  style={{ font: "600 12px system-ui" }}>
                  {nameOf(shown.r)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {(() => {
        const s = placed.find((x) => `${x.lat},${x.lon}` === hover);
        return s && !narrow ? <SiteCard spot={s} selectedId={selectedId} /> : null;
      })()}
      </div>
      {narrow && (() => {
        const s = placed.find((x) => `${x.lat},${x.lon}` === hover);
        return s ? <SiteCard spot={s} selectedId={selectedId} inline /> : null;
      })()}

      <div style={{ display: "flex", gap: 7, flexWrap: "wrap", marginTop: 8 }}>
        {pts.map(({ r, lat, lon }) => (
          <button key={r.id} className="btn" onClick={() => onPick(r.id)}
            style={{ font: "10.5px system-ui", padding: "4px 9px",
              borderColor: r.id === selectedId ? C.accent : undefined,
              color: r.id === selectedId ? C.accent : undefined }}>
            {nameOf(r)}
            <span style={{ color: C.muted, fontFamily: "var(--mono)" }}>
              {"  "}{fmt(Math.abs(lat), 2)}°{lat >= 0 ? "N" : "S"}{" "}
              {fmt(Math.abs(lon), 2)}°{lon >= 0 ? "E" : "W"}
            </span>
          </button>
        ))}
      </div>

      {offMap.length > 0 && (
        <div className="warn" style={{ marginTop: 8 }}>
          ⚠ {offMap.map((s) => nameOf(s.items[0].r)).join(", ")}{" "}
          {offMap.length === 1 ? "sits" : "sit"} outside every country outline. On the coast that
          is the coarseness of the outline, which can be several kilometres out. In open sea it
          is usually a latitude or longitude with the wrong sign — check it against the report.
        </div>
      )}
      <div style={{ font: "10.5px/1.6 system-ui", color: C.muted, marginTop: 7 }}>
        {pts.length} of {records.length} placed from the latitude and longitude in the report
        itself.{noGeo > 0 && ` ${noGeo} carried no coordinates.`} The outlines are Natural Earth,
        1:110 million for the world and 1:50 million once the view closes in, and both ship
        with the application: nothing is fetched from anywhere else to draw this, so no
        project&apos;s position leaves this machine. At either scale a coastline is a sketch,
        good for seeing which country and which neighbours, not for reading a site off the
        shore. The degrees on the buttons are exact.
      </div>
    </>
  );
}

/* The card over a hovered or tapped spot. Positioned in percentages of
   the drawing, so it follows the dot at any width, and flipped to the
   other side near the right or bottom edge so it is never cut off. It
   takes no pointer events: a card that caught the mouse would steal the
   hover from the dot beneath it and flicker. */
const CARD_MAX = 4;
function SiteCard({ spot, selectedId, inline = false }) {
  const left = (spot.p.x / MAP_W) * 100, top = (spot.p.y / MAP_H) * 100;
  const flipX = left > 58, flipY = top > 55;
  const place = inline
    ? { position: "relative", marginTop: 8 }
    : { position: "absolute", left: `${left}%`, top: `${top}%`, pointerEvents: "none", zIndex: 5,
        transform: `translate(${flipX ? "calc(-100% - 14px)" : "14px"}, ${flipY ? "calc(-100% + 10px)" : "-10px"})`,
        width: "max-content", maxWidth: "min(300px, 78vw)" };
  const items = spot.items.slice(0, CARD_MAX);
  const more = spot.items.length - items.length;
  return (
    <div role="tooltip" style={{
      ...place, background: "#161b22",
      border: `1px solid ${C.line}`, borderRadius: 6, padding: "8px 10px",
      boxShadow: "0 6px 22px rgba(0,0,0,0.45)", font: "11px/1.45 system-ui", color: C.text,
    }}>
      <div style={{ color: C.muted, fontSize: 10.5, marginBottom: 4 }}>
        {fmt(Math.abs(spot.lat), 2)}°{spot.lat >= 0 ? "N" : "S"} {fmt(Math.abs(spot.lon), 2)}°{spot.lon >= 0 ? "E" : "W"}
        {spot.country ? ` · ${spot.country.name}` : " · outside every country outline"}
      </div>
      {items.map(({ r }, i) => {
        const c = siteCard(r.fields);
        return (
          <div key={r.id} style={{ borderTop: i ? `1px solid ${C.line}` : "none", paddingTop: i ? 6 : 0, marginTop: i ? 6 : 0 }}>
            <div style={{ fontWeight: 600, color: r.id === selectedId ? C.accent : C.text }}>{c.title}</div>
            {c.sub && <div style={{ color: C.muted, fontSize: 10.5 }}>{c.sub}</div>}
            <table style={{ borderCollapse: "collapse", marginTop: 3 }}><tbody>
              {c.rows.map(([k, v]) => (
                <tr key={k}>
                  <td style={{ color: C.muted, padding: "1px 10px 1px 0", whiteSpace: "nowrap" }}>{k}</td>
                  <td style={{ font: v ? "600 11px var(--mono)" : "italic 10.5px system-ui",
                    color: v ? C.text : C.muted, whiteSpace: "nowrap" }}>{v || "not in report"}</td>
                </tr>
              ))}
            </tbody></table>
          </div>
        );
      })}
      {more > 0 && <div style={{ color: C.muted, marginTop: 5 }}>and {more} more here</div>}
      {spot.items.length > 1 && (
        <div style={{ color: C.muted, fontSize: 10.5, marginTop: 5, borderTop: `1px solid ${C.line}`, paddingTop: 4 }}>
          {spot.items.length} reports at this spot, not added together: they are usually variants of
          one plant. Click to step through them.
        </div>
      )}
    </div>
  );
}
