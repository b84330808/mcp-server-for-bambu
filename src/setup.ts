import { writeFileSync, existsSync, readFileSync, renameSync } from "fs";
import mqtt from "mqtt";
import { envFilePath } from "./paths.js";

const SETUP_CONNECT_TIMEOUT_MS = 8000;

export interface SetupInput {
  ip: string;
  serial: string;
  access_code: string;
}

export interface SetupResult {
  ok: boolean;
  message: string;
  envPath: string;
}

// Validate format BEFORE attempting MQTT — saves a 10s timeout for typos.
export function validateInput(input: SetupInput): string | null {
  if (!/^[\d.]+$/.test(input.ip)) {
    return `IP "${input.ip}" doesn't look like an IPv4 address.`;
  }
  if (input.serial.length < 10 || /\s/.test(input.serial)) {
    return `Serial "${input.serial}" looks wrong. P1S serials are 15 characters with no spaces.`;
  }
  if (input.access_code.length !== 8) {
    return `Access code must be exactly 8 characters (got ${input.access_code.length}). Find it on the printer at Settings → WLAN → LAN Mode Liveview.`;
  }
  return null;
}

// Try to connect to the printer's MQTT broker with the given credentials.
// Resolves with a short status string on success, rejects on failure.
function probeConnection(input: SetupInput): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(`mqtts://${input.ip}:8883`, {
      clientId: input.serial,
      username: "bblp",
      password: input.access_code,
      rejectUnauthorized: false,
      reconnectPeriod: 0, // do not retry; fail fast
      connectTimeout: SETUP_CONNECT_TIMEOUT_MS,
      keepalive: 60,
      clean: true,
    });

    const timeout = setTimeout(() => {
      client.end(true);
      reject(
        new Error(
          `No response from ${input.ip}:8883 within ${SETUP_CONNECT_TIMEOUT_MS}ms. ` +
            `Check the IP, that the printer is powered on, and that LAN Mode Liveview is enabled.`,
        ),
      );
    }, SETUP_CONNECT_TIMEOUT_MS);

    client.once("connect", () => {
      clearTimeout(timeout);
      client.end(true);
      resolve(`Connected to ${input.ip} as ${input.serial}.`);
    });

    client.once("error", (err) => {
      clearTimeout(timeout);
      client.end(true);
      const msg = err.message.toLowerCase();
      if (msg.includes("not authorized") || msg.includes("bad user name")) {
        reject(
          new Error(
            `Authentication rejected. The 8-character access code is wrong. ` +
              `It's at Settings → WLAN → LAN Mode Liveview on the printer (NOT the Wi-Fi password).`,
          ),
        );
      } else {
        reject(err);
      }
    });
  });
}

// Write .env atomically. Preserves any unrelated keys already in the file.
function writeEnv(input: SetupInput): string {
  const envPath = envFilePath();
  const lines: string[] = [];
  const seen = new Set<string>();

  if (existsSync(envPath)) {
    for (const raw of readFileSync(envPath, "utf-8").split(/\r?\n/)) {
      const m = raw.match(/^([A-Z_][A-Z0-9_]*)=/);
      if (m && ["BAMBU_IP", "BAMBU_SERIAL", "BAMBU_ACCESS_CODE"].includes(m[1])) {
        continue; // we'll rewrite these below
      }
      lines.push(raw);
    }
  }
  // Strip a trailing blank line if present so we don't grow the file every run
  while (lines.length && lines[lines.length - 1] === "") lines.pop();

  lines.push(`BAMBU_IP=${input.ip}`);
  lines.push(`BAMBU_SERIAL=${input.serial}`);
  lines.push(`BAMBU_ACCESS_CODE=${input.access_code}`);
  lines.push("");
  seen.add("done");

  const tmp = `${envPath}.tmp`;
  writeFileSync(tmp, lines.join("\n"), "utf-8");
  renameSync(tmp, envPath);
  return envPath;
}

export async function runSetup(input: SetupInput): Promise<SetupResult> {
  const formatErr = validateInput(input);
  if (formatErr) {
    return { ok: false, message: formatErr, envPath: envFilePath() };
  }

  try {
    const probeMsg = await probeConnection(input);
    const envPath = writeEnv(input);
    return {
      ok: true,
      message:
        `✅ ${probeMsg}\n` +
        `✅ Credentials saved to ${envPath}\n\n` +
        `**Next:** Fully quit Claude Desktop (right-click tray icon → Quit) and reopen it. ` +
        `On restart, the full set of printer tools (get_status, get_ams_info, get_maintenance_status, mark_maintenance_done) will be available.`,
      envPath,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `❌ Connection test failed — credentials NOT saved.\n\n${msg}`,
      envPath: envFilePath(),
    };
  }
}
