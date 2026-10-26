// End-to-end: run the built server (dist/index.js) the way an MCP client does,
// over stdio, against the simulated printer. `npm test` builds first.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startSimPrinter } from "../sim/printer.mjs";

const SERVER = resolve(__dirname, "../dist/index.js");
const LEGACY_ENV = resolve(__dirname, "../.env");

type Sim = Awaited<ReturnType<typeof startSimPrinter>>;
type ToolResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

let sim: Sim;
let configDir: string;
const open: Client[] = [];

// The developer's own BAMBU_* settings must not leak into the server under test.
function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null || /^(BAMBU_|PRINTER_|MAINTENANCE_)/.test(k)) continue;
    env[k] = v;
  }
  return { ...env, BAMBU_CONFIG_DIR: configDir, ...extra };
}

function printerEnv(extra: Record<string, string> = {}): Record<string, string> {
  return cleanEnv({
    BAMBU_IP: sim.host,
    BAMBU_SERIAL: sim.serial,
    BAMBU_ACCESS_CODE: sim.accessCode,
    BAMBU_MQTT_PORT: String(sim.port),
    ...extra,
  });
}

async function startServer(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: "pipe" });
  const client = new Client({ name: "e2e", version: "0.0.0" });
  await client.connect(transport);
  open.push(client);
  return client;
}

const text = (r: unknown) => (r as ToolResult).content.map((c) => c.text ?? "").join("\n");

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  if (!existsSync(SERVER)) throw new Error("dist/index.js missing — run `npm run build` first");
  sim = await startSimPrinter();
  configDir = mkdtempSync(join(tmpdir(), "bambu-e2e-"));
});

afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

afterAll(async () => {
  await sim.close();
  rmSync(configDir, { recursive: true, force: true });
});

describe("server with printer credentials", () => {
  it("lists every tool with safety annotations", async () => {
    const client = await startServer(printerEnv());
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(
      [
        "change_active_tray",
        "forecast_maintenance",
        "get_ams_info",
        "get_maintenance_status",
        "get_recent_prints",
        "get_status",
        "list_active_warnings",
        "mark_maintenance_done",
        "pause_print",
        "preheat",
        "resume_print",
        "run_gcode",
        "set_light",
        "set_speed",
        "stop_print",
      ].sort(),
    );
    expect(byName.get_status.annotations?.readOnlyHint).toBe(true);
    for (const name of ["stop_print", "run_gcode", "change_active_tray"]) {
      expect(byName[name].annotations?.destructiveHint, name).toBe(true);
      expect(byName[name].inputSchema.required, name).toContain("confirm");
    }
    expect(client.getServerVersion()?.version).toBe(
      JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf-8")).version,
    );
  });

  it("reports live status from the printer", async () => {
    const client = await startServer(printerEnv());
    const out = text(await client.callTool({ name: "get_status", arguments: {} }));
    expect(out).toContain("State: Printing");
    expect(out).not.toContain("Printing — printing");
    expect(out).toContain("3DBenchy");
    expect(out).toMatch(/Progress:\s+\d+%/);
  });

  it("refuses stop_print without confirm and sends nothing", async () => {
    const client = await startServer(printerEnv());
    const before = sim.commands.length;
    const result = (await client.callTool({ name: "stop_print", arguments: {} })) as ToolResult;
    expect(result.isError).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    expect(sim.commands.slice(before).some((c) => c.print?.command === "stop")).toBe(false);
  });

  it("refuses run_gcode without confirm", async () => {
    const client = await startServer(printerEnv());
    const result = (await client.callTool({ name: "run_gcode", arguments: { gcode: "G28" } })) as ToolResult;
    expect(result.isError).toBe(true);
  });

  it("sends a confirmed command to the printer", async () => {
    const client = await startServer(printerEnv());
    await client.callTool({ name: "change_active_tray", arguments: { ams_id: 0, slot_id: 2, confirm: true } });
    await waitFor(() => sim.commands.some((c) => c.print?.command === "ams_change_filament"));
    const cmd = sim.commands.findLast((c) => c.print?.command === "ams_change_filament");
    expect(cmd.print).toMatchObject({ ams_id: 0, slot_id: 2, target: 2 });
    const ams = text(await client.callTool({ name: "get_ams_info", arguments: {} }));
    expect(ams).toContain("Active tray: AMS 0 slot 2");
  });

  it("BAMBU_READ_ONLY=1 registers no control tools", async () => {
    const client = await startServer(printerEnv({ BAMBU_READ_ONLY: "1" }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("get_status");
    for (const name of ["pause_print", "resume_print", "stop_print", "run_gcode", "preheat", "change_active_tray", "set_speed", "set_light"]) {
      expect(names).not.toContain(name);
    }
  });

  it("exits when the MCP client closes stdin", async () => {
    const child = spawn(process.execPath, [SERVER], { env: printerEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    await waitFor(() => stderr.includes("ready"), 8000);
    const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
    child.stdin.end();
    const result = await Promise.race([exited, new Promise((r) => setTimeout(() => r("still running"), 3000))]);
    if (result === "still running") child.kill();
    expect(result).toBe(0);
  }, 15_000);
});

describe.skipIf(existsSync(LEGACY_ENV))("first-time setup through MCP", () => {
  it("starts in setup mode, saves credentials, then exposes printer tools", async () => {
    const setupDir = mkdtempSync(join(tmpdir(), "bambu-setup-"));
    try {
      const env = cleanEnv({ BAMBU_CONFIG_DIR: setupDir, BAMBU_MQTT_PORT: String(sim.port) });
      const first = await startServer(env);
      expect((await first.listTools()).tools.map((t) => t.name).sort()).toEqual(["setup_printer", "setup_status"]);

      const bad = (await first.callTool({
        name: "setup_printer",
        arguments: { ip: sim.host, serial: sim.serial, access_code: "00000000" },
      })) as ToolResult;
      expect(bad.isError).toBe(true);
      expect(text(bad)).toMatch(/access code is wrong/);
      expect(existsSync(join(setupDir, ".env"))).toBe(false);

      const good = (await first.callTool({
        name: "setup_printer",
        arguments: { ip: sim.host, serial: sim.serial, access_code: sim.accessCode },
      })) as ToolResult;
      expect(good.isError).toBe(false);
      expect(readFileSync(join(setupDir, ".env"), "utf-8")).toContain(`BAMBU_SERIAL=${sim.serial}`);

      const second = await startServer(env);
      expect((await second.listTools()).tools.map((t) => t.name)).toContain("get_status");
    } finally {
      rmSync(setupDir, { recursive: true, force: true });
    }
  }, 20_000);
});
