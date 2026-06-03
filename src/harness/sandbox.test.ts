/**
 * IN-555: by default, untrusted probe code must not see host secrets in the environment.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeEnv } from "./sandbox.js";

const hostEnv = {
  PATH: "/usr/bin",
  HOME: "/Users/dev",
  LANG: "en_US.UTF-8",
  LINEAR_API_KEY: "lin_api_secret",
  GITHUB_TOKEN: "gho_secret",
  AWS_SECRET_ACCESS_KEY: "aws_secret",
  MY_PASSWORD: "hunter2",
  npm_config_registry: "https://registry.npmjs.org",
};

test("isolate strips secret-looking and credential-prefixed vars, keeps the toolchain env", () => {
  const env = sanitizeEnv(hostEnv, true);
  assert.equal(env.LINEAR_API_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.MY_PASSWORD, undefined);
  // Non-secret toolchain env is preserved so setup/test still works.
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/Users/dev");
  assert.equal(env.LANG, "en_US.UTF-8");
  assert.equal(env.npm_config_registry, "https://registry.npmjs.org");
});

test("no-sandbox passes the full host env through unchanged", () => {
  assert.equal(sanitizeEnv(hostEnv, false), hostEnv);
});
