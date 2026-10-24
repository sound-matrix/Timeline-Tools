import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
/** The three parity checks must use this checkout, independent of shell cwd/PYTHONPATH. */
export function runPython(args, options = {}) {
  const executable =
    process.env.TEST_PYTHON ||
    process.env.CODEX_PRIMARY_RUNTIME_PYTHON ||
    "python3";
  const result = spawnSync(executable, args, {
    ...options,
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: projectRoot },
  });
  assert.equal(
    result.status,
    0,
    JSON.stringify({
      executable,
      cwd: projectRoot,
      status: result.status,
      signal: result.signal,
      error: result.error?.message,
      stderr: result.stderr,
    }),
  );
  return result;
}
