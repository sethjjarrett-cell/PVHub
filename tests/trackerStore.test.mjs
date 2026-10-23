/* The tracker's storage decisions.

   The browser halves — a file picker, a permission prompt — can only be
   driven by a person, so what is tested here is the branching around
   them and the wording the interface shows. Getting the branching wrong
   is how a tracker silently writes to browser storage while telling the
   user it is writing to their file. */
import { startupPlan, describeStore, LS_KEY } from "../src/trackerStore.js";

let pass = 0, fail = 0;
const eq = (got, want, what) => {
  if (Object.is(got, want)) pass += 1;
  else { fail += 1; console.log(`  FAIL ${what}\n    got  ${JSON.stringify(got)}\n    want ${JSON.stringify(want)}`); }
};
const ok = (c, what) => { if (c) pass += 1; else { fail += 1; console.log(`  FAIL ${what}`); } };

console.log("\n--- the startup decision ---");
eq(startupPlan(true, "granted"), "file", "a granted handle reopens the file");
eq(startupPlan(true, "prompt"), "grant", "a prompt state asks, it does not reopen silently");
eq(startupPlan(true, "denied"), "forget", "a denied handle is dropped");
eq(startupPlan(true, "gone"), "forget", "a handle to a deleted file is dropped");
eq(startupPlan(true, null), "local", "no saved handle means browser storage");
/* The one that matters most: a browser without the API must never be
   told it is in file mode, whatever is in IndexedDB from another one. */
eq(startupPlan(false, "granted"), "local", "no API means browser storage, even with a handle");
eq(startupPlan(false, "prompt"), "local", "no API never offers a reconnect");
eq(startupPlan(false, null), "local", "no API, no handle");

console.log("\n--- what the user is told ---");
const file = describeStore("file", "tracker.json", true);
ok(file.includes("tracker.json"), "file mode names the file");
ok(/nothing is kept in browser storage/i.test(file), "file mode states that the browser holds no records");
ok(/reference/i.test(file), "and is honest that a reference to the file is kept");

const local = describeStore("local", "", true);
ok(/local storage/i.test(local), "browser mode says so plainly");
ok(/readable by anyone/i.test(local), "and does not soften who can read it");
ok(/choose a file/i.test(local), "and points at the way out");

const noApi = describeStore("local", "", false);
ok(/not available here/i.test(noApi), "an unsupported browser is told the file option is absent");
ok(/export/i.test(noApi), "and given the thing it can do instead");
ok(!/choose a file/i.test(noApi), "and is not told to use a button it does not have");

const mem = describeStore("memory", "", true);
ok(/this tab only/i.test(mem), "memory mode says the records are not written anywhere");
ok(/gone/i.test(mem), "and that closing the tab loses them");

/* Every mode must produce a real sentence — an empty status line would
   read as "saved somewhere" and that is the one thing it must not. */
for (const m of ["file", "local", "memory"]) {
  for (const sup of [true, false]) {
    const t = describeStore(m, "x.json", sup);
    ok(typeof t === "string" && t.length > 40, `describeStore(${m}, ${sup}) says something`);
  }
}

console.log("\n--- the storage key ---");
eq(LS_KEY, "pvhub.tracker.v1", "the localStorage key is versioned");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
