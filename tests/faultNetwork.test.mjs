/* Fault network: the IEC 60364-5-54 tables, the fault arithmetic and
   the checks that decide whether a conductor survives a fault.

   The strongest assertion here is the first block: every k value in
   Annex A is reproduced from the Annex A formula using the Table
   A.54.1 material parameters. That ties the transcribed tables, the
   conductor constants and the adiabatic function together, so a typo
   in any one of the three shows up. */

import {
  K_TABLES, K_TABLE_LIST, kFor, kDerived, PE_TABLE_54_2, peFromTable54_2,
  nextStandardSize, conductorR, alphaFor, hasR, transformerSource, gridSource,
  solveNetwork, deviceCheck, adiabatic, checkCable, defaultNetwork, C_FACTOR, X_PER_M,
  hasRTable,
} from "../src/faultNetwork.js";
import { CONDUCTOR, SIZES, adiabaticK } from "../src/cableData.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("  FAIL:", m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${a}, want ${b})`);
const near = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, `${m} (got ${a}, want ${b} ±${tol})`);

/* ---------------------------------------------------------------
   The tables against the formula they came from
   --------------------------------------------------------------- */
console.log("\n--- Annex A: every tabulated k reproduced from the formula ---");
{
  let checked = 0, worst = 0, worstWhere = "";
  for (const id of K_TABLE_LIST) {
    const t = K_TABLES[id];
    for (const row of t.rows) {
      for (const mat of ["copper", "aluminium", "steel"]) {
        const cell = row[mat];
        if (!cell) continue;
        for (const big of [false, true]) {
          const k = big ? cell[1] : cell[0];
          const tf = row.tfBy ? row.tfBy[mat] : (big ? row.tf[1] : row.tf[0]);
          const calc = adiabaticK(CONDUCTOR[mat], row.ti, tf);
          const d = Math.abs(calc - k);
          if (d > worst) { worst = d; worstWhere = `${t.ref} ${row.name} ${mat}${big ? " >300" : ""}`; }
          checked++;
          ok(d <= 1.0, `${t.ref} ${row.name} ${mat}${big ? " >300" : ""}: table ${k}, formula ${calc.toFixed(1)}`);
        }
      }
    }
  }
  console.log(`    ${checked} values, worst deviation ${worst.toFixed(2)} at ${worstWhere}`);
}

console.log("\n--- the k lookup ---");
{
  /* The case on the worked example that prompted this tool. */
  const a = kFor({ table: "a544", insulation: "xlpe", material: "aluminium", size: 185 });
  eq(a.k, 94, "aluminium XLPE core in a cable is k = 94");
  eq(a.thetaI, 90, "and starts at the conductor's 90 °C operating temperature");
  eq(a.thetaF, 250, "and is allowed 250 °C");
  eq(a.footnote, null, "no footnote at 185 mm²");

  /* The footnote that gets skipped. A 400 mm² PVC conductor taken at
     115 rather than 103 is overstated by 12%. */
  const small = kFor({ table: "a544", insulation: "pvc70", material: "copper", size: 300 });
  const big = kFor({ table: "a544", insulation: "pvc70", material: "copper", size: 400 });
  eq(small.k, 115, "PVC copper core at 300 mm² is 115");
  eq(big.k, 103, "and 103 above 300 mm², per the footnote");
  ok(big.footnote && /300/.test(big.footnote), "the drop is stated, not silent");
  eq(big.thetaF, 140, "the final temperature drops with it");

  /* Same conductor, different place in the cable, different k. */
  eq(kFor({ table: "a542", insulation: "xlpe", material: "copper", size: 95 }).k, 176,
     "copper XLPE loose in a conduit is 176");
  eq(kFor({ table: "a544", insulation: "xlpe", material: "copper", size: 95 }).k, 143,
     "the same conductor as a core in a cable is 143, because it starts hot");
  eq(kFor({ table: "a545", insulation: "xlpe", material: "steel", size: 95 }).k, 46,
     "steel armour used as the earth is 46");

  const none = kFor({ table: "a545", insulation: "minbare", material: "aluminium", size: 50 });
  eq(none.k, null, "a cell the standard leaves empty returns nothing");
  ok(/does not tabulate/.test(none.miss), "and says so rather than guessing");
}

console.log("\n--- k derived from the formula is labelled as derived ---");
{
  const d = kDerived({ material: "copper", thetaI: 70, thetaF: 160 });
  eq(d.source, "derived", "flagged as derived");
  near(d.k, 115, 1.5, "reproduces the tabulated PVC copper case");
  ok(/√\(ln/.test(d.arithmetic), "shows its arithmetic");
  ok(/not read from a table/.test(d.note), "and warns that it is not a standard value");
  eq(kFor({ table: "a544", insulation: "xlpe", material: "copper", size: 50 }).source, "table",
     "a tabulated value is flagged as a table value");
}

/* ---------------------------------------------------------------
   Table 54.2
   --------------------------------------------------------------- */
console.log("\n--- Table 54.2, the protective conductor rule ---");
{
  eq(peFromTable54_2({ sLine: 10 }).raw, 10, "at or below 16, the PE matches the line");
  eq(peFromTable54_2({ sLine: 16 }).raw, 16, "16 is in the first band, not the second");
  eq(peFromTable54_2({ sLine: 25 }).raw, 16, "between 16 and 35 it is a flat 16");
  eq(peFromTable54_2({ sLine: 35 }).raw, 16, "35 is still the flat band");
  eq(peFromTable54_2({ sLine: 50 }).raw, 25, "above 35 it halves");
  const w = peFromTable54_2({ sLine: 185 });
  eq(w.raw, 92.5, "185 halves to 92.5");
  eq(w.standard, 95, "and takes the next standard size up, never down");
  eq(w.row, "S > 35", "the row is reported");

  /* k1/k2 when the PE is not the same material as the line. An
     aluminium line with a copper earth needs less copper. */
  const diff = peFromTable54_2({ sLine: 185, k1: 94, k2: 143 });
  near(diff.raw, 60.8, 0.1, "aluminium line, copper PE: 92.5 × 94/143");
  eq(diff.standard, 70, "rounded up to a standard size");
  ok(diff.differing, "flagged as a mixed-material case");
  ok(/k₁\/k₂/.test(diff.arithmetic), "and the correction is shown");

  const same = peFromTable54_2({ sLine: 185, k1: 94, k2: 94 });
  eq(same.raw, 92.5, "equal k values apply no correction");
  ok(!same.differing, "and are not flagged as mixed");

  ok(peFromTable54_2({}).miss, "no line size is reported as missing");
}

console.log("\n--- next standard size ---");
{
  eq(nextStandardSize(92.5), 95, "rounds up to the next standard area");
  eq(nextStandardSize(95), 95, "an exact standard size is kept");
  eq(nextStandardSize(0.5), 1.5, "below the table, the smallest standard size");
  eq(nextStandardSize(900), null, "above the table, nothing rather than a made-up size");
  for (const s of SIZES) eq(nextStandardSize(s), s, `${s} mm² is itself a standard size`);
}

/* ---------------------------------------------------------------
   Conductors
   --------------------------------------------------------------- */
console.log("\n--- conductor resistance ---");
{
  const cold = conductorR({ size: 185, material: "aluminium", lengthM: 100, tempC: 20 });
  const hot = conductorR({ size: 185, material: "aluminium", lengthM: 100, tempC: 90 });
  near(cold, 0.0164, 1e-5, "185 mm² aluminium, 100 m, 20 °C");
  ok(hot > cold, "resistance rises with temperature");
  near(hot / cold, 1 + alphaFor("aluminium") * 70, 1e-6, "by α(θ−20), with α from Table A.54.1's β");
  near(alphaFor("copper"), 1 / 254.5, 1e-9, "copper α is 1/(β+20)");

  const two = conductorR({ size: 185, material: "aluminium", lengthM: 100, parallel: 2, tempC: 20 });
  near(two, cold / 2, 1e-9, "two in parallel halve the resistance");

  ok(hasR(630, "copper"), "IEC 60228 carries 630 mm² copper");
  ok(!hasR(1.5, "aluminium"), "it does not carry 1.5 mm² aluminium");
  eq(conductorR({ size: 1.5, material: "aluminium", lengthM: 10 }), null,
     "and a size that is not tabulated returns nothing rather than an interpolation");

  /* Steel is in the k tables, because armour is a legitimate earth
     path, but it is not in IEC 60228, because its resistance depends
     on the wire count and lay. Falling through to the copper table
     would understate a steel earth loop by about eight times. */
  ok(hasRTable("copper") && hasRTable("aluminium"), "copper and aluminium have resistance tables");
  ok(!hasRTable("steel"), "steel does not");
  eq(conductorR({ size: 95, material: "steel", lengthM: 100 }), null,
     "so steel returns no resistance rather than copper's");
  ok(!hasR(95, "steel"), "and no size reads as available for it");
  ok(kFor({ table: "a545", insulation: "xlpe", material: "steel", size: 95 }).k > 0,
     "while k for steel armour is still available, because that needs no resistance");

  const armoured = { source: { kind: "tx", kva: 1000, ukPct: 5, uSecV: 400, u0V: 230 },
    nodes: [{ id: "a", parent: null, cable: { size: 95, material: "copper", insulation: "xlpe",
      kTable: "a545", peSize: 50, peMaterial: "steel", lengthM: 40, operatingC: 90 }, device: {} }] };
  const sa = solveNetwork(armoured).nodes.get("a");
  ok(sa.miss.some((m) => /does not tabulate steel/.test(m)), "the solver names the cause");
  ok(sa.miss.some((m) => /cable maker/.test(m)), "and where to get the number");
  ok(sa.miss.some((m) => /adiabatic check below is unaffected/.test(m)),
     "and says what still works");
}

/* ---------------------------------------------------------------
   Sources
   --------------------------------------------------------------- */
console.log("\n--- the transformer, against the worked example ---");
{
  const t = transformerSource({ kva: 1250, ukPct: 5, uSecV: 400, c: 1 });
  near(t.ik3, 36084.4, 1, "1250 kVA at 5% on 400 V gives 36.08 kA");
  near(t.z, 0.0064, 1e-6, "Z = uk × U² / S");
  near(t.iRated, 1804.2, 0.5, "and 1804 A of rated current");
  near(Math.hypot(t.r, t.x), t.z, 1e-9, "R and X recombine to Z");
  near(t.x / t.r, 10, 1e-6, "split on the stated X/R");

  const cmax = transformerSource({ kva: 1250, ukPct: 5, uSecV: 400, c: C_FACTOR.max });
  near(cmax.ik3 / t.ik3, 1.05, 1e-9, "cmax raises it by 5%");

  ok(transformerSource({ kva: 1250 }).miss, "an incomplete transformer is reported, not guessed");

  const g = gridSource({ skMva: 500, uV: 11000, c: 1 });
  near(g.ik3, 26243, 5, "a 500 MVA network at 11 kV is 26.2 kA");
}

/* ---------------------------------------------------------------
   The network
   --------------------------------------------------------------- */
console.log("\n--- cascading down the network ---");
{
  const net = defaultNetwork();
  net.nodes.push({ id: "db2", name: "Sub board", kind: "board", parent: "db1",
    cable: { size: 50, material: "copper", insulation: "xlpe", kTable: "a544",
             peSize: 25, peMaterial: "copper", lengthM: 60, parallel: 1,
             arrangement: "multicore", operatingC: 90 },
    device: { ratingA: 100, magneticMultiple: 10, clearingS: 0.1, backupS: 5, icuKa: 36 } });
  const s = solveNetwork(net);
  const a = s.nodes.get("db1"), b = s.nodes.get("db2");

  ok(a.ik3max > b.ik3max, "fault current falls as impedance accumulates");
  ok(b.ik3max < s.source.ik3max, "and every node is below the source");
  ok(a.ik1min < a.ik3max, "the earth-loop minimum is below the three-phase maximum");
  ok(b.rLoopMin > b.rMin, "the earth loop carries the PE resistance as well as the line");
  eq(b.depth, 2, "depth follows the tree");
  near(b.rMax, a.rMax + conductorR({ size: 50, material: "copper", lengthM: 60, tempC: 20 }), 1e-9,
       "the maximum-current path accumulates at 20 °C");
  near(b.rMin, a.rMin + conductorR({ size: 50, material: "copper", lengthM: 60, tempC: 90 }), 1e-9,
       "and the minimum-current path at the operating temperature");
  ok(b.rMin > b.rMax, "which is the larger resistance, and so the smaller current");

  /* A node hung off something that is not there must not quietly
     attach itself to the source. */
  net.nodes.push({ id: "lost", name: "Orphan", kind: "load", parent: "nope", cable: {}, device: {} });
  const s2 = solveNetwork(net);
  ok(s2.orphans.includes("lost"), "an unreachable node is listed as an orphan");
  ok(!s2.nodes.has("lost"), "and gets no fault figures");

  /* A ring is not a radial network and must not hang the solver. */
  const loop = { source: net.source, nodes: [
    { id: "x", parent: "y", cable: {}, device: {} },
    { id: "y", parent: "x", cable: {}, device: {} }] };
  const s3 = solveNetwork(loop);
  ok(s3.nodes.size === 0, "a loop resolves to nothing rather than recursing for ever");
}

console.log("\n--- a missing input is named, never defaulted ---");
{
  const net = { source: { kind: "tx", kva: 1250, ukPct: 5, uSecV: 400 },
    nodes: [{ id: "n", parent: null, cable: { material: "copper" }, device: {} }] };
  const s = solveNetwork(net);
  const m = s.nodes.get("n").miss;
  ok(m.some((x) => /line conductor size/.test(x)), "the line size is named");
  ok(m.some((x) => /run length/.test(x)), "the length is named");
  ok(m.some((x) => /protective conductor size/.test(x)), "the PE size is named");

  const s2 = solveNetwork({ source: { kind: "tx", kva: 1250 }, nodes: [] });
  ok(s2.source.miss, "an incomplete source is reported at the source");
}

/* ---------------------------------------------------------------
   The checks
   --------------------------------------------------------------- */
console.log("\n--- will the device clear it ---");
{
  const hit = deviceCheck({ device: { ratingA: 250, magneticMultiple: 10, clearingS: 0.1, backupS: 5 },
                            ik1min: 20000, ik3max: 30000 });
  eq(hit.trip, 2500, "the instantaneous threshold is rating × multiple");
  ok(hit.reaches, "20 kA clears a 2.5 kA threshold");
  eq(hit.t, 0.1, "so the instantaneous clearing time applies");

  const missIt = deviceCheck({ device: { ratingA: 250, magneticMultiple: 10, clearingS: 0.1, backupS: 5 },
                               ik1min: 1800, ik3max: 30000 });
  ok(!missIt.reaches, "1.8 kA does not");
  eq(missIt.t, 5, "so the thermal element's time applies instead");
  ok(/thermal element/.test(missIt.why), "and the reason is spelled out");
  ok(/larger protective conductor|shorter run/.test(missIt.why), "with the fix that actually works");

  const brk = deviceCheck({ device: { ratingA: 250, icuKa: 25 }, ik1min: 20000, ik3max: 30000 });
  ok(brk.breaking && !brk.breaking.pass, "a 25 kA device fails on a 30 kA fault");
  ok(deviceCheck({ device: { ratingA: 250, icuKa: 50 }, ik1min: 20000, ik3max: 30000 }).breaking.pass,
     "a 50 kA device passes");
  eq(deviceCheck({ device: {}, ik1min: 20000, ik3max: 30000 }).reaches, null,
     "no rating gives no verdict rather than a pass");
}

console.log("\n--- the adiabatic equation ---");
{
  /* The worked example: 36 kA for 0.1 s on aluminium XLPE, k = 94. */
  const a = adiabatic({ current: 36084.4, t: 0.1, k: 94, size: 185 });
  near(a.sMin, 121.4, 0.1, "36.08 kA for 0.1 s needs 121.4 mm²");
  ok(a.pass, "185 mm² survives it");
  eq(a.standard, 150, "the nearest standard size above the requirement");
  near(a.margin, 1.52, 0.01, "with half as much again in hand");
  near(a.tWithstand, 0.232, 0.002, "185 mm² would hold that current for 0.232 s");

  const f = adiabatic({ current: 36084.4, t: 0.1, k: 94, size: 95 });
  ok(!f.pass, "95 mm² does not survive it");

  /* Doubling the time needs √2 times the area, and parallel
     conductors share the current. */
  const t2 = adiabatic({ current: 36084.4, t: 0.2, k: 94, size: 185 });
  near(t2.sMinRaw / a.sMinRaw, Math.SQRT2, 1e-9, "four times the energy is √2 times the area");
  const p2 = adiabatic({ current: 36084.4, t: 0.1, k: 94, size: 185, parallel: 2 });
  near(p2.sMinRaw, a.sMinRaw / 2, 1e-9, "two conductors each carry half the fault");
  ok(adiabatic({ current: 1000, t: 0.1, k: null, size: 50 }).miss, "no k gives no answer");
}

console.log("\n--- the whole check on one cable ---");
{
  const net = defaultNetwork();
  const s = solveNetwork(net);
  const c = checkCable({ node: net.nodes[0], solved: s, source: s.source });

  eq(c.lineK.k, 94, "k comes off Table A.54.4 for an aluminium XLPE core");
  eq(c.table.standard, 95, "Table 54.2 wants 95 mm² of protective conductor");
  eq(c.governedBy, "table", "which governs here, over the adiabatic figure");
  ok(c.peOk, "and 95 mm² is what is installed");
  ok(c.line.pass, "the 185 mm² line conductor survives the fault");
  ok(c.lineConservative.sMin > c.line.sMin,
     "the source fault level is the more onerous basis, and is shown alongside");

  /* A long thin final circuit. The interesting part is that the two
     failures are independent: the run is long enough that the device
     never sees instantaneous current, yet the same impedance holds
     the fault current low enough that the conductor is in no thermal
     danger at all. A tool that only ran the adiabatic check would
     pass this circuit, and it would not disconnect. */
  const far = { source: net.source, nodes: [{ id: "f", parent: null, kind: "load",
    cable: { size: 16, material: "copper", insulation: "xlpe", kTable: "a544",
             peSize: 16, peMaterial: "copper", lengthM: 400, parallel: 1,
             arrangement: "multicore", operatingC: 90 },
    device: { ratingA: 63, magneticMultiple: 10, clearingS: 0.1, backupS: 5, icuKa: 25 } }] };
  const sf = solveNetwork(far);
  const cf = checkCable({ node: far.nodes[0], solved: sf, source: sf.source });
  ok(!cf.dev.reaches, "400 m of 16 mm² does not pass enough earth-fault current to trip it");
  eq(cf.dev.t, 5, "so the check runs on the thermal element's time");
  ok(cf.rec.ik1min < 400, "the earth-fault current is a few hundred amps, not thousands");
  ok(cf.line.pass, "the conductor is in no thermal danger — the impedance that stops it "
     + "tripping is the same impedance that limits the current");
  eq(cf.governedBy, "table", "and Table 54.2 still governs the protective conductor");

  /* Where the adiabatic figure does govern: a small line conductor
     close to a large transformer. Table 54.2 wants 16 mm² of earth on
     a 35 mm² line, and 20 kA for 100 ms needs nearer 45. This is the
     case 543.1.2 exists for, and the reason the tool takes the larger
     of the two rather than offering a choice. */
  const stiff = { source: { kind: "tx", kva: 2000, ukPct: 6, uSecV: 400, u0V: 230, xOverR: 12 },
    nodes: [{ id: "s", parent: null, kind: "load",
      cable: { size: 35, material: "copper", insulation: "xlpe", kTable: "a544",
               peSize: 16, peMaterial: "copper", lengthM: 5, parallel: 1,
               arrangement: "multicore", operatingC: 90 },
      device: { ratingA: 125, magneticMultiple: 10, clearingS: 0.1, backupS: 5, icuKa: 50 } }] };
  const ss = solveNetwork(stiff);
  const cs = checkCable({ node: stiff.nodes[0], solved: ss, source: ss.source });
  ok(cs.dev.reaches, "this one does trip instantaneously");
  eq(cs.table.standard, 16, "Table 54.2 is satisfied by 16 mm²");
  ok(cs.pe.sMin > 16, "but the adiabatic check needs more than that");
  eq(cs.governedBy, "adiabatic", "so the adiabatic figure governs");
  ok(!cs.peOk, "and the installed 16 mm² earth is reported as too small");
  ok(cs.peStandard > 16, "with a standard size named to replace it");
}

console.log("\n--- the arrangement and the reactance ---");
{
  ok(X_PER_M.flat > X_PER_M.trefoil && X_PER_M.trefoil > X_PER_M.multicore,
     "spacing the conductors out raises the reactance");
  const mk = (arr) => {
    const n = { source: { kind: "tx", kva: 1250, ukPct: 5, uSecV: 400, u0V: 230 },
      nodes: [{ id: "a", parent: null, cable: { size: 240, material: "copper", insulation: "xlpe",
        peSize: 120, peMaterial: "copper", lengthM: 200, arrangement: arr, operatingC: 90 },
        device: {} }] };
    return solveNetwork(n).nodes.get("a").ik3max;
  };
  ok(mk("flat") < mk("multicore"), "and so lowers the fault current a little");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
