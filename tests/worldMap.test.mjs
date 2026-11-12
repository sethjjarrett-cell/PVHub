/* The tracker's world map: where a point falls, and what a view shows.

   The outlines are read from the installed world-atlas package, the
   same file the bundler inlines, so this runs against the data that
   ships. The places used are capitals and well-known points, none of
   them a project site. */

import { readFileSync } from "node:fs";
import { feature } from "topojson-client";
import {
  MAP_W, MAP_H, FOCUS_SPAN, MIN_SPAN, regionAround, makeProjection, drawWorld, countryOf, groupBySpot,
  clusterOnScreen,
} from "../src/worldMap.js";

const world = JSON.parse(readFileSync(new URL("../node_modules/world-atlas/countries-110m.json", import.meta.url), "utf8"));
const F = feature(world, world.objects.countries).features;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("  FAIL:", m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${a}, want ${b})`);
const near = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, `${m} (got ${a}, want ${b} ±${tol})`);

console.log("\n--- the outlines that ship ---");
eq(F.length, 177, "Natural Earth 1:110m carries 177 countries");
ok(F.every((f) => f.properties && typeof f.properties.name === "string"), "each with a name");

console.log("\n--- which country a point is in ---");
{
  const name = (lon, lat) => countryOf(F, lon, lat)?.name ?? null;
  eq(name(-0.13, 51.51), "United Kingdom", "London");
  eq(name(28.28, -15.42), "Zambia", "Lusaka");
  eq(name(28.19, -25.75), "South Africa", "Pretoria");
  eq(name(-70.65, -33.45), "Chile", "Santiago");
  eq(name(13.4, 52.52), "Germany", "Berlin");
  eq(name(151.2, -33.87), "Australia", "Sydney, close to the coast");
  eq(name(-30, 0), null, "the middle of the Atlantic is in no country");
  eq(name(-140, -40), null, "nor is the South Pacific");

  /* The mistake a map is best placed to show. Lusaka with the sign of
     its latitude lost is in the Sahel, and with its longitude lost it
     is in the Atlantic: the first lands in some other country, the
     second in none, and neither is where the report meant. */
  ok(name(28.28, 15.42) !== "Zambia", "a latitude with its sign lost is not in Zambia");
  eq(name(-28.28, -15.42), null, "and a longitude with its sign lost is in the sea");

  eq(countryOf(F, NaN, 10), null, "a missing coordinate is in no country");
  eq(countryOf(F, 10, undefined), null, "nor is half of one");
}

console.log("\n--- the world view ---");
{
  const p = makeProjection(null);
  const c = p([0, 0]);
  near(c[0], MAP_W / 2, 0.5, "the equator and the prime meridian cross at the middle, across");
  near(c[1], MAP_H / 2, 0.5, "and down");
  const n = p([0, 89]), s = p([0, -89]), w = p([-179.9, 0]), e = p([179.9, 0]);
  ok(n[1] >= 0 && s[1] <= MAP_H, "both poles are inside the frame");
  ok(w[0] >= 0 && e[0] <= MAP_W, "and both ends of the equator");
  ok(n[1] < s[1], "north is up");
  ok(w[0] < e[0], "east is right");

  const m = drawWorld(F, null);
  eq(m.countries.length, 177, "every country draws in the world view");
  ok(m.sphere && m.graticule && m.equator && m.tropics.length === 2, "with the sphere, graticule, equator and both tropics");
  const lon = m.at(-0.13, 51.51), lus = m.at(28.28, -15.42);
  ok(lon.y < lus.y && lon.x < lus.x, "London is drawn north and west of Lusaka");
}

console.log("\n--- zooming to projects ---");
{
  eq(regionAround([]), null, "no points, no region");
  eq(regionAround([{ lat: NaN, lon: 3 }]), null, "nor from a point with no latitude");

  /* One point must not zoom to nothing. */
  const one = regionAround([{ lat: -15.42, lon: 28.28 }]);
  near(one.box.n - one.box.s, MIN_SPAN.lat, 1e-9, "a single site still shows the minimum span of latitude");
  near(one.box.e - one.box.w, MIN_SPAN.lon, 1e-9, "and of longitude");
  near((one.box.n + one.box.s) / 2, -15.42, 1e-9, "centred on the site");

  const sel = regionAround([{ lat: 52.27, lon: -1.15 }], FOCUS_SPAN, 0);
  near(sel.box.n - sel.box.s, FOCUS_SPAN.lat, 1e-9, "the selected view uses its own, wider span");

  /* Two distant sites: the region holds both, with room round them. */
  const two = regionAround([{ lat: 52.27, lon: -1.15 }, { lat: -15.36, lon: 28.28 }]);
  ok(two.box.s < -15.36 && two.box.n > 52.27 && two.box.w < -1.15 && two.box.e > 28.28, "both sites are inside, with a margin");
  const m = drawWorld(F, two);
  for (const [lat, lon, who] of [[52.27, -1.15, "the northern site"], [-15.36, 28.28, "the southern site"]]) {
    const p = m.at(lon, lat);
    ok(p.x > 0 && p.x < MAP_W && p.y > 0 && p.y < MAP_H, `${who} is inside the frame when zoomed`);
  }
  const wide = makeProjection(null), tight = makeProjection(two);
  ok(tight.scale() > wide.scale(), "and the view really is closer than the world view");

  /* Near a pole and near the date line the box is clipped, not wrapped. */
  const polar = regionAround([{ lat: 84, lon: 10 }]);
  ok(polar.box.n <= 85, "latitude is held inside the projection's usable range");
  const edge = regionAround([{ lat: 0, lon: 178 }]);
  ok(edge.box.e <= 180, "and longitude stops at the date line");
  ok(regionAround([{ lat: 10, lon: 10 }]).geo.type === "MultiPoint", "the region is points, with no inside to wind the wrong way");
}

console.log("\n--- reports that share a site ---");
{
  const g = groupBySpot([
    { id: "a", lat: 52.27, lon: -1.15 }, { id: "b", lat: 52.271, lon: -1.149 },
    { id: "c", lat: 52.98, lon: -0.87 }, { id: "d", lat: 52.27, lon: -1.15 },
  ]);
  eq(g.length, 2, "four reports at two sites are two spots");
  eq(g[0].items.length, 3, "three of them at the first");
  eq(g[1].items.length, 1, "and one at the second");
  eq(groupBySpot([]).length, 0, "no reports, no spots");
}

console.log("\n--- sites that overlap at the current zoom ---");
{
  const a = { lat: 52.27, lon: -1.15, items: [{ id: 1 }, { id: 2 }, { id: 3 }] };
  const b = { lat: 52.98, lon: -0.87, items: [{ id: 4 }, { id: 5 }] };
  const c = { lat: -15.36, lon: 28.28, items: [{ id: 6 }] };
  const place = (m) => [a, b, c].map((s) => ({ ...s, p: m.at(s.lon, s.lat) }));

  const world = clusterOnScreen(place(drawWorld(F, null)));
  eq(world.length, 2, "across the whole world, two sites eighty kilometres apart are one dot");
  eq(world[0].items.length, 5, "carrying all five of their reports");
  eq(world[1].items.length, 1, "and the distant one stays its own");

  const close = clusterOnScreen(place(drawWorld(F, regionAround([a], FOCUS_SPAN, 0))));
  eq(close.filter((s) => s.p.x > 0 && s.p.x < MAP_W).length >= 2, true, "zoomed to the country, they come apart again");
  eq(a.items.length, 3, "and merging never altered the spots it was given");

  /* The finer outline is the same countries under the same ids, so a
     tint worked out on one draws correctly on the other. */
  const w50 = JSON.parse(readFileSync(new URL("../node_modules/world-atlas/countries-50m.json", import.meta.url), "utf8"));
  const F50 = feature(w50, w50.objects.countries).features;
  const id110 = countryOf(F, 28.28, -15.42).id, id50 = countryOf(F50, 28.28, -15.42).id;
  eq(id50, id110, "Zambia has the same id in both outline sets");
  ok(F50.length >= F.length, "and the finer set carries at least as many countries");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
