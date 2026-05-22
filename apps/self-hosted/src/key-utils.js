import { readFileSync } from "node:fs";

export function readKeyFromEnvOrFile(envVar, filePath) {
  if (process.env[envVar]) {
    return process.env[envVar];
  }
  if (filePath) {
    return readFileSync(filePath, "utf-8");
  }
  return undefined;
}
