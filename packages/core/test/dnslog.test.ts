import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, compileAllowlist, parseDnsEvents, parseLogState, parseQueryResults, parseTasklist, queryArgs, type BlockIndex } from "../src/index.ts";

// the layout `wevtutil qe ... /f:xml` prints: one <Event> after another, single-quoted attributes
const event = (record: number, pid: number, name: string, type: number, status: number, results: string, id = 3008) =>
  `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-DNS-Client' Guid='{1c95126e-7eea-49a9-a3fe-a378b03ddb4d}'/>` +
  `<EventID>${id}</EventID><Version>0</Version><Level>4</Level><Task>0</Task><Opcode>0</Opcode><Keywords>0x8000000000000000</Keywords>` +
  `<TimeCreated SystemTime='2026-11-04T08:13:41.0443640Z'/><EventRecordID>${record}</EventRecordID><Correlation/><Execution ProcessID='${pid}' ThreadID='16648'/>` +
  `<Channel>Microsoft-Windows-DNS-Client/Operational</Channel><Computer>pc</Computer><Security UserID='S-1-5-21-1'/></System>` +
  `<EventData><Data Name='QueryName'>${name}</Data><Data Name='QueryType'>${type}</Data><Data Name='QueryOptions'>140737488355328</Data>` +
  `<Data Name='QueryStatus'>${status}</Data><Data Name='QueryResults'>${results}</Data></EventData></Event>`;

test("parseQueryResults: IPv4-mapped, IPv6, CNAME chains", () => {
  assert.deepEqual(parseQueryResults("::ffff:93.184.216.34;"), ["93.184.216.34"]);
  assert.deepEqual(parseQueryResults("type:  5 cdn.Example.net.;::ffff:1.2.3.4;::ffff:1.2.3.5;"), ["cdn.example.net", "1.2.3.4", "1.2.3.5"]);
  assert.deepEqual(parseQueryResults("2a00:1450:4001:82b::200e;"), ["2a00:1450:4001:82b::200e"]);
  assert.deepEqual(parseQueryResults("::ffff:0.0.0.0;"), ["0.0.0.0"]);
  assert.deepEqual(parseQueryResults(""), []);
});

test("parseDnsEvents: only 3008, fields, escaping, trailing dot", () => {
  const xml =
    event(10, 4242, "ads.Example.com.", 1, 0, "::ffff:0.0.0.0;") +
    "\r\n" +
    event(11, 4242, "ignored.example", 1, 0, "", 3006) +
    event(12, 77, "a&amp;b.example", 28, 9501, "") +
    event(13, 1, "", 1, 0, "");
  const ev = parseDnsEvents(xml);
  assert.equal(ev.length, 2);
  assert.deepEqual(ev[0], { record: 10, time: "2026-11-04T08:13:41.0443640Z", pid: 4242, name: "ads.example.com", type: 1, status: 0, results: ["0.0.0.0"] });
  assert.equal(ev[1]!.name, "a&b.example");
  assert.equal(ev[1]!.status, 9501);
  assert.deepEqual(parseDnsEvents(""), []);
});

test("parseLogState: wevtutil gl output", () => {
  const gl = "name: Microsoft-Windows-DNS-Client/Operational\r\nenabled: false\r\ntype: Operational\r\nlogging:\r\n  logFileName: x.evtx\r\n  retention: false\r\n  maxSize: 1052672\r\n";
  assert.deepEqual(parseLogState(gl), { enabled: false, maxSize: 1052672 });
  assert.deepEqual(parseLogState(gl.replace("enabled: false", "enabled: true")), { enabled: true, maxSize: 1052672 });
  assert.equal(parseLogState("Failed to read configuration"), null);
});

test("queryArgs and parseTasklist", () => {
  assert.deepEqual(queryArgs(41.9, 0), ["qe", "Microsoft-Windows-DNS-Client/Operational", "/q:*[System[(EventID=3008) and (EventRecordID>41)]]", "/rd:true", "/c:1", "/f:xml"]);
  assert.equal(queryArgs(-5, 500)[2], "/q:*[System[(EventID=3008) and (EventRecordID>0)]]");
  const t = parseTasklist('"System Idle Process","0","Services","0","8 K"\r\n"chrome.exe","4242","Console","1","120,000 K"\r\n');
  assert.equal(t.get(4242), "chrome.exe");
  assert.equal(t.size, 2);
});

test("classify: region, own entry, allowlist, elsewhere, resolved, failed", () => {
  const idx: BlockIndex = {
    region: new Set(["ads.example.com"]),
    own: new Set(["mine.example"]),
    owners: new Map([["ads.example.com", ["StevenBlack unified", "Pete Lowe (pgl.yoyo.org)"]]]),
    allowlisted: new Map([["cdn.segment.com", ["StevenBlack unified"]]]),
    rules: compileAllowlist(["cdn.segment.com"]).rules,
  };
  const e = (name: string, type = 1, status = 0, results = ["1.2.3.4"]) => ({ record: 1, time: "", pid: 1, name, type, status, results });

  const blocked = classify(e("ads.example.com", 28, 9501, []), idx, "chrome.exe");
  assert.equal(blocked.verdict, "blocked"); // an AAAA "no records" for a blocked name is still blocked
  assert.deepEqual(blocked.listedBy, ["StevenBlack unified", "Pete Lowe (pgl.yoyo.org)"]);
  assert.equal(blocked.typeName, "AAAA");
  assert.equal(blocked.statusText, "no records of this type");
  assert.equal(blocked.process, "chrome.exe");

  assert.equal(classify(e("mine.example"), idx).verdict, "own");
  const allowed = classify(e("cdn.segment.com"), idx);
  assert.equal(allowed.verdict, "allowed");
  assert.equal(allowed.allowedBy, "cdn.segment.com");
  assert.equal(classify(e("pihole.example", 1, 0, ["0.0.0.0"]), idx).verdict, "elsewhere");
  const ok = classify(e("example.org"), idx);
  assert.equal(ok.verdict, "resolved");
  assert.equal(ok.statusText, undefined);
  assert.equal(classify(e("nope.invalid", 1, 9003, []), idx).verdict, "failed");
  assert.equal(classify(e("nope.invalid", 1, 9003, []), idx).statusText, "no such name");
});
