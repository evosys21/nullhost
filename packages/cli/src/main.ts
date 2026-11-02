#!/usr/bin/env node
import { run } from "./cli.ts";

process.exitCode = await run(process.argv.slice(2), {
  out: (s) => process.stdout.write(s + "\n"),
  err: (s) => process.stderr.write(s + "\n"),
  env: process.env,
});
