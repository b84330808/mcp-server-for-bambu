// Captures real tool output for docs/demo.gif: runs the built server against
// the simulator (start it first: SIM_PORT=18883 npm run sim) and records each
// call. Then render with: python scripts/demo/render.py demo-capture.json docs/demo.gif
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = process.argv[2] ?? "demo-capture.json";
const env = {
  ...process.env,
  BAMBU_IP: "127.0.0.1",
  BAMBU_SERIAL: "01P00ASIMULATOR",
  BAMBU_ACCESS_CODE: "12345678",
  BAMBU_MQTT_PORT: "18883",
  BAMBU_CONFIG_DIR: mkdtempSync(join(tmpdir(), "bambu-demo-")),
};
const client = new Client({ name: "demo", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env, stderr: "pipe" }));
const steps = [
  ["What's my printer doing right now?", "get_status", {}],
  ["Which filament is loaded in the AMS?", "get_ams_info", {}],
  ["Pause it and turn the chamber light off.", "pause_print", {}],
  [null, "set_light", { on: false }],
  [null, "get_status", {}],
  ["Actually, cancel the print.", "stop_print", {}],
];
const res = [];
for (const [ask, tool, args] of steps) {
  const r = await client.callTool({ name: tool, arguments: args });
  res.push({ ask, tool, args, isError: !!r.isError, text: r.content.map((c) => c.text).join("\n") });
  await new Promise((resolve) => setTimeout(resolve, 500));
}
writeFileSync(out, JSON.stringify(res, null, 2));
await client.close();
