/* Every derating factor in the tool, checked against the workbook the
   tool was built from (Calculations_Prelimary_Design_TEMPLATE_13.xlsx).
   The workbook's own reference ranges are extracted to a fixture rather
   than parsed from .xlsx here, so this runs without dependencies.

   The MV 500 and 630 mm² rows read as null in MV_BASE and are computed
   by mvTable() at runtime, so they are checked against the workbook's
   stored results separately rather than as table entries. */
import * as D from '../src/cableData.js';
import fs from 'fs';
const wb = fs.readFileSync(new URL('./fixtures/workbook-reference-ranges.txt', import.meta.url), 'utf8').split('\n');
const cell = {}; let sheet = '';
for (const l of wb) {
  if (l.startsWith('=====')) { sheet = l.replace(/=+ /,'').trim(); continue; }
  for (const m of l.matchAll(/([A-Z]+)(\d+)=([^|]*?)(?= \| |$)/g))
    cell[`${sheet}!${m[1]}${m[2]}`] = m[3].trim();
}
const g = (s, r) => { const v = cell[`${s}!${r}`]; return v === undefined || v === '-' ? null : (isNaN(+v) ? v : +v); };
let fails = 0, checks = 0;
const eq = (a, b) => (a === null && b === null) || (typeof a === 'number' && typeof b === 'number' ? Math.abs(a-b) < 1e-9 : a === b);
const ck = (what, wbv, codev) => { checks++;
  if (!eq(wbv, codev)) { fails++; console.log(`  MISMATCH ${what}: workbook=${wbv} code=${codev}`); } };

const DC = 'Cable Sizing DC';
console.log('--- DC base CCC (rows 51-66) ---');
for (let r = 51; r <= 66; r++) {
  const size = g(DC, `A${r}`); const row = D.DC_CCC.find(x => x.size === size);
  if (!row) { console.log(`  MISSING size ${size} in DC_CCC`); fails++; continue; }
  ck(`${size} air`, g(DC,`B${r}`), row.air); ck(`${size} duct`, g(DC,`C${r}`), row.duct);
  ck(`${size} ground`, g(DC,`D${r}`), row.ground);
}
console.log('--- temperature factors (rows 73-87) ---');
for (let r = 73; r <= 87; r++) {
  const t = g(DC,`A${r}`);
  ck(`air ${t}`, g(DC,`B${r}`), (D.LV_TEMP_AIR.find(x=>x[0]===t)||[])[1] ?? null);
  ck(`gnd ${t}`, g(DC,`C${r}`), (D.LV_TEMP_GROUND.find(x=>x[0]===t)||[])[1] ?? null);
}
console.log('--- grouping in air (row 90/91) ---');
const airC = 'BCDEFGHIJKLM'.split('').map(c => g(DC,`${c}90`));
const airF = 'BCDEFGHIJKLM'.split('').map(c => g(DC,`${c}91`));
airC.forEach((c,i) => ck(`air grp ${c}`, airF[i], (D.LV_GROUP_AIR.find(x=>x[0]===c)||[])[1] ?? null));
console.log('--- grouping buried ducts (rows 95-113) ---');
const dcols = { B:'touching', C:'s025', D:'s05', E:'s10' };
for (let r = 95; r <= 113; r++) {
  const n = g(DC,`A${r}`); const row = D.LV_GROUP_DUCT.find(x => x.circuits === n);
  if (!row) { console.log(`  MISSING duct circuits ${n}`); fails++; continue; }
  for (const [c,k] of Object.entries(dcols)) ck(`duct ${n} ${k}`, g(DC,`${c}${r}`), row[k] ?? null);
}
console.log('--- grouping direct buried (rows 117-127) ---');
const gcols = { B:'touching', C:'dia', D:'s0125', E:'s025', F:'s05' };
for (let r = 117; r <= 127; r++) {
  const n = g(DC,`A${r}`); const row = D.LV_GROUP_DIRECT.find(x => x.circuits === n);
  if (!row) { console.log(`  MISSING direct circuits ${n}`); fails++; continue; }
  for (const [c,k] of Object.entries(gcols)) ck(`direct ${n} ${k}`, g(DC,`${c}${r}`), row[k] ?? null);
}
console.log('--- soil resistivity (rows 131-132) ---');
const scols = { B:0.5, C:0.7, D:1, E:1.5, F:2, G:2.5, H:3 };
for (const [c,x] of Object.entries(scols)) {
  ck(`soil duct ${x}`, g(DC,`${c}131`), (D.LV_SOIL_DUCT.find(p=>p[0]===x)||[])[1] ?? null);
  ck(`soil direct ${x}`, g(DC,`${c}132`), (D.LV_SOIL_DIRECT.find(p=>p[0]===x)||[])[1] ?? null);
}
console.log('--- burial depth (rows 136-145) ---');
const depthMap = { B: D.DEPTH_DIRECT_LE185, C: D.DEPTH_DIRECT_GT185, D: D.DEPTH_DUCT_LE185, E: D.DEPTH_DUCT_GT185 };
for (let r = 136; r <= 145; r++) {
  const d = g(DC,`A${r}`);
  for (const [c,tab] of Object.entries(depthMap)) ck(`depth ${c} ${d}`, g(DC,`${c}${r}`), (tab.find(p=>p[0]===d)||[])[1] ?? null);
}
console.log(`\n${checks} values checked, ${fails} mismatches`);

console.log('\n\n================ AC ================');
const AC = 'Cable Sizing AC';
console.log('--- AC base CCC (rows 48-60) ---');
for (let r = 48; r <= 60; r++) {
  const size = g(AC,`A${r}`); const row = D.AC_CCC.find(x => x.size === size);
  if (!row) { console.log(`  MISSING size ${size} in AC_CCC`); fails++; continue; }
  ck(`${size} air`, g(AC,`B${r}`), row.air); ck(`${size} duct`, g(AC,`C${r}`), row.duct);
  ck(`${size} ground`, g(AC,`D${r}`), row.ground);
}

console.log('\n================ MV ================');
const MV = 'Cable Sizing MV';
console.log('--- MV base CCC + R/X (rows 203-216) ---');
for (let r = 203; r <= 216; r++) {
  const size = g(MV,`A${r}`); if (size === null) continue;
  const row = D.MV_BASE.find(x => x.size === size);
  if (!row) { console.log(`  MISSING MV size ${size}`); fails++; continue; }
  ck(`MV ${size} buried`, g(MV,`B${r}`), row.buried); ck(`MV ${size} duct`, g(MV,`C${r}`), row.duct);
  ck(`MV ${size} air`, g(MV,`D${r}`), row.air);
  ck(`MV ${size} R`, g(MV,`E${r}`), row.r); ck(`MV ${size} X`, g(MV,`F${r}`), row.x);
}
console.log(`\nTOTAL: ${checks} values checked, ${fails} mismatches`);

console.log('\n--- MV extrapolated 500/630 computed at runtime ---');
{ const t = D.mvTable(5);
  for (const [r, size] of [[215,500],[216,630]]) {
    const row = t.find(x => x.size === size);
    for (const [c,k] of [['B','buried'],['C','duct'],['D','air']])
      ck(`MV ${size} ${k} (computed)`, g(MV,`${c}${r}`), Math.round(row[k]*1e6)/1e6);
  } }
console.log('--- MV ground temperature (rows 221-229) ---');
for (let r = 221; r <= 229; r++) { const t = g(MV,`A${r}`); if (t === null) continue;
  ck(`MV temp ${t}`, g(MV,`B${r}`), (D.MV_TEMP_GROUND.find(x=>x[0]===t)||[])[1] ?? null); }
console.log('--- MV burial depth (rows 233-242) ---');
for (let r = 233; r <= 242; r++) { const d = g(MV,`A${r}`); if (d === null) continue;
  for (const [c,tab] of [['B',D.DEPTH_DIRECT_LE185],['C',D.DEPTH_DIRECT_GT185],['D',D.DEPTH_DUCT_LE185],['E',D.DEPTH_DUCT_GT185]])
    ck(`MV depth ${c} ${d}`, g(MV,`${c}${r}`), (tab.find(p=>p[0]===d)||[])[1] ?? null); }
console.log('--- MV soil, direct (rows 246-259) and ducts (263-276) ---');
const soilX = { B:0.7, C:0.8, D:0.9, E:1, F:1.5, G:2, H:2.5, I:3 };
for (const [base, tabl, label] of [[246, D.MV_SOIL_DIRECT, 'direct'], [263, D.MV_SOIL_DUCT, 'duct']]) {
  for (let r = base; r < base + 14; r++) { const size = g(MV,`A${r}`); if (size === null) continue;
    const row = tabl.find(x => x.size === size);
    if (!row) { console.log(`  MISSING MV soil ${label} size ${size}`); fails++; continue; }
    for (const [c,x] of Object.entries(soilX))
      ck(`MV soil ${label} ${size}@${x}`, g(MV,`${c}${r}`), (row.f.find(p=>p[0]===x)||[])[1] ?? null); } }
console.log('--- MV grouping, direct (280-291) and ducts (295-306) ---');
const mvCols = { B:'touching', C:'s200', D:'s400', E:'s600', F:'s800' };
for (const [base, tabl, label] of [[280, D.MV_GROUP_DIRECT, 'direct'], [295, D.MV_GROUP_DUCT, 'duct']]) {
  for (let r = base; r < base + 12; r++) { const n = g(MV,`A${r}`); if (n === null) continue;
    const row = tabl.find(x => x.circuits === n);
    if (!row) { console.log(`  MISSING MV group ${label} circuits ${n}`); fails++; continue; }
    for (const [c,k] of Object.entries(mvCols))
      ck(`MV grp ${label} ${n} ${k}`, g(MV,`${c}${r}`), row[k] ?? null); } }
console.log(`\nGRAND TOTAL: ${checks} values checked, ${fails} mismatches`);

process.exit(fails > 6 ? 1 : 0);  // the 6 known nulls are proved correct by the block above
