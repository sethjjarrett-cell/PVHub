/* Tests for the PVsyst batch analyser. Node only, no dependencies:
   node tests/batchAnalyser.test.mjs                                    */
import { readFileSync } from 'fs';
import { parseBatchCsv, analyseBatch, buildRecommendation, toCsv } from '../src/batchAnalyser.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('!! FAIL', name, extra); }
};
const near = (a, b, tol) => a !== null && Math.abs(a - b) <= tol;
const fx = (n) => readFileSync(new URL('./fixtures/' + n, import.meta.url));

console.log('=== Solango fixture, spec defaults ===');
const raw = fx('Solango_Project_BatchResults_0.CSV');
const parsed = parseBatchCsv(raw);
const a = analyseBatch(parsed);

ok('decoded as Windows-1252', parsed.encoding === 'Windows-1252', parsed.encoding);
ok('delimiter is semicolon', parsed.delimiter === ';');
ok('decimal separator is a full stop', parsed.decimalComma === false);
ok('35 valid rows', parsed.rows.length === 35, String(parsed.rows.length));
ok('tilts 15,17,18,19,20,21,22', a.tilts.join() === '15,17,18,19,20,21,22', a.tilts.join());
ok('pitches 10,10.5,11,11.5,12', a.pitches.join() === '10,10.5,11,11.5,12', a.pitches.join());
ok('16 degrees detected as missing', a.tiltGaps.missing.join() === '16', a.tiltGaps.missing.join());
ok('no pitch gaps', a.pitchGaps.missing.length === 0);

console.log('--- metadata ---');
ok('project name', parsed.meta.project === 'Solango_Project.PRJ', parsed.meta.project);
ok('base variant VC5', parsed.meta.baseVariant === 'VC5', parsed.meta.baseVariant);
ok('variant description', parsed.meta.variantDescription === 'DC:AC Investigation', parsed.meta.variantDescription);
ok('modified date', parsed.meta.modified === '24/09/26 12:03', parsed.meta.modified);

console.log('--- optional outputs present ---');
ok('ShdLoss, IL_Pmax, PR picked up',
  ['ShdLoss','IL_Pmax','PR','E_Grid'].every(k => k in parsed.rows[0].outputs),
  Object.keys(parsed.rows[0].outputs).join());
ok('E_Grid normalised GWh to MWh', near(parsed.rows[0].eGridMwh, 17570, 0.5), String(parsed.rows[0].eGridMwh));

console.log('--- global max and ties ---');
ok('global max 18.04 GWh at 20 deg, 12 m',
  a.globalMax.tilt === 20 && a.globalMax.pitch === 12 && near(a.globalMax.eGridMwh, 18040, 0.5),
  `${a.globalMax.tilt}/${a.globalMax.pitch}/${a.globalMax.eGridMwh}`);
// derived from the tolerance maths, not from the spec's list
const tolMwh = 0.002 * 18040;
const expectTies = a.cells.filter(c => 18040 - c.eGridMwh <= tolMwh)
  .map(c => `${c.tilt}/${c.pitch}`).sort();
ok('tie set matches the tolerance maths exactly',
  a.ties.map(c => `${c.tilt}/${c.pitch}`).sort().join() === expectTies.join(),
  a.ties.map(c => `${c.tilt}/${c.pitch}`).join());
ok('ties are 20/12 and 19/12', a.ties.map(c => `${c.tilt}/${c.pitch}`).sort().join() === '19/12,20/12',
  a.ties.map(c => `${c.tilt}/${c.pitch}`).join());

console.log('--- best tilt per pitch ---');
const bt = Object.fromEntries(a.bestTiltPerPitch.map(b => [b.pitch, b.tilt]));
ok('10 -> 15', bt[10] === 15, String(bt[10]));
ok('10.5 -> 17', bt[10.5] === 17, String(bt[10.5]));
ok('11 -> 15', bt[11] === 15, String(bt[11]));
ok('11.5 -> 18', bt[11.5] === 18, String(bt[11.5]));
ok('12 -> 20', bt[12] === 20, String(bt[12]));

console.log('--- edge of range ---');
ok('pitch edge flagged at the upper end', a.edge.pitchAtMax === 'upper', String(a.edge.pitchAtMax));
ok('suggests three further pitches at the same step',
  a.edge.suggestPitch.join() === '12.5,13,13.5', a.edge.suggestPitch.join());
ok('tilt is not at an edge', a.edge.tiltAtMax === null, String(a.edge.tiltAtMax));

console.log('--- preferred tilt 15 deg ---');
const ps = Object.fromEntries(a.preferredSeries.map(s => [s.pitch, s.penaltyVsMaxPct]));
ok('12 m penalty about 0.55%', near(ps[12], 0.554, 0.01), String(ps[12]));
ok('11.5 m penalty about 0.94%', near(ps[11.5], 0.942, 0.01), String(ps[11.5]));
ok('11 m penalty about 1.11%', near(ps[11], 1.109, 0.01), String(ps[11]));
ok('recommended pitch is 11.5 m at a 1.0% threshold', a.recommended?.pitch === 11.5, String(a.recommended?.pitch));
ok('preferred tilt was simulated exactly', a.preferredExact === true);
ok('penalty vs best tilt at 11.5 m is reported', a.preferredSeries.find(s => s.pitch === 11.5).penaltyVsBestHerePct > 0);

console.log('--- did not change ---');
const dnc = parsed.rows.filter(r => r.didNotChange).map(r => r.ident);
ok('SIM_29 to SIM_35 kept and flagged',
  dnc.join() === 'SIM_29,SIM_30,SIM_31,SIM_32,SIM_33,SIM_34,SIM_35', dnc.join());
ok('a did-not-change warning is raised', parsed.warnings.some(w => /did not change/i.test(w)));

console.log('--- marginal gain ---');
const em = a.envelopeMarginal.find(m => m.pitch === 12);
ok('envelope marginal gain per metre computed at 12 m', em.perMetreMwh !== null, String(em.perMetreMwh));
ok('first pitch has no marginal gain', a.envelopeMarginal[0].perMetreMwh === null);

console.log('--- GCR ---');
const g = analyseBatch(parsed, { collectorWidthM: 4.6 }).geometry;
ok('GCR at 10 m is 0.46', near(g.byPitch.find(x => x.pitch === 10).gcr, 0.46, 1e-9));
ok('clear gap at 15 deg, 10 m', near(g.clearGap(15, 10), 10 - 4.6 * Math.cos(15 * Math.PI / 180), 1e-9));
ok('no geometry without a width', analyseBatch(parsed).geometry === null);

console.log('--- recommendation text ---');
const rec = buildRecommendation(a, parsed);
ok('names the optimum', /20° at 12 m/.test(rec.find(l => l.kind === 'optimal').text));
ok('names the recommended pitch', /11\.5 m/.test(rec.find(l => l.kind === 'recommend').text));
ok('raises the edge-of-range warning', rec.some(l => l.kind === 'edge' && /not bracketed/.test(l.text)));
ok('reports the 16 degree gap', rec.some(l => l.kind === 'gap' && /16°/.test(l.text)));
ok('carries the cost caveat', rec.some(l => l.kind === 'caveat' && /costs are in/.test(l.text)));
ok('no em dashes in the generated copy', !rec.some(l => /—/.test(l.text)));
ok('CSV export contains the grid', /E_Grid grid/.test(toCsv(a, parsed)));

console.log('\n=== edge cases ===');
const base = readFileSync(new URL('./fixtures/Solango_Project_BatchResults_0.CSV', import.meta.url), 'latin1');

// 1. cp1252 round trip is already covered above; assert the degree sign survived
ok('cp1252 superscript two decoded', parseBatchCsv(raw).columns.some(c => /kWh\/m²/.test(c.unit || c.sub)));

// 2. decimal comma
const comma = base.replace(/;(\d+)\.(\d+)/g, ';$1,$2');
const pc = parseBatchCsv(Buffer.from(comma, 'latin1'));
ok('decimal comma detected', pc.decimalComma === true);
const ac = analyseBatch(pc);
ok('decimal comma gives the same optimum',
  ac.globalMax.tilt === 20 && ac.globalMax.pitch === 12 && near(ac.globalMax.eGridMwh, 18040, 0.5),
  `${ac.globalMax.tilt}/${ac.globalMax.pitch}/${ac.globalMax.eGridMwh}`);

// 3. an extra swept parameter
const extra = base
  .replace('Ident;Plane;Sheds 3D;Simul', 'Ident;Plane;Sheds 3D;Orientation;Simul')
  .replace(';tilt;pitch;Comment', ';tilt;pitch;azimuth;Comment')
  .replace(';[deg];[m];;', ';[deg];[m];[deg];')
  .replace(/^(SIM_\d+;[\d.]+;[\d.]+);/gm, '$1;0;');
const pe = parseBatchCsv(Buffer.from(extra, 'latin1'));
ok('extra swept parameter kept', pe.extraSwept.length === 1 && pe.extraSwept[0].sub === 'azimuth',
  JSON.stringify(pe.extraSwept.map(c => c.sub)));
ok('extra swept parameter warned about', pe.warnings.some(w => /azimuth/.test(w)));
ok('tilt and pitch still found', !!pe.tiltCol && !!pe.pitchCol);
ok('extra parameter value read onto the row', pe.rows[0].extras.azimuth === 0);

// 4. missing E_Grid
const noEgrid = base.replace(';PR;E_Grid', ';PR').replace(';ratio;GWh', ';ratio')
  .replace(/;([\d.]+);([\d.]+)$/gm, ';$1');
let msg = '';
try { parseBatchCsv(Buffer.from(noEgrid, 'latin1')); } catch (e) { msg = e.message; }
ok('missing E_Grid fails with a clear message', /E_Grid/.test(msg) && /batch output variables/.test(msg), msg);

// 5. an Error row
const withError = base.replace(
  'SIM_5;20;10;DC:AC Investigation;Info: parameter Pitch NS was set;47.41;0.256;0.8608;17.34',
  'SIM_5;20;10;DC:AC Investigation;Error: simulation did not converge;;;;');
const perr = parseBatchCsv(Buffer.from(withError, 'latin1'));
ok('error row excluded', perr.rows.length === 34 && perr.excluded.length === 1, `${perr.rows.length}/${perr.excluded.length}`);
ok('error row listed with its reason', /did not converge/.test(perr.excluded[0].reason));
ok('excluded row reaches the recommendation',
  buildRecommendation(analyseBatch(perr), perr).some(l => l.kind === 'excluded' && /SIM_5/.test(l.text)));

// 6. no header at all
let msg2 = '';
try { parseBatchCsv(Buffer.from('nothing;useful;here\n1;2;3', 'latin1')); } catch (e) { msg2 = e.message; }
ok('a file with no Ident header fails clearly', /Ident/.test(msg2), msg2);

// 7. duplicate tilt and pitch
const dup = base.replace(/(\r?\n);;;;;;;;\s*$/, '$1SIM_36;15;10;DC:AC Investigation;Info: rerun;23.87;0.241;0.8853;17.60\r\n');
const pd = parseBatchCsv(Buffer.from(dup, 'latin1'));
ok('duplicate detected and the later row kept',
  pd.duplicates.length === 1 && pd.duplicates[0].kept === 'SIM_36', JSON.stringify(pd.duplicates));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
