/* ---------------------------------------------------------------
   Where an exported drawing sits on the earth.

   The layout works in local metres with y running down the screen,
   which is south. A drawing taken out of the tool has to go back the
   other way, and which way depends on where the boundary came from:

     a DXF      — back into the coordinates of the drawing it was
                  read from, so the export overlays the source exactly;
     a KML/KMZ  — into UTM, the projected grid every CAD and GIS
                  package and PVcase all open in place, with the zone
                  and its EPSG code stated;
     drawn      — local metres, north up, and said to be local, since
                  a drawn boundary has no position of its own.

   UTM is the Krüger series to the sixth order (Karney 2011), which is
   accurate to well under a millimetre across a zone. No library: the
   arithmetic is a page and it is tested against PROJ's own answers.

   No React.
   --------------------------------------------------------------- */

import { localToLonLat, makeGeoRef } from "./sitePull.js";

const fin = (v) => Number.isFinite(v);
const RAD = Math.PI / 180;

/* WGS84 */
const A = 6378137, F = 1 / 298.257223563, K0 = 0.9996;
const N3 = F / (2 - F);
const N = [1, N3, N3 ** 2, N3 ** 3, N3 ** 4, N3 ** 5, N3 ** 6];
/* Rectifying radius. */
const AR = (A / (1 + N3)) * (1 + N[2] / 4 + N[4] / 64 + N[6] / 256);
/* Krüger α coefficients, to n^6. */
const ALPHA = [
  0,
  N[1] / 2 - (2 / 3) * N[2] + (5 / 16) * N[3] + (41 / 180) * N[4] - (127 / 288) * N[5] + (7891 / 37800) * N[6],
  (13 / 48) * N[2] - (3 / 5) * N[3] + (557 / 1440) * N[4] + (281 / 630) * N[5] - (1983433 / 1935360) * N[6],
  (61 / 240) * N[3] - (103 / 140) * N[4] + (15061 / 26880) * N[5] + (167603 / 181440) * N[6],
  (49561 / 161280) * N[4] - (179 / 168) * N[5] + (6601661 / 7257600) * N[6],
  (34729 / 80640) * N[5] - (3418889 / 1995840) * N[6],
  (212378941 / 319334400) * N[6],
];
const E = Math.sqrt(F * (2 - F));

/** The standard UTM zone of a point, with Norway's and Svalbard's exceptions. */
export function utmZone(lon, lat) {
  let z = Math.floor((((lon + 180) % 360) + 360) % 360 / 6) + 1;
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) z = 32;
  if (lat >= 72 && lat < 84) {
    if (lon >= 0 && lon < 9) z = 31;
    else if (lon >= 9 && lon < 21) z = 33;
    else if (lon >= 21 && lon < 33) z = 35;
    else if (lon >= 33 && lon < 42) z = 37;
  }
  return z;
}

/**
 * Longitude and latitude to UTM easting and northing in a given zone
 * and hemisphere. Points just over a zone edge are projected into the
 * zone asked for, which is what a site straddling an edge needs.
 */
export function toUtm(lon, lat, zone, south = lat < 0) {
  const lon0 = (zone - 1) * 6 - 180 + 3;
  const phi = lat * RAD, lam = (lon - lon0) * RAD;
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - E * Math.atanh(E * Math.sin(phi)));
  const xi = Math.atan2(t, Math.cos(lam));
  const eta = Math.atanh(Math.sin(lam) / Math.sqrt(1 + t * t));
  let x = eta, y = xi;
  for (let j = 1; j <= 6; j++) {
    x += ALPHA[j] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    y += ALPHA[j] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
  }
  return {
    e: 500000 + K0 * AR * x,
    n: (south ? 10000000 : 0) + K0 * AR * y,
    zone, south,
  };
}

export const utmEpsg = (zone, south) => (south ? 32700 : 32600) + zone;

/**
 * The transform from layout metres to the coordinates a drawing should
 * be written in, and a sentence saying what they are.
 *
 * `geoOrigin` is the shift the DXF import took off; `geoRef` is the
 * KML georeference. Neither: local, north up.
 */
export function exportFrame({ geoOrigin = null, geoRef = null } = {}) {
  if (geoOrigin && fin(geoOrigin.x) && fin(geoOrigin.y)) {
    const o = geoOrigin;
    return {
      kind: "source",
      /* The import took (X, Y) to (X − ox, −Y − oy). */
      fn: (p) => ({ ...p, x: p.x + o.x, y: -(p.y + o.y) }),
      label: "the coordinates of the DXF the boundary was read from",
      note: "Same coordinate system as the drawing the boundary was imported from, so it overlays that drawing exactly.",
    };
  }
  const g = geoRef && fin(geoRef.lat) && fin(geoRef.lon) && geoRef.source === "kml" ? makeGeoRef(geoRef) : null;
  if (g) {
    const zone = utmZone(g.lon, g.lat), south = g.lat < 0, epsg = utmEpsg(zone, south);
    return {
      kind: "utm", zone, south, epsg,
      fn: (p) => {
        const [lon, lat] = localToLonLat(p, g);
        const u = toUtm(lon, lat, zone, south);
        return { ...p, x: u.e, y: u.n };
      },
      label: `WGS 84 / UTM zone ${zone}${south ? "S" : "N"} (EPSG:${epsg})`,
      note: `Easting and northing in WGS 84 / UTM zone ${zone}${south ? "S" : "N"}, EPSG:${epsg}. `
        + "Set the drawing to that system and it lands on the map in place.",
    };
  }
  return {
    kind: "local",
    fn: (p) => ({ ...p, x: p.x, y: -p.y }),
    label: "local metres, north up",
    note: "Local metres with north up. The boundary was drawn, or read without a position on the earth, "
      + "so the drawing is to scale but not placed: import the boundary as KML or KMZ to export it in UTM.",
  };
}
