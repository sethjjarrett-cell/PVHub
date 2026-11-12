/* ---------------------------------------------------------------
   MV feeders: which stations share a cable back to the grid point.

   Until now every station had its own MV run to the point of
   connection. That is a valid design and the easiest to reason about,
   but it is not how most collectors are built: stations are chained
   along a feeder, each joining the cable on its way past, so there is
   less cable in total and the last stretch carries every station on
   it. That last stretch is what sets the cable size.

   The grouping here is a greedy one, chosen because it can be
   explained in a sentence rather than because it is optimal:

     start a feeder at the station farthest from the grid point;
     keep adding the unassigned station that costs the least detour
       to pass on the way home, while the feeder stays inside its
       limit and the detour is shorter than that station's own run;
     when nothing more fits, run the feeder home, and start the next.

   The limit is a feeder's capacity in MVA, typed in, and nothing is
   assumed for it: it is the derated rating of the largest MV cable the
   project is prepared to lay, at its voltage, which the MV tab works
   out and this file has no business guessing. With no limit, every
   station stays on its own radial, which is what the layout has always
   drawn.

   No React.
   --------------------------------------------------------------- */

import { shortestFrom, pathPoints } from "./siteConstraints.js";

const fin = (v) => Number.isFinite(v);

/**
 * Group stations into feeders.
 *
 * `stations` is [{ node, used, mva }] with `node` an index into the
 * route graph; `poiNode` is the graph node nearest the grid point and
 * `poiStub` the straight distance from that node to the point itself.
 * Returns null when there is no limit, so the caller keeps its radials.
 */
export function planFeeders({ graph, stations, poiNode, poiStub = 0, limitMva }) {
  if (!(limitMva > 0) || !graph || !(poiNode >= 0) || !stations?.length) return null;
  const n = stations.length;
  /* Shortest distances between every pair of stations, and to the grid
     point. A site has tens of stations, not thousands, so one search
     from each is cheap and keeps the arithmetic plain. */
  const fromPoi = shortestFrom(graph, poiNode);
  const toPoi = stations.map((s) => (s.node >= 0 ? fromPoi.dist[s.node] : Infinity));
  const search = stations.map((s) => (s.node >= 0 ? shortestFrom(graph, s.node) : null));
  const d = (i, j) => (search[i] ? search[i].dist[stations[j].node] : Infinity);

  const over = stations.map((s, i) => (s.mva > limitMva ? i : -1)).filter((i) => i >= 0);
  const unreachable = stations.map((s, i) => (fin(toPoi[i]) ? -1 : i)).filter((i) => i >= 0);
  const left = new Set(stations.map((_, i) => i).filter((i) => fin(toPoi[i])));
  const feeders = [];

  while (left.size) {
    let start = -1;
    for (const i of left) if (start < 0 || toPoi[i] > toPoi[start]) start = i;
    const chain = [start];
    let mva = stations[start].mva;
    left.delete(start);
    for (;;) {
      const end = chain[chain.length - 1];
      let best = -1, bestCost = Infinity, bestVia = Infinity;
      for (const s of left) {
        if (mva + stations[s].mva > limitMva + 1e-9) continue;
        const via = d(end, s);
        if (!fin(via)) continue;
        /* What passing s costs on the way home, against going straight
           home from here. Worth taking only if it is less than s would
           cost on a run of its own. Ties go to the nearer station: two
           stations on the way home both cost nothing extra, and taking
           the farther first would leave the nearer one stranded behind
           the feeder rather than picked up as it passes. */
        const detour = via + toPoi[s] - toPoi[end];
        if (!(detour < toPoi[s])) continue;
        if (detour < bestCost - 1e-6 || (Math.abs(detour - bestCost) <= 1e-6 && via < bestVia)) {
          best = s; bestCost = detour; bestVia = via;
        }
      }
      if (best < 0) break;
      chain.push(best);
      mva += stations[best].mva;
      left.delete(best);
    }
    feeders.push({ chain, mva });
  }

  /* Each feeder as runs, far end first, the way the MV tab reads a
     branch: a run carries the inverters joining at its own end, and
     the current builds up towards the grid point. */
  let total = 0;
  const out = feeders.map(({ chain, mva }, f) => {
    const runs = [], paths = [];
    for (let k = 0; k < chain.length; k++) {
      const i = chain[k], last = k === chain.length - 1;
      const len = last ? toPoi[i] + poiStub : d(i, chain[k + 1]);
      runs.push({ from: i, to: last ? null : chain[k + 1], len, used: stations[i].used });
      const tgt = last ? poiNode : stations[chain[k + 1]].node;
      paths.push(pathPoints(graph, search[i].prev, tgt).reverse());
      total += len;
    }
    return { index: f, chain, mva, runs, paths };
  });

  const radial = stations.reduce((a, s, i) => a + (fin(toPoi[i]) ? toPoi[i] + poiStub : 0), 0);
  return { feeders: out, total, radial, over, unreachable, limitMva };
}

/** A feeder plan as the MV tab's run table: one branch per feeder. */
export function feederRuns(plan, { install = "duct", size = 150 } = {}) {
  if (!plan) return null;
  return plan.feeders.flatMap((f) => f.runs.map((r) => ({
    branch: f.index + 1, from: `TS${r.from + 1}`, to: r.to === null ? "POC" : `TS${r.to + 1}`,
    inv: r.used, install, size, dist: Math.round(r.len),
  })));
}
