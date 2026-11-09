import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { recommendedIds } from "@nullhost/core";
import { service } from "./service-helper.ts";

test("service: info() says an operation is running, with its latest step, until it ends", async () => {
  const t = await service(async () => "0.1.0");
  try {
    // one local list instead of the catalog's: no network
    for (const id of recommendedIds()) await t.svc.engine.setSourceEnabled(id, false);
    const list = join(t.dir, "list.txt");
    await writeFile(list, "0.0.0.0 ads.example.test\n");
    await t.svc.engine.addUserSource(list, "Test list");
    assert.deepEqual([(await t.svc.info()).busy, (await t.svc.info()).step], [false, ""]);
    const seen: Array<Promise<{ busy: boolean; step: string }>> = [];
    t.svc.onProgress(() => seen.push(t.svc.info()));
    const run = t.svc.apply();
    assert.equal((await t.svc.info()).busy, true, "busy as soon as it is queued");
    await run;
    const during = await Promise.all(seen);
    assert.ok(during.length > 0, "the operation reported steps");
    assert.ok(during.every((i) => i.busy && i.step !== ""), "each step is readable while it runs");
    assert.deepEqual([(await t.svc.info()).busy, (await t.svc.info()).step], [false, ""], "idle again, step cleared");
  } finally {
    await t.done();
  }
});
