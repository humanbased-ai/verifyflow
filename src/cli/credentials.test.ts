import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  readCredentials,
  writeCredentials,
  resolveLinearApiKey,
  getCredentialsPath,
} from "./credentials.js";

async function mkTmp(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "vf-creds-"));
}

test("getCredentialsPath defaults to ~/.verifyflow/credentials.json", () => {
  const p = getCredentialsPath("/home/alice");
  assert.equal(p, path.join("/home/alice", ".verifyflow", "credentials.json"));
});

test("readCredentials returns {} when file is absent", async () => {
  const dir = await mkTmp();
  const result = await readCredentials(path.join(dir, "missing.json"));
  assert.deepEqual(result, {});
});

test("readCredentials returns {} on malformed JSON (never throws)", async () => {
  const dir = await mkTmp();
  const p = path.join(dir, "bad.json");
  await fs.writeFile(p, "{not-json", "utf8");
  const result = await readCredentials(p);
  assert.deepEqual(result, {});
});

test("writeCredentials creates the directory if missing", async () => {
  const dir = await mkTmp();
  const p = path.join(dir, "nested", "deep", "credentials.json");
  await writeCredentials({ linearApiKey: "lin_api_test" }, p);
  const back = await readCredentials(p);
  assert.equal(back.linearApiKey, "lin_api_test");
});

test("writeCredentials sets 0600 permissions on POSIX", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX-only permissions check");
  const dir = await mkTmp();
  const p = path.join(dir, "credentials.json");
  await writeCredentials({ linearApiKey: "lin_api_x" }, p);
  const stat = await fs.stat(p);
  assert.equal(stat.mode & 0o777, 0o600);
});

test("resolveLinearApiKey: env wins over file", async () => {
  const dir = await mkTmp();
  const p = path.join(dir, "credentials.json");
  await writeCredentials({ linearApiKey: "from-file" }, p);
  const key = await resolveLinearApiKey({ LINEAR_API_KEY: "from-env" }, p);
  assert.equal(key, "from-env");
});

test("resolveLinearApiKey: falls back to file when env is empty", async () => {
  const dir = await mkTmp();
  const p = path.join(dir, "credentials.json");
  await writeCredentials({ linearApiKey: "from-file" }, p);
  const key = await resolveLinearApiKey({}, p);
  assert.equal(key, "from-file");
});

test("resolveLinearApiKey: returns undefined when neither source has a key", async () => {
  const dir = await mkTmp();
  const key = await resolveLinearApiKey({}, path.join(dir, "missing.json"));
  assert.equal(key, undefined);
});

test("resolveLinearApiKey: empty-string env var falls through to file", async () => {
  const dir = await mkTmp();
  const p = path.join(dir, "credentials.json");
  await writeCredentials({ linearApiKey: "from-file" }, p);
  const key = await resolveLinearApiKey({ LINEAR_API_KEY: "" }, p);
  assert.equal(key, "from-file");
});
