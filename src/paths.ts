import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import { homedir } from "os";

const APP_DIR_NAME = "mcp-server-for-bambu";

// Resolve the project root from the running binary's location. dist/index.js → ../
export function projectRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..");
}

// Credentials and the maintenance ledger live in a per-user directory, not in
// the package. `npx` and Claude Code plugins replace the package directory on
// every update, which used to wipe both files.
//
//   BAMBU_CONFIG_DIR, if set
//   Windows: %APPDATA%\mcp-server-for-bambu
//   macOS:   ~/Library/Application Support/mcp-server-for-bambu
//   Linux:   $XDG_CONFIG_HOME/mcp-server-for-bambu (default ~/.config/...)
export function configDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (env.BAMBU_CONFIG_DIR) return resolve(env.BAMBU_CONFIG_DIR);
  const home = homedir();
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), APP_DIR_NAME);
  if (platform === "darwin") return join(home, "Library", "Application Support", APP_DIR_NAME);
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), APP_DIR_NAME);
}

export function envFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), ".env");
}

export function defaultLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "maintenance.json");
}

// Where versions up to 0.2.0 kept these files (next to dist/). Still read, so
// an existing setup keeps working after the upgrade.
export function legacyEnvFilePath(): string {
  return resolve(projectRoot(), ".env");
}

export function legacyLedgerPath(): string {
  return resolve(projectRoot(), "maintenance.json");
}
