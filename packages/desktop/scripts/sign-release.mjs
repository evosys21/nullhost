// CI's release job: writes SHA256SUMS.txt.sig, the Ed25519 signature of SHA256SUMS.txt
// (in the current folder) with the UPDATE_SIGNING_KEY secret. NullHost updates itself
// only from files listed in a sums file with a valid signature (src/main/selfupdate.ts),
// so this refuses to sign with a key whose public half is not the one the app carries.
import { sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const key = process.env.UPDATE_SIGNING_KEY;
if (!key) throw new Error("the UPDATE_SIGNING_KEY secret is not set");

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "main", "selfupdate.ts"), "utf8");
const pub = /-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----\n/.exec(source)?.[0];
if (!pub) throw new Error("no public key in selfupdate.ts");

const sums = readFileSync("SHA256SUMS.txt");
const sig = sign(null, sums, key);
if (!verify(null, sums, pub, sig)) throw new Error("UPDATE_SIGNING_KEY does not match the public key in selfupdate.ts");
writeFileSync("SHA256SUMS.txt.sig", sig.toString("base64") + "\n");
console.log("signed SHA256SUMS.txt");
