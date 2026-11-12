/* Where an exported drawing sits on the earth. */

import { utmZone, toUtm, utmEpsg, exportFrame } from "../src/geoExport.js";
import { makeGeoRef, lonLatToLocal } from "../src/sitePull.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("  FAIL:", m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const near = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, `${m} (got ${a}, want ${b} ±${tol})`);

/* Reference values from PROJ (pyproj 3, EPSG:4326 to EPSG:326xx/327xx). */
const REF = [
  [-1.0, 52.0, 30, 32630, 637294.3659, 5762926.8129],
  [-8.860021, 8.616413, 29, 32629, 515401.5297, 952447.1209],
  [28.28, -15.36, 35, 32735, 637386.5210, 8301449.2320],
  [151.2093, -33.8688, 56, 32756, 334368.6336, 6250948.3454],
  [-106.651, 35.0845, 13, 32613, 349491.4333, 3883660.4704],
  [2.9999, 0.0001, 31, 32631, 499988.8725, 11.0530],
  [6.0, 60.0, 32, 32632, 332705.1789, 6655205.4836],
  [-71.5, -33.4, 19, 32719, 267490.6213, 6301574.1701],
  [179.9, 10.0, 60, 32660, 817955.4277, 1106810.6571],
  [-0.5, 51.5, 30, 32630, 673519.5036, 5708392.6526],
  [5.9, 51.5, 31, 32631, 701277.6651, 5709417.1248],
];

console.log("\n--- UTM against PROJ ---");
for (const [lon, lat, z, epsg, e, n] of REF) {
  eq(utmZone(lon, lat), z, `${lat}, ${lon} is in zone ${z}`);
  eq(utmEpsg(z, lat < 0), epsg, `which is EPSG:${epsg}`);
  const u = toUtm(lon, lat, z);
  near(u.e, e, 0.001, `easting at ${lat}, ${lon} to a millimetre`);
  near(u.n, n, 0.001, `northing at ${lat}, ${lon} to a millimetre`);
}

console.log("\n--- the shape of the grid ---");
{
  near(toUtm(3, 0, 31).e, 500000, 1e-6, "the central meridian is 500 km east");
  near(toUtm(3, 0, 31).n, 0, 1e-6, "and the equator is northing zero in the north");
  near(toUtm(3, -0.0, 31, true).n, 10000000, 1e-6, "and ten thousand km in the south");
  /* UTM stops at 84° north; PROJ's answers there, on and off the meridian. */
  near(toUtm(3, 84, 31).n, 9328093.8306, 0.001, "at the grid's northern limit, to a millimetre");
  near(toUtm(5.5, 83.9, 31).e, 529650.4469, 0.001, "and off the meridian there");
  near(500000 - toUtm(-3.4, 52, 30).e, toUtm(-2.6, 52, 30).e - 500000, 1e-6, "mirror images across the central meridian");
  eq(utmZone(7, 60), 32, "south-west Norway takes zone 32");
  eq(utmZone(10, 78), 33, "and Svalbard its own wide zones");
  eq(utmZone(-180, 0), 1, "the antimeridian starts zone 1");
  const edge = toUtm(6.05, 51.5, 31);
  ok(edge.e > 700000, "a point just over a zone edge is projected into the zone asked for");
}

console.log("\n--- exporting the layout ---");
{
  const loc = exportFrame({});
  eq(loc.kind, "local", "nothing to go on: local metres");
  eq(loc.fn({ x: 10, y: 20 }), { x: 10, y: -20 }, "north up, so local y is negated");
  ok(/not placed/.test(loc.note), "and says it is not placed");

  /* A DXF read with Y up and shifted: (X, Y) → (X − ox, −Y − oy). */
  const org = { x: 637000, y: -5763000 };
  const src = exportFrame({ geoOrigin: org });
  const X = 637294.37, Y = 5762926.81;
  const local = { x: X - org.x, y: -Y - org.y };
  const back = src.fn(local);
  near(back.x, X, 1e-6, "a DXF boundary goes back to its own easting");
  near(back.y, Y, 1e-6, "and northing, so the export overlays the source");
  eq(src.kind, "source", "and is labelled as the source's coordinates");

  const g = makeGeoRef({ lat: 52, lon: -1, source: "kml" });
  const utm = exportFrame({ geoRef: { lat: 52, lon: -1, x0: 0, y0: 0, source: "kml" } });
  eq(utm.kind, "utm", "a KML boundary goes out in UTM");
  eq(utm.epsg, 32630, "zone 30N");
  ok(/EPSG:32630/.test(utm.label), "with its EPSG code in the label");
  const o = utm.fn({ x: 0, y: 0 });
  near(o.x, 637294.3659, 0.001, "the reference point lands on PROJ's easting");
  near(o.y, 5762926.8129, 0.001, "and northing");
  const p = utm.fn(lonLatToLocal([-0.99, 51.995], g));
  ok(p.x > o.x && p.y < o.y, "a point east and south of it is east and south in UTM");
  const d = utm.fn({ x: 100, y: 0 });
  /* Two degrees off the central meridian at 52°, the grid scale is
     0.9996 × (1 + (Δλ cos φ)²/2) = 0.99983. */
  near(Math.hypot(d.x - o.x, d.y - o.y), 99.983, 0.003, "a hundred metres east is 99.983 grid metres, the scale two degrees off the meridian");
  eq(exportFrame({ geoRef: { lat: 52, lon: -1, source: "assumed" } }).kind, "local",
     "an assumed position is never exported as though it were surveyed");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
