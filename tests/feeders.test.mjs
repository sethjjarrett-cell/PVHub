/* MV feeders: which stations share a cable home. */

import { planFeeders, feederRuns } from "../src/feeders.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("  FAIL:", m); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const near = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, `${m} (got ${a}, want ${b} ±${tol})`);

/* Points joined in a chain, in order, as a route graph. */
function line(xs) {
  const nodes = xs.map((x) => ({ x, y: 0, adj: [] }));
  for (let i = 0; i + 1 < nodes.length; i++) {
    const d = Math.abs(nodes[i + 1].x - nodes[i].x);
    nodes[i].adj.push([i + 1, d]); nodes[i + 1].adj.push([i, d]);
  }
  return { nodes };
}
const st = (node, used, mva = used * 0.35) => ({ node, used, mva });

console.log("\n--- no limit, no feeders ---");
{
  const g = line([0, 100, 200, 300]);
  eq(planFeeders({ graph: g, stations: [st(1, 10)], poiNode: 0 }), null, "with no limit entered, the radials stay");
  eq(planFeeders({ graph: g, stations: [st(1, 10)], poiNode: 0, limitMva: 0 }), null, "a limit of zero is no limit");
  eq(planFeeders({ graph: g, stations: [], poiNode: 0, limitMva: 20 }), null, "no stations, nothing to group");
}

console.log("\n--- three stations in a line ---");
{
  /* Grid point at 0, stations at 100, 200 and 300 m along one corridor. */
  const g = line([0, 100, 200, 300]);
  const S = [st(1, 10), st(2, 10), st(3, 10)];
  const all = planFeeders({ graph: g, stations: S, poiNode: 0, limitMva: 20 });
  eq(all.feeders.length, 1, "with room for all three, one feeder");
  eq(all.feeders[0].chain, [2, 1, 0], "starting at the farthest and picking up the others on the way home");
  near(all.total, 300, 1e-9, "three hundred metres of cable");
  near(all.radial, 600, 1e-9, "where three radials would be six hundred");
  near(all.feeders[0].mva, 10.5, 1e-9, "carrying all thirty inverters on its last stretch");

  const two = planFeeders({ graph: g, stations: S, poiNode: 0, limitMva: 7.5 });
  eq(two.feeders.map((f) => f.chain), [[2, 1], [0]], "with room for two, the far pair share and the near one runs alone");
  near(two.total, 400, 1e-9, "four hundred metres: 300→200, 200→home, and 100→home");
  ok(two.feeders.every((f) => f.mva <= 7.5 + 1e-9), "no feeder exceeds its limit");

  const one = planFeeders({ graph: g, stations: S, poiNode: 0, limitMva: 4 });
  eq(one.feeders.length, 3, "with room for one each, they are radials again");
  near(one.total, one.radial, 1e-9, "and cost the same as radials");
}

console.log("\n--- stations either side of the grid point ---");
{
  /* -100, 0, +100: going via the other side is never shorter. */
  const g = line([-100, 0, 100]);
  const p = planFeeders({ graph: g, stations: [st(0, 10), st(2, 10)], poiNode: 1, limitMva: 50 });
  eq(p.feeders.length, 2, "two stations on opposite sides are not chained, however much room there is");
  near(p.total, 200, 1e-9, "because the detour would be longer than either one's own run");
}

console.log("\n--- the edges of the problem ---");
{
  const g = line([0, 100, 200]);
  const big = planFeeders({ graph: g, stations: [st(1, 10, 9), st(2, 10)], poiNode: 0, limitMva: 5 });
  eq(big.over, [0], "a station bigger than the feeder limit on its own is named");
  ok(big.feeders.some((f) => f.chain.length === 1 && f.chain[0] === 0), "and still gets a cable, alone, rather than vanishing");

  const cut = { nodes: [{ x: 0, y: 0, adj: [] }, { x: 100, y: 0, adj: [] }] };
  const u = planFeeders({ graph: cut, stations: [st(1, 10)], poiNode: 0, limitMva: 20 });
  eq(u.unreachable, [0], "a station the grid point cannot reach is listed");
  eq(u.feeders.length, 0, "and has no feeder drawn to it");

  const stub = planFeeders({ graph: line([0, 100]), stations: [st(1, 10)], poiNode: 0, poiStub: 15, limitMva: 20 });
  near(stub.total, 115, 1e-9, "the straight stub from the graph to the grid point is part of the last run");
}

console.log("\n--- the run table the MV tab reads ---");
{
  const g = line([0, 100, 200, 300]);
  const p = planFeeders({ graph: g, stations: [st(1, 14), st(2, 11), st(3, 9)], poiNode: 0, limitMva: 50 });
  const runs = feederRuns(p, { install: "direct", size: 240 });
  eq(runs, [
    { branch: 1, from: "TS3", to: "TS2", inv: 9, install: "direct", size: 240, dist: 100 },
    { branch: 1, from: "TS2", to: "TS1", inv: 11, install: "direct", size: 240, dist: 100 },
    { branch: 1, from: "TS1", to: "POC", inv: 14, install: "direct", size: 240, dist: 100 },
  ], "one branch, far end first, each run carrying the inverters joining at its own end");
  eq(runs.reduce((a, r) => a + r.inv, 0), 34, "so the current the tab builds up on the last run is all of them");
  eq(feederRuns(null), null, "no plan, no runs");
  const paths = p.feeders[0].paths;
  eq(paths.length, 3, "a drawn path for every run");
  eq(paths[0][0], { x: 300, y: 0 }, "each starting at its own station");
  eq(paths[2][paths[2].length - 1], { x: 0, y: 0 }, "and the last ending at the grid point's node");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
