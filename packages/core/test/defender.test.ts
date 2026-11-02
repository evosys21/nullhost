import assert from "node:assert/strict";
import { test } from "node:test";
import { readDefenderExclusions } from "../src/platform/windows.ts";

const hosts = "C:\\Windows\\System32\\drivers\\etc\\hosts";

test("Defender check: only a real list of paths answers yes or no; anything else is 'could not tell'", () => {
  assert.equal(readDefenderExclusions("C:\\Temp\r\nC:\\Windows\\System32\\drivers\\etc\\hosts\r\n", hosts), true);
  assert.equal(readDefenderExclusions("C:\\Temp\r\n%ProgramData%\\Foo\r\n\\\\server\\share\r\n", hosts), false);
  assert.equal(readDefenderExclusions("<none>\r\n", hosts), false, "Defender active, nothing excluded");
  assert.equal(readDefenderExclusions("<off>\r\n", hosts), null, "Defender off or passive beside another antivirus");
  assert.equal(readDefenderExclusions("", hosts), null, "no output is not proof of anything");
  assert.equal(readDefenderExclusions("N/A: Must be an administrator to view exclusions", hosts), null);
  assert.equal(readDefenderExclusions("N/A: Für die Anzeige von Ausschlüssen sind Administratorrechte erforderlich", hosts), null, "localized wording");
});
