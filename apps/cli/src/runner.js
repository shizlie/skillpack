// apps/cli/src/runner.js
import { commands } from "./commands.js";
import {
  parseArgMap,
  buildServerHeaders,
  requireServerUrl,
  parseIntArg,
  normalizeServerUrl,
} from "./arg-helpers.js";
import { fetchWithRequest } from "./http.js";

export async function runCommand(args, fetchImpl = fetch) {
  const group = args[0];
  const action = args[1];
  const flags = parseArgMap(args.slice(2));
  const descriptor = commands[group]?.[action];
  if (!descriptor) return { status: 2, stderr: usageString(), body: null };

  for (const flag of descriptor.required ?? []) {
    if (!flags[flag]) {
      return { status: 1, stderr: `missing_${flag.replace(/-/g, "_")}\n`, body: null };
    }
  }

  if (descriptor.exec) {
    return descriptor.exec(flags);
  }

  const serverUrl = requireServerUrl(flags);
  const request = descriptor.buildRequest(flags);
  const response = await fetchWithRequest(serverUrl, request, {
    headers: buildServerHeaders(flags),
    fetchImpl,
  });
  return { status: response.status, body: response.body };
}

function usageString() {
  return [
    "usage: skillpack <group> <action> [flags]",
    "groups:",
    "  license issue|verify",
    "  tsa manual-attest|latest-attestation",
    "  bundle build",
    "  provider create | customer create | workspace create",
    "  policy issue|sync",
    "  meter upload | usage summary",
    "  billing pricing-rule create | invoice draft | payment-handoff create",
  ].join("\n") + "\n";
}
