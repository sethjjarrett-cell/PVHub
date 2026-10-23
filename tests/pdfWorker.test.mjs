/* The inlined pdf.js worker must match the installed pdfjs-dist.
   pdf.js refuses to run a mismatched pair, and because every PDF path in
   this application is an optional convenience the failure shows up as
   one file that will not read rather than as a broken build — which is
   how a 6.1.200 worker sat against a 6.2.108 API unnoticed. */
import { createRequire } from "node:module";
import { PDF_WORKER_VERSION } from "../src/pdfWorkerText.js";

const require = createRequire(import.meta.url);
const installed = require("pdfjs-dist/package.json").version;

let pass = 0, fail = 0;
if (PDF_WORKER_VERSION === installed) { pass += 1; } else {
  fail += 1;
  console.log(`  FAIL inlined worker is ${PDF_WORKER_VERSION}, pdfjs-dist is ${installed}`);
  console.log('       run "npm run gen:pdf-worker" and rebuild');
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
