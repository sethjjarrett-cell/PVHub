/* ---------------------------------------------------------------
   The world map under the project tracker: the projection, which
   country a point falls in, and how far to zoom.

   The outlines are Natural Earth's, at 1:110 million, the same data in
   the same projection as the map on the author's own travel page. They
   are bundled with the application rather than fetched, which matters
   twice over here. This tool makes no call to a content network, so a
   map that needed one would be the only part of it to stop working on
   a plane. And the tracker's records are the one thing in it that is
   private: a tile service is told which part of the world is being
   looked at every time the view moves, and outlines that ship in the
   bundle tell nobody anything.

   No React, and the outline data is passed in rather than imported,
   so the same functions run under the bundler and in a plain Node
   test.
   --------------------------------------------------------------- */

import { geoNaturalEarth1, geoPath, geoContains, geoGraticule10 } from "d3-geo";

export const MAP_W = 960, MAP_H = 480;

/* How far round a single project the "selected" view reaches. Roughly a
   country: enough neighbouring coastline to recognise where it is,
   which a tighter view at this resolution would not give. */
export const FOCUS_SPAN = { lat: 11, lon: 16 };
/* The smallest region the "all projects" view will zoom to. Two sites
   in the same county would otherwise fill the frame with one blunt
   polygon edge, because at 1:110 million that is all there is. */
export const MIN_SPAN = { lat: 7, lon: 10 };

const clampLat = (v) => Math.max(-85, Math.min(85, v));

/**
 * The lon/lat box a view should show: a set of points, padded, and
 * never tighter than a stated minimum.
 *
 * Returned as the points of its outline rather than as a polygon. A
 * spherical polygon wound the wrong way means "everything except this",
 * and fitting a projection to that zooms out to the whole globe without
 * complaint. A handful of points has no inside to get wrong.
 */
export function regionAround(points, minSpan = MIN_SPAN, pad = 0.18) {
  const pts = (points || []).filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon));
  if (!pts.length) return null;
  let s = Math.min(...pts.map((p) => p.lat)), n = Math.max(...pts.map((p) => p.lat));
  let w = Math.min(...pts.map((p) => p.lon)), e = Math.max(...pts.map((p) => p.lon));
  const grow = (lo, hi, min) => {
    const span = Math.max(hi - lo, 0);
    const want = Math.max(span * (1 + 2 * pad), min);
    const mid = (lo + hi) / 2;
    return [mid - want / 2, mid + want / 2];
  };
  [s, n] = grow(s, n, minSpan.lat);
  [w, e] = grow(w, e, minSpan.lon);
  s = clampLat(s); n = clampLat(n);
  w = Math.max(-180, w); e = Math.min(180, e);
  const mlat = (s + n) / 2, mlon = (w + e) / 2;
  return {
    box: { s, n, w, e },
    geo: { type: "MultiPoint", coordinates: [
      [w, s], [mlon, s], [e, s], [e, mlat], [e, n], [mlon, n], [w, n], [w, mlat],
    ] },
  };
}

/**
 * A Natural Earth projection fitted to the frame.
 *
 * With no region it shows the whole sphere, which reproduces the
 * travel page's own framing. With one, it shows that region and lets
 * the rest fall outside the frame.
 */
export function makeProjection(region = null, w = MAP_W, h = MAP_H, margin = 10) {
  const proj = geoNaturalEarth1();
  proj.fitExtent([[margin, margin], [w - margin, h - margin]], region ? region.geo : { type: "Sphere" });
  return proj;
}

/** Everything the drawing needs for one view, as path strings. */
export function drawWorld(features, region = null, w = MAP_W, h = MAP_H) {
  const projection = makeProjection(region, w, h);
  const path = geoPath(projection);
  const line = (lat) => ({ type: "LineString",
    coordinates: Array.from({ length: 73 }, (_, i) => [-180 + i * 5, lat]) });
  return {
    projection,
    sphere: path({ type: "Sphere" }),
    graticule: path(geoGraticule10()),
    equator: path(line(0)),
    tropics: [path(line(23.44)), path(line(-23.44))],
    countries: features.map((f) => ({ id: f.id, name: f.properties?.name || "", d: path(f) }))
      .filter((c) => c.d),
    /** Screen position of a point, or null if it cannot be placed. */
    at: (lon, lat) => {
      const p = projection([lon, lat]);
      return p && Number.isFinite(p[0]) && Number.isFinite(p[1]) ? { x: p[0], y: p[1] } : null;
    },
  };
}

/**
 * The country a point falls in, or null.
 *
 * Null is a real answer and is kept as one. At this scale a coastline
 * can be several kilometres from where the shore actually is, so a
 * floating array or a site on an estuary can sit just outside every
 * polygon. Snapping it to the nearest country would be a guess
 * presented as a lookup, and it would also give a country to a pair of
 * coordinates with the sign wrong — which is the one mistake a map is
 * best placed to show.
 */
export function countryOf(features, lon, lat) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  for (const f of features) {
    if (geoContains(f, [lon, lat])) return { id: f.id, name: f.properties?.name || "" };
  }
  return null;
}

/**
 * Records sharing a spot, gathered. Three reports for one site are one
 * place on a map, and three dots drawn on top of each other read as
 * one report with two hidden. `tol` is in degrees.
 */
export function groupBySpot(points, tol = 0.02) {
  const groups = [];
  for (const p of points) {
    const g = groups.find((q) => Math.abs(q.lat - p.lat) <= tol && Math.abs(q.lon - p.lon) <= tol);
    if (g) g.items.push(p); else groups.push({ lat: p.lat, lon: p.lon, items: [p] });
  }
  return groups;
}

/**
 * Spots that would land on top of each other at the current zoom,
 * merged. Two sites forty kilometres apart are two dots when the view
 * is a country and one smudge when it is the world, and a smudge with
 * two overlapping labels says less than one dot with a count. Merging
 * is by distance on screen, so it undoes itself as the view closes in.
 */
export function clusterOnScreen(placed, minPx = 13) {
  const out = [];
  for (const s of placed) {
    const c = out.find((q) => Math.hypot(q.p.x - s.p.x, q.p.y - s.p.y) < minPx);
    if (c) c.items.push(...s.items);
    else out.push({ ...s, items: [...s.items] });
  }
  return out;
}
