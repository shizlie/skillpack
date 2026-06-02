// apps/cli/src/runner.js
import { commands } from "./commands.js";
import {
  parseArgMap,
  buildServerHeaders,
  requireServerUrl,
} from "./arg-helpers.js";
import { fetchWithRequest } from "./http.js";

function isDescriptor(d) {
  return d && (d.required !== undefined || d.buildRequest !== undefined || d.exec !== undefined);
}

function resolveDescriptor(group, action, subAction) {
  const level1 = commands[group];
  if (!level1) return null;
  const level2 = level1[action];
  if (!level2) return null;
  if (isDescriptor(level2)) {
    return { descriptor: level2, argsConsumed: 2 };
  }
  const level3 = level2[subAction];
  if (!isDescriptor(level3)) return null;
  return { descriptor: level3, argsConsumed: 3 };
}

export async function runCommand(args, fetchImpl = fetch) {
  const group = args[0];
  const action = args[1];
  const subAction = args[2];
  const resolved = resolveDescriptor(group, action, subAction);
  if (!resolved) return { status: 2, stderr: usageString(), body: null };
  const { descriptor, argsConsumed } = resolved;
  const flags = parseArgMap(args.slice(argsConsumed));

  for (const flag of descriptor.required ?? []) {
    if (!flags[flag]) {
      return { status: 1, stderr: `missing_${flag.replace(/-/g, "_")}\n`, body: null };
    }
  }

  if (descriptor.exec) {
    return descriptor.exec(flags, fetchImpl);
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
