import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

// Resolve the project root from the running binary's location, so .env and
// maintenance.json land in the right place regardless of who launched us
// (npm start, Claude Desktop, a daemon, ...). dist/index.js → ../
export function projectRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..");
}

export function envFilePath(): string {
  return resolve(projectRoot(), ".env");
}

export function defaultLedgerPath(): string {
  return resolve(projectRoot(), "maintenance.json");
}
