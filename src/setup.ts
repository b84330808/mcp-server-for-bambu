import { writeFileSync, existsSync, readFileSync, renameSync, mkdirSync } from "fs";
import { dirname } from "path";
import mqtt from "mqtt";
import { envFilePath } from "./paths.js";
import { isLanAddress } from "./config.js";
import { MQTT_PORT, MQTT_USERNAME, describeConnectError, newClientId } from "./mqtt-client.js";

const SETUP_CONNECT_TIMEOUT_MS = 8000;

export interface SetupInput {
  ip: string;
  serial: string;
  access_code: string;
}

export interface SetupOptions {
  /** Where to write the credentials. Defaults to the per-user config dir. */
  envPath?: string;
  /** Broker port; only the simulator and tests change it. */
  port?: number;
}

export interface SetupResult {
  ok: boolean;
  message: string;
  envPath: string;
}

// Validate format BEFORE attempting MQTT — saves a 10s timeout for typos.
export function validateInput(input: SetupInput): string | null {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(input.ip)) {
    return `IP "${input.ip}" doesn't look like an IPv4 address.`;
  }
  if (!isLanAddress(input.ip)) {
    return (
      `IP "${input.ip}" is not a local-network address. This server only talks to a printer on your LAN ` +
      `(e.g. 192.168.x.x, 10.x.x.x). Never expose the printer's MQTT port to the internet.`
    );
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
function probeConnection(input: SetupInput, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(`mqtts://${input.ip}:${port}`, {
      clientId: newClientId(),
      username: MQTT_USERNAME,
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
          `No response from ${input.ip}:${port} within ${SETUP_CONNECT_TIMEOUT_MS}ms. ` +
            `Check the IP, that the printer is powered on, and that LAN Mode Liveview is enabled.`,
        ),
      );
    }, SETUP_CONNECT_TIMEOUT_MS);

    client.once("connect", () => {
      clearTimeout(timeout);
      client.end(true);
      resolve(`Connected to ${input.ip} (serial ${input.serial}).`);
    });

    client.once("error", (err) => {
      clearTimeout(timeout);
      client.end(true);
      reject(describeConnectError(err, input.ip, port));
    });
  });
}

// Write .env atomically. Preserves any unrelated keys already in the file.
function writeEnv(input: SetupInput, envPath: string): string {
  const lines: string[] = [];

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

  mkdirSync(dirname(envPath), { recursive: true });
  const tmp = `${envPath}.tmp`;
  // 0o600: the access code is a credential. (Ignored on Windows.)
  writeFileSync(tmp, lines.join("\n"), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, envPath);
  return envPath;
}

export async function runSetup(input: SetupInput, options: SetupOptions = {}): Promise<SetupResult> {
  const envPath = options.envPath ?? envFilePath();
  const formatErr = validateInput(input);
  if (formatErr) {
    return { ok: false, message: formatErr, envPath };
  }

  try {
    const probeMsg = await probeConnection(input, options.port ?? MQTT_PORT);
    writeEnv(input, envPath);
    return {
      ok: true,
      message:
        `✅ ${probeMsg}\n` +
        `✅ Credentials saved to ${envPath}\n\n` +
        `**Next:** restart the MCP server so it picks them up — fully quit and reopen Claude Desktop ` +
        `(right-click tray icon → Quit), or run /mcp in Claude Code and reconnect. ` +
        `After the restart all printer tools (get_status, get_ams_info, pause_print, …) are available.`,
      envPath,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `❌ Connection test failed — credentials NOT saved.\n\n${msg}`,
      envPath,
    };
  }
}
