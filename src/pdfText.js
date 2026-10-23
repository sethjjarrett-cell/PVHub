/* =====================================================================
   PDF TEXT EXTRACTION
   ---------------------------------------------------------------------
   Shared by the datasheet scraper and the project tracker. It lives in
   its own module rather than in App.jsx because the tracker renders
   inside App.jsx, and importing App.jsx back into it would be a cycle.

   The grouping matters more than it looks. pdf.js hands back text items
   with a transform but no notion of a line, so a PVsyst table arrives as
   a bag of fragments. Items within 3 pt of the same baseline are one
   line, ordered by x, with a space inserted wherever the gap to the
   previous item's end exceeds 1.5 pt — which is what turns
   "Pnom total" "600" "kWp" back into a readable row instead of
   "Pnomtotal600kWp".
   ================================================================== */
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import PDF_WORKER_TEXT, { PDF_WORKER_VERSION } from "./pdfWorkerText.js";

let _workerReady = false;
function ensurePdfWorker() {
  if (_workerReady) return;
  /* pdf.js refuses to run a worker whose version does not match the API,
     and because every PDF path here is an optional convenience the
     mismatch surfaces as one unreadable file rather than a broken build
     — which is how an inlined 6.1.200 worker sat against a 6.2.108 API
     without anyone noticing. Say it plainly and name the fix. */
  if (PDF_WORKER_VERSION !== pdfjsLib.version) {
    throw new Error(
      `The inlined pdf.js worker is ${PDF_WORKER_VERSION} but pdfjs-dist is `
      + `${pdfjsLib.version}. Run "npm run gen:pdf-worker" and rebuild.`);
  }
  const blob = new Blob([PDF_WORKER_TEXT], { type: "text/javascript" });
  pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(blob);
  _workerReady = true;
}

/** Group pdf.js text items into visual lines. Exported so the Node
    fixture generator can produce byte-identical text to the browser —
    a parser tested against differently-joined lines is testing a file
    that never occurs in the application. */
export function linesFromItems(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str || !it.str.trim().length) continue;
    const y = it.transform[5], x = it.transform[4];
    let r = rows.find((q) => Math.abs(q.y - y) < 3);
    if (!r) { r = { y, parts: [] }; rows.push(r); }
    r.parts.push({ x, s: it.str, w: it.width || 0 });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => {
    r.parts.sort((a, b) => a.x - b.x);
    let line = "", lastEnd = null;
    for (const pt of r.parts) {
      if (lastEnd !== null && pt.x - lastEnd > 1.5) line += " ";
      line += pt.s;
      lastEnd = pt.x + pt.w;
    }
    return line.trim();
  });
}

/** Browser-side text extraction, identical to the tested Node path. */
export async function extractPdfText(data) {
  ensurePdfWorker();
  const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true, verbosity: 0 }).promise;
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    out.push(...linesFromItems(tc.items));
    out.push("");
  }
  try { doc.destroy(); } catch (e) { /* noop */ }
  return out.join("\n");
}

/** Page count without pulling the text, for the "what did I just drop"
    check before a long parse. */
export async function pdfPageCount(data) {
  ensurePdfWorker();
  const doc = await pdfjsLib.getDocument({ data, useSystemFonts: true, verbosity: 0 }).promise;
  const n = doc.numPages;
  try { doc.destroy(); } catch (e) { /* noop */ }
  return n;
}
