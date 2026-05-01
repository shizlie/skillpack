import fs from "node:fs";

function requireStringInput(inputs, key) {
  const value = inputs?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`deploy_manifest_missing_input:${key}`);
  }
  return value;
}

function resolveStringInput(manifest, inputs, key) {
  const value = inputs?.[key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  const fallback = manifest.inputs?.[key]?.default;
  if (typeof fallback === "string" && fallback.length > 0) {
    return fallback;
  }
  throw new Error(`deploy_manifest_missing_input:${key}`);
}

export function resolveHostedManifest(manifest, inputs) {
  if (manifest?.schemaVersion !== 1) {
    throw new Error("deploy_manifest_invalid_schema_version");
  }

  for (const [inputName, descriptor] of Object.entries(manifest.inputs ?? {})) {
    if (descriptor?.required) {
      requireStringInput(inputs, inputName);
    }
  }

  const resolvedDeployables = {};
  for (const [name, deployable] of Object.entries(manifest.deployables ?? {})) {
    const publicVars = {};
    for (const [key, binding] of Object.entries(deployable.publicVars ?? {})) {
      publicVars[key] = resolveStringInput(manifest, inputs, binding.fromInput);
    }

    resolvedDeployables[name] = {
      ...deployable,
      publicVars,
      secrets: [...(deployable.secrets ?? [])],
      optionalSecrets: [...(deployable.optionalSecrets ?? [])],
    };
  }

  return {
    schemaVersion: manifest.schemaVersion,
    inputs: { ...(manifest.inputs ?? {}) },
    deployables: resolvedDeployables,
  };
}

if (import.meta.main) {
  const manifestPath = process.argv[2];
  const inputsJson = process.argv[3];
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const inputs = JSON.parse(inputsJson);
  process.stdout.write(
    JSON.stringify(resolveHostedManifest(manifest, inputs), null, 2) + "\n"
  );
}
