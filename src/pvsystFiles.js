/* =====================================================================
   PVsyst component files — .PAN (module) and .OND (inverter)

   These are the best input this tool can be given. A datasheet PDF has to
   be scraped: the labels vary by manufacturer, the numbers sit in a table
   whose structure is implied by position, and multi-bin sheets need a
   column picked. A PAN file is the same manufacturer's data already
   parsed, named and typed — the file PVsyst itself runs on. Where one
   exists, nothing else should be used.

   The format is a plain-text tree of `Key=Value` lines, nested in
   `PVObject_X=...` / `End of PVObject X` blocks and indented by depth.
   It is not quite INI and not quite YAML, so it gets its own small
   reader below rather than a dependency.

   Two things need care.

   Temperature coefficients are stored in absolute units — muISC in
   mA/°C, muVocSpec in mV/°C — while PVhub and every datasheet front page
   work in %/°C. The conversion needs Isc and Voc from the same file, so
   it is done here and flagged as derived rather than read.

   The MPPT voltage range in an OND is the *tracking* range. PVhub
   deliberately sizes strings on the full-power lower bound from the P-V
   curve instead, because the tracking bound is wider and using it
   over-states how few modules a string can have. So VMppMin is mapped to
   the tracking bound and the full-power bound is left for the user to
   enter, with the reason stated.
   ===================================================================== */

/**
 * Parse the indented Key=Value tree into nested plain objects.
 * Repeated keys keep the first, which is what the format implies.
 * Every leaf keeps the source line so the UI can show provenance.
 */
export function parsePvsystTree(text) {
  const root = {};
  // Each frame records what opened it, so a closing line only pops the
  // block it actually names. `Remarks, Count=7` opens a block that ends
  // with `End of Remarks`; treating that end line as a generic pop closed
  // the enclosing pvCommercial early and dumped the whole electrical
  // section onto the root, where the module lookup could not see it.
  const stack = [{ node: root, kind: "__root__" }];
  // A leading byte-order mark would otherwise become part of the first key.
  // The second form is a UTF-8 BOM that has been decoded as Latin-1, which
  // happens when a file is read with the wrong encoding somewhere upstream.
  for (const raw of String(text).replace(/^(\uFEFF|\u00EF\u00BB\u00BF)/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const end = line.match(/^End of\s+(\S+)/i);
    if (end) {
      const top = stack[stack.length - 1];
      if (stack.length > 1 && top.kind.toLowerCase() === end[1].toLowerCase()) stack.pop();
      continue;
    }

    // Counted free-text block: `Remarks, Count=7`.
    if (/^Remarks\b/i.test(line)) {
      const node = { __line: line };
      stack[stack.length - 1].node.Remarks = node;
      stack.push({ node, kind: "Remarks" });
      continue;
    }

    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();

    // A block header opens a child: `PVObject_Commercial=pvCommercial`,
    // `Converter=TConverter`, `IAMProfile=TCubicProfile`. The closing line
    // names the opener's family, not the key, so record that.
    if (/^PVObject_/i.test(key) && /^pv[A-Za-z]/.test(val)) {
      const name = key.replace(/^PVObject_?/i, "") || val;
      const node = { __type: val, __line: line };
      const top = stack[stack.length - 1].node;
      if (!(name in top)) top[name] = node;
      stack.push({ node, kind: "PVObject" });
      continue;
    }
    if (/^T[A-Za-z]/.test(val) && /^(Converter|IAMProfile|Profil\w*)$/i.test(key)) {
      const node = { __type: val, __line: line };
      const top = stack[stack.length - 1].node;
      if (!(key in top)) top[key] = node;
      stack.push({ node, kind: val });   // e.g. `End of TConverter`
      continue;
    }

    const top = stack[stack.length - 1].node;
    if (!(key in top)) top[key] = { value: val, line };
  }
  return root;
}

/** Read a numeric leaf from any of several candidate keys. */
function num(node, ...keys) {
  for (const k of keys) {
    const leaf = node?.[k];
    if (!leaf || typeof leaf.value !== "string") continue;
    // PVsyst writes plain decimals, but be tolerant of a stray comma.
    const v = Number(leaf.value.replace(",", "."));
    if (Number.isFinite(v)) return { v, line: leaf.line };
  }
  return null;
}
function str(node, ...keys) {
  for (const k of keys) {
    const leaf = node?.[k];
    if (leaf && typeof leaf.value === "string" && leaf.value) return leaf.value;
  }
  return null;
}

/** A field in the shape DatasheetPanel already renders. Converted values
    are rounded to the precision a datasheet would quote them at — six
    decimal places of a derived coefficient is false precision. */
const field = (v, line, conf = "high", note, dp = 6) => ({
  vals: [Number(v.toFixed(dp))], line, pick: 0, conf, ...(note ? { note } : {}),
});

/* ---------------------------------------------------------------
   .PAN — photovoltaic module
   --------------------------------------------------------------- */
export function parsePan(text) {
  const tree = parsePvsystTree(text);
  const m = tree.pvModule;
  if (!m) throw new Error("no pvModule block in that file");
  const com = m.Commercial || {};
  const out = {};

  const pnom = num(m, "PNom", "PNomDC");
  const voc = num(m, "Voc");
  const vmp = num(m, "Vmp");
  const isc = num(m, "Isc");
  const imp = num(m, "Imp");

  if (pnom) out.pmax = field(pnom.v, pnom.line);
  if (voc) out.voc = field(voc.v, voc.line);
  if (vmp) out.vmp = field(vmp.v, vmp.line);
  if (isc) out.isc = field(isc.v, isc.line);
  if (imp) out.imp = field(imp.v, imp.line);

  // Physical envelope lives in the Commercial block. PVhub's "length" is
  // the long side whichever way round the file states it.
  const w = num(com, "Width"), h = num(com, "Height");
  if (w && h) {
    out.length = field(Math.max(w.v, h.v), `${w.line} / ${h.line}`);
    out.width = field(Math.min(w.v, h.v), `${w.line} / ${h.line}`);
  }

  const vmax = num(m, "VMaxIEC", "VMaxUL");
  if (vmax) out.vSysMax = field(vmax.v, vmax.line);

  // γ Pmax is already %/°C in the file.
  const gp = num(m, "muPmpReq", "muPmp");
  if (gp) out.gPmax = field(gp.v, gp.line);

  // α Isc is mA/°C, β Voc is mV/°C. Both need the STC value from the
  // same file to become the %/°C the rest of the tool works in, so both
  // are derived rather than read and say so.
  const aisc = num(m, "muISC", "muIsc");
  if (aisc && isc && isc.v > 0) {
    out.aIsc = field((aisc.v / 1000 / isc.v) * 100, aisc.line, "medium",
      `converted: ${aisc.v} mA/°C ÷ ${isc.v} A → %/°C`, 4);
  }
  const bvoc = num(m, "muVocSpec", "muVoc");
  if (bvoc && voc && voc.v > 0) {
    out.bVoc = field((bvoc.v / 1000 / voc.v) * 100, bvoc.line, "medium",
      `converted: ${bvoc.v} mV/°C ÷ ${voc.v} V → %/°C`, 4);
  }

  const ncels = num(m, "NCelS");
  if (ncels) {
    out.cells = field(ncels.v, ncels.line, "high",
      num(m, "NCelP")?.v > 1
        ? "cells in series; the file also reports parallel half-cell strings, which do not change the series count"
        : undefined);
  }
  const gamma = num(m, "Gamma");
  if (gamma) out.ideality = field(gamma.v, gamma.line);

  const bif = num(m, "BifacialityFactor");
  if (bif) out.bifaciality = field(bif.v, bif.line);

  const meta = {
    kind: "module",
    manufacturer: str(com, "Manufacturer"),
    model: str(com, "Model"),
    dataSource: str(com, "DataSource"),
    version: str(m, "Version"),
    technology: str(m, "Technol"),
    gRef: num(m, "GRef")?.v ?? null,
    tRef: num(m, "TRef")?.v ?? null,
    tolLow: num(m, "PNomTolLow")?.v ?? null,
    tolUp: num(m, "PNomTolUp")?.v ?? null,
  };
  return { fields: out, meta };
}

/* ---------------------------------------------------------------
   .OND — grid inverter
   --------------------------------------------------------------- */
export function parseOnd(text) {
  const tree = parsePvsystTree(text);
  const inv = tree.pvGInverter;
  if (!inv) throw new Error("no pvGInverter block in that file");
  const com = inv.Commercial || {};
  // Most of the electrical data sits in the Converter sub-object, but
  // some files hoist parts of it; look in both.
  const cv = inv.Converter || inv;
  const at = (...keys) => num(cv, ...keys) || num(inv, ...keys);
  const out = {};

  const vabs = at("VAbsMax", "VMaxAbs");
  if (vabs) out.vMax = field(vabs.v, vabs.line);

  // The tracking window. PVhub sizes strings on the full-power lower
  // bound instead, which an OND does not state, so the lower bound is
  // offered as the tracking figure and the difference is spelled out.
  const vmppMin = at("VMppMin", "VMPPMin");
  if (vmppMin) {
    out.trackLo = field(vmppMin.v, vmppMin.line);
    out.fpLo = field(vmppMin.v, vmppMin.line, "low",
      "this is the MPPT tracking lower bound, not the full-power bound — read the full-power knee off the P-V curve and overwrite it");
  }
  const vmppMax = at("VMPPMax", "VMppMax");
  if (vmppMax) {
    out.fpHi = field(vmppMax.v, vmppMax.line, "medium",
      "upper end of the tracking window; full power is normally available here, but confirm against the P-V curve");
  }
  const vstart = at("VStart", "VThreshold");
  if (vstart) out.vStart = field(vstart.v, vstart.line);

  const nmppt = at("NbMPPT", "NbMPPTs");
  if (nmppt) out.nMppt = field(nmppt.v, nmppt.line);

  // Per-MPPT current is only taken when the file states it. Dividing a
  // total by the MPPT count is not the same number and is not worth
  // guessing at.
  const impptDirect = at("IMaxPerMPPT", "IMaxDCPerMPPT");
  if (impptDirect) out.iMppt = field(impptDirect.v, impptDirect.line);

  const ninputs = at("NbInputs");
  if (ninputs && nmppt && nmppt.v > 0) {
    out.connMax = field(Math.floor(ninputs.v / nmppt.v), ninputs.line, "medium",
      `derived: ${ninputs.v} DC inputs ÷ ${nmppt.v} MPPTs`);
  }

  // PNomConv is kW. PVhub asks for kVA, which is the same figure only at
  // unity power factor; PMaxOUT, where present, is the apparent-power
  // rating and is the better match.
  const pmaxOut = at("PMaxOUT", "PMaxOut");
  const pnom = at("PNomConv", "PNomDC", "PNom");
  if (pmaxOut) {
    out.acKva = field(pmaxOut.v, pmaxOut.line, "medium",
      "from PMaxOUT — check whether the file states it in kW or kVA");
  } else if (pnom) {
    out.acKva = field(pnom.v, pnom.line, "medium",
      "from PNomConv, which is kW — equal to kVA only at unity power factor");
  }

  const vout = at("VOutConv", "VNomAC", "VOut");
  if (vout) out.vAc = field(vout.v, vout.line);

  const meta = {
    kind: "inverter",
    manufacturer: str(com, "Manufacturer"),
    model: str(com, "Model"),
    dataSource: str(com, "DataSource"),
    version: str(inv, "Version"),
    effMax: at("EfficMax")?.v ?? null,
    effEuro: at("EfficEuro")?.v ?? null,
    phases: str(inv, "MonoTri") || str(cv, "MonoTri"),
  };
  return { fields: out, meta };
}

/**
 * Read either kind, deciding from the file's own declared object rather
 * than from its extension — people rename these.
 */
export function parsePvsystFile(text, expectKind) {
  const head = String(text).slice(0, 4000);
  if (!/PVObject_\s*=/.test(head)) {
    throw new Error("this is not a PVsyst component file — no PVObject header");
  }
  const isModule = /PVObject_\s*=\s*pvModule/i.test(head);
  const isInverter = /PVObject_\s*=\s*pvGInverter/i.test(head);
  if (!isModule && !isInverter) throw new Error("unrecognised PVsyst object type");
  const got = isModule ? "module" : "inverter";
  if (expectKind && got !== expectKind) {
    throw new Error(
      got === "module"
        ? "that is a .PAN module file — load it on the Module tab"
        : "that is a .OND inverter file — load it on the Inverter tab",
    );
  }
  return isModule ? parsePan(text) : parseOnd(text);
}
