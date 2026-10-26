import { copyFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname } from "path";
import { parse as parseDotenv } from "dotenv";
import {
  defaultLedgerPath,
  envFilePath,
  legacyEnvFilePath,
  legacyLedgerPath,
} from "./paths.js";
import { MQTT_PORT } from "./mqtt-client.js";

export interface ServerConfig {
  ip: string;
  serial: string;
  accessCode: string;
  port: number;
  ledgerPath: string;
  /** Register only the read tools; nothing that moves, heats or cancels. */
  readOnly: boolean;
  /** Where setup_printer saves credentials. */
  envPath: string;
}

// Earlier README versions documented PRINTER_* names, which the server never
// read, so configs copied from there silently fell back to setup mode.
const ALIASES: Record<string, string[]> = {
  BAMBU_IP: ["PRINTER_IP"],
  BAMBU_SERIAL: ["PRINTER_SERIAL"],
  BAMBU_ACCESS_CODE: ["PRINTER_ACCESS_CODE"],
};

// Treat empty values and unexpanded placeholders such as "${user_config.ip}"
// (left behind when a client has nothing to substitute) as unset.
function usable(value: string | undefined): string | undefined {
  if (value == null) return undefined;
  const v = value.trim();
  if (v === "" || /^\$\{[^}]*\}$/.test(v)) return undefined;
  return v;
}

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    return parseDotenv(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function truthy(value: string | undefined): boolean {
  return value != null && /^(1|true|yes|on)$/i.test(value.trim());
}

// Process env wins over the config-dir .env, which wins over the legacy .env.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const files = [readEnvFile(envFilePath(env)), readEnvFile(legacyEnvFilePath())];
  const get = (key: string): string | undefined => {
    for (const name of [key, ...(ALIASES[key] ?? [])]) {
      const v = usable(env[name]);
      if (v) return v;
    }
    for (const file of files) {
      const v = usable(file[key]);
      if (v) return v;
    }
    return undefined;
  };

  const port = Number(get("BAMBU_MQTT_PORT") ?? MQTT_PORT);
  return {
    ip: get("BAMBU_IP") ?? "",
    serial: get("BAMBU_SERIAL") ?? "",
    accessCode: get("BAMBU_ACCESS_CODE") ?? "",
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : MQTT_PORT,
    ledgerPath: get("MAINTENANCE_LEDGER_PATH") ?? defaultLedgerPath(env),
    readOnly: truthy(get("BAMBU_READ_ONLY")),
    envPath: envFilePath(env),
  };
}

// Copy a ledger written by 0.2.0 or earlier into the config dir once, so
// print-hour history survives the move. The old file is left in place.
export function migrateLegacyLedger(ledgerPath: string, legacyPath = legacyLedgerPath()): boolean {
  if (existsSync(ledgerPath) || !existsSync(legacyPath) || ledgerPath === legacyPath) return false;
  mkdirSync(dirname(ledgerPath), { recursive: true });
  copyFileSync(legacyPath, ledgerPath);
  return true;
}

// The printer must be reached over the local network only. Accept private,
// loopback, link-local and CGNAT (Tailscale-style 100.64/10) IPv4 addresses.
export function isLanAddress(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}
