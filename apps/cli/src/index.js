// apps/cli/src/index.js — public entry for the skillpack CLI.
// All subcommand logic lives in commands.js (descriptors) and runner.js (dispatch).
import { runCommand } from "./runner.js";

export async function runSkillpackCli(args, io = process, { fetchImpl = fetch } = {}) {
  let result;
  try {
    result = await runCommand(args, fetchImpl);
  } catch (error) {
    io.stderr.write(JSON.stringify({ error: error.message }) + "\n");
    return 1;
  }

  // status 2 = unknown command (runner signals usage error)
  if (result.status === 2) {
    io.stderr.write(result.stderr);
    return 2;
  }

  // status 1 = missing required flag (runner plain-text stderr → JSON error envelope)
  if (result.status === 1) {
    const msg = (result.stderr || "unknown_error").trim();
    io.stderr.write(JSON.stringify({ error: msg }) + "\n");
    return 1;
  }

  // HTTP error responses
  if (result.status >= 400) {
    io.stderr.write(JSON.stringify(result.body) + "\n");
    return 1;
  }

  // Success — optional warning on stderr, body on stdout
  if (result.stderr) io.stderr.write(result.stderr);
  io.stdout.write(JSON.stringify(result.body) + "\n");
  return 0;
}
