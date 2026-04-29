#!/usr/bin/env node
import { config as loadDotenv } from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BambuMqttClient } from "./mqtt-client.js";
import { MaintenanceTracker } from "./maintenance.js";
import { describePrintError, describeHms } from "./hms.js";
import { describeStage, describeSpeed } from "./stages.js";
import {
  cmdPause,
  cmdResume,
  cmdStop,
  cmdSetLight,
  cmdSetSpeed,
  cmdGcode,
  cmdAmsChangeFilament,
  cmdPreheat,
  type SpeedLevel,
} from "./commands.js";
import { runSetup } from "./setup.js";
import { envFilePath, defaultLedgerPath } from "./paths.js";
import type { PrinterReport } from "./types.js";

// Load .env from a fixed location next to the binary, so credentials are
// found regardless of who invoked us (Claude Desktop's cwd is unreliable).
loadDotenv({ path: envFilePath() });

// ── Environment ──────────────────────────────────────────────────────────────

const BAMBU_IP = process.env.BAMBU_IP ?? "";
const BAMBU_SERIAL = process.env.BAMBU_SERIAL ?? "";
const BAMBU_ACCESS_CODE = process.env.BAMBU_ACCESS_CODE ?? "";
const LEDGER_PATH = process.env.MAINTENANCE_LEDGER_PATH ?? defaultLedgerPath();

// "Setup mode" = no credentials yet. We register only the setup tool so the
// user can configure the printer through Claude itself, then restart.
const SETUP_MODE = !BAMBU_IP || !BAMBU_SERIAL || !BAMBU_ACCESS_CODE;

// ── Shared state (only initialized when credentials are present) ─────────────

const mqttClient = SETUP_MODE
  ? null
  : new BambuMqttClient(BAMBU_IP, BAMBU_SERIAL, BAMBU_ACCESS_CODE);
const maintenance = SETUP_MODE ? null : new MaintenanceTracker(LEDGER_PATH);

if (mqttClient && maintenance) {
  mqttClient.on("report", (report: PrinterReport) => {
    maintenance.onStatusUpdate(report);
  });
  // Without this, an MQTT error event would crash the process (Node default).
  mqttClient.on("error", (err: Error) => {
    process.stderr.write(`[bambu-nexus] MQTT error: ${err.message}\n`);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function ensureConnected(): Promise<void> {
  if (!mqttClient) throw new Error("MQTT client not initialized (setup mode).");
  if (!mqttClient.isConnected()) {
    await mqttClient.connect();
  }
}

function formatState(state?: string): string {
  const map: Record<string, string> = {
    IDLE: "Idle",
    RUNNING: "Printing",
    PAUSE: "Paused",
    FAILED: "Failed",
    FINISH: "Finished",
  };
  return state ? (map[state] ?? state) : "Unknown";
}

function formatTemp(current?: number, target?: number): string {
  const c = current != null ? `${current.toFixed(1)}°C` : "—";
  const t = target != null && target > 0 ? ` → ${target.toFixed(1)}°C` : "";
  return `${c}${t}`;
}

function colorHexToRgb(hex?: string): string {
  if (!hex || hex.length < 6) return "unknown";
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "bambu-nexus",
  version: "0.1.0",
});

// ─── Setup-mode tool: setup_printer ──────────────────────────────────────────
// Registered only when credentials are missing. Lets the user configure the
// printer through Claude itself instead of editing config files by hand.

if (SETUP_MODE) {
  server.tool(
    "setup_printer",
    "FIRST-TIME SETUP. Configure this MCP server with your Bambu Lab printer's LAN credentials (IP / serial / access code). Tests the connection live and only saves on success. Find the values on the printer touchscreen: Settings → WLAN (IP), Settings → Device → Device Info (serial), Settings → WLAN → LAN Mode Liveview (8-char access code). Make sure LAN Mode Liveview is ON.",
    {
      ip: z.string().min(7).describe("Printer LAN IP address, e.g. 192.168.1.50"),
      serial: z.string().min(10).describe("Printer serial number (15 chars, P1S starts with 01P00A)"),
      access_code: z.string().length(8).describe("8-character LAN access code from the printer's WLAN settings"),
    },
    async ({ ip, serial, access_code }) => {
      const result = await runSetup({ ip, serial, access_code });
      return {
        content: [{ type: "text", text: result.message }],
        isError: !result.ok,
      };
    },
  );

  server.tool(
    "setup_status",
    "Show the current setup state — whether credentials are configured and where the .env file is located.",
    {},
    async () => {
      const lines = [
        "**Bambu Nexus — Setup Mode**",
        "",
        "No printer credentials found. The printer tools (get_status, get_ams_info, etc.) are not available yet.",
        "",
        `.env path: ${envFilePath()}`,
        "",
        "Use the `setup_printer` tool to configure your printer. After it succeeds, fully quit and reopen Claude Desktop.",
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );
}

// ─── Printer tools (only registered when credentials are present) ───────────

if (!SETUP_MODE && mqttClient && maintenance) {

// ─── Tool: get_status ────────────────────────────────────────────────────────

server.tool(
  "get_status",
  "Get real-time printer status including temperatures, print progress, and current state.",
  {},
  async () => {
    await ensureConnected();
    const report = await mqttClient.requestFullStatus();

    const state = formatState(report.gcode_state);
    const isRunning = report.gcode_state === "RUNNING";

    const lines: string[] = [];
    if (report.stale) {
      lines.push(
        "⚠️  Printer did not respond in time — showing last cached snapshot.",
        "",
      );
    }

    const stage = describeStage(report.stg_cur);
    const speed = describeSpeed(report.spd_lvl);
    const stateLine =
      stage && stage !== "idle" && state === "Printing"
        ? `${state} — ${stage}`
        : state;

    lines.push(
      `**Printer Status** (${BAMBU_SERIAL})`,
      `State: ${stateLine}`,
      "",
      "**Temperatures**",
      `  Nozzle:  ${formatTemp(report.nozzle_temper, report.nozzle_target_temper)}${report.nozzle_diameter ? ` (${report.nozzle_diameter}mm)` : ""}`,
      `  Bed:     ${formatTemp(report.bed_temper, report.bed_target_temper)}`,
      `  Chamber: ${report.chamber_temper != null ? `${report.chamber_temper.toFixed(1)}°C` : "—"}`,
    );

    if (isRunning) {
      lines.push(
        "",
        "**Print Progress**",
        `  Job:       ${report.subtask_name ?? report.gcode_file ?? "—"}`,
        `  Progress:  ${report.mc_percent ?? 0}%`,
        `  Remaining: ${report.mc_remaining_time ?? "—"} min`,
        `  Layer:     ${report.layer_num ?? "—"} / ${report.total_layer_num ?? "—"}`,
        `  Speed:     ${speed ?? "—"}`,
      );
    }

    // Real-time HMS warnings — these are how the printer surfaces problems
    // before they become full failures, so always show them.
    if (report.hms && report.hms.length > 0) {
      lines.push("", "**Active HMS Warnings**");
      for (const w of report.hms) {
        const d = describeHms(w);
        lines.push(`  [${d.severity}] ${d.module}: ${d.code}`);
        lines.push(`    → ${d.wikiUrl}`);
      }
    }

    const errMsg = describePrintError(report.print_error);
    if (errMsg) {
      lines.push("", `**Error:** ${errMsg}`);
    }

    // Surface a weak Wi-Fi signal — common cause of "printer fell off LAN".
    if (report.wifi_signal) {
      const dbm = parseInt(report.wifi_signal, 10);
      if (!isNaN(dbm) && dbm < -70) {
        lines.push("", `⚠️  Weak Wi-Fi signal (${report.wifi_signal}). Below -70dBm is unreliable.`);
      }
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  },
);

// ─── Tool: get_ams_info ──────────────────────────────────────────────────────

server.tool(
  "get_ams_info",
  "Get AMS (Automatic Material System) filament slot information — types, colors, and remaining amounts.",
  {},
  async () => {
    await ensureConnected();
    const report = await mqttClient.requestFullStatus();

    if (!report.ams || !report.ams.ams || report.ams.ams.length === 0) {
      return {
        content: [{ type: "text", text: "No AMS detected or AMS data not yet received." }],
      };
    }

    const lines: string[] = ["**AMS Filament Status**", ""];

    for (const unit of report.ams.ams) {
      lines.push(`AMS Unit ${unit.id}  (humidity: ${unit.humidity ?? "—"}, temp: ${unit.temp ?? "—"}°C)`);

      for (const tray of unit.tray) {
        const filled = tray.tray_type && tray.tray_type !== "";
        if (!filled) {
          lines.push(`  Slot ${tray.id}: empty`);
          continue;
        }
        const color = colorHexToRgb(tray.tray_color);
        const remain = tray.remain != null ? `${tray.remain}% remaining` : "";
        const brand = tray.tray_sub_brands ? ` (${tray.tray_sub_brands})` : "";
        lines.push(
          `  Slot ${tray.id}: ${tray.tray_type}${brand}  ${color}  ${remain}`.trimEnd(),
        );
      }
      lines.push("");
    }

    const active = report.ams.tray_now;
    if (active) {
      lines.push(`Active tray: ${active}`);
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  },
);

// ─── Tool: get_maintenance_status ────────────────────────────────────────────

server.tool(
  "get_maintenance_status",
  "Get the maintenance ledger report — shows cumulative print time and warns when lubrication, rod cleaning, or hotend inspection is due.",
  {},
  async () => {
    const report = maintenance.generateReport();

    const lines: string[] = [
      "**Maintenance Ledger**",
      "",
      `Total print time: ${report.totalPrintHours}h (${report.totalPrintMinutes} min)`,
      `Sessions logged:  ${report.sessionCount}`,
      `Last updated:     ${report.lastUpdated}`,
    ];

    if (report.hasActiveSession) {
      lines.push(
        `Active session:   ${report.activeSessionMinutesElapsed ?? 0} min elapsed (not yet persisted)`,
      );
    }

    lines.push("", "**Maintenance Checks**");

    for (const check of report.checks) {
      const icon = check.status === "OK" ? "✅" : check.status === "DUE_SOON" ? "🔔" : "⚠️ ";
      const due =
        check.status === "OVERDUE"
          ? "OVERDUE"
          : `due in ~${check.hoursUntilDue}h`;
      lines.push(`  ${icon}  ${check.task}  [${check.intervalLabel}]  — ${due}`);
    }

    if (report.warnings.length > 0) {
      lines.push("", "**Warnings**");
      for (const w of report.warnings) {
        lines.push(`  ${w}`);
      }
    } else {
      lines.push("", "All maintenance tasks are on schedule.");
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  },
);

// ─── Tool: mark_maintenance_done ─────────────────────────────────────────────

server.tool(
  "mark_maintenance_done",
  "Record that a maintenance task was completed. Pass `hours_ago` if you did it earlier and forgot to log it.",
  {
    task_id: z.enum(["lube_rails", "clean_carbon_rods", "inspect_hotend"]).describe(
      "Which task was completed: lube_rails | clean_carbon_rods | inspect_hotend",
    ),
    hours_ago: z
      .number()
      .min(0)
      .max(10_000)
      .optional()
      .describe(
        "Optional: how many cumulative print-hours ago this was actually done. Defaults to 0 (now).",
      ),
  },
  async ({ task_id, hours_ago }) => {
    const ok = maintenance.markTaskDone(task_id, hours_ago ?? 0);
    if (!ok) {
      return {
        content: [{ type: "text", text: `Unknown task id: ${task_id}` }],
        isError: true,
      };
    }
    const labels: Record<string, string> = {
      lube_rails: "Lubricate linear rails",
      clean_carbon_rods: "Clean carbon rods",
      inspect_hotend: "Inspect hotend / nozzle wear",
    };
    const totalMin = maintenance.getLedger().totalPrintMinutes;
    const totalHr = (totalMin / 60).toFixed(1);
    const offsetNote = hours_ago && hours_ago > 0
      ? ` (back-dated by ${hours_ago}h)`
      : "";
    return {
      content: [
        {
          type: "text",
          text: `✅ Logged: "${labels[task_id]}" completed at ${totalHr}h cumulative print time (${totalMin} min)${offsetNote}. Countdown reset.`,
        },
      ],
    };
  },
);

// ─── Tool: pause_print ───────────────────────────────────────────────────────

server.tool(
  "pause_print",
  "Pause the current print. Safe — the print can be resumed with `resume_print`.",
  {},
  async () => {
    await ensureConnected();
    await mqttClient.publishCommand(cmdPause());
    return { content: [{ type: "text", text: "⏸️  Pause command sent." }] };
  },
);

// ─── Tool: resume_print ──────────────────────────────────────────────────────

server.tool(
  "resume_print",
  "Resume a paused print.",
  {},
  async () => {
    await ensureConnected();
    await mqttClient.publishCommand(cmdResume());
    return { content: [{ type: "text", text: "▶️  Resume command sent." }] };
  },
);

// ─── Tool: stop_print ────────────────────────────────────────────────────────

server.tool(
  "stop_print",
  "STOP and CANCEL the current print. THIS IS NOT REVERSIBLE — the partial print and any wasted filament cannot be recovered. NEVER call this tool on the user's first stop request. ALWAYS first ask the user to confirm cancellation in plain language; only call this tool with `confirm: true` after they explicitly say yes/confirm/cancel-it.",
  {
    confirm: z
      .literal(true)
      .describe(
        "Must be the literal value true. Only set this AFTER asking the user to confirm out-loud and them agreeing.",
      ),
  },
  async () => {
    await ensureConnected();
    await mqttClient.publishCommand(cmdStop());
    return { content: [{ type: "text", text: "🛑 Stop command sent. The print has been cancelled." }] };
  },
);

// ─── Tool: set_light ─────────────────────────────────────────────────────────

server.tool(
  "set_light",
  "Turn the printer's chamber light on or off.",
  {
    on: z.boolean().describe("true = on, false = off"),
    light: z
      .enum(["chamber", "work"])
      .optional()
      .describe("Which light. Defaults to 'chamber'. P1S only has chamber light."),
  },
  async ({ on, light }) => {
    await ensureConnected();
    const node = light === "work" ? "work_light" : "chamber_light";
    await mqttClient.publishCommand(cmdSetLight(node, on));
    return {
      content: [
        { type: "text", text: `💡 ${node.replace("_", " ")} → ${on ? "ON" : "OFF"}` },
      ],
    };
  },
);

// ─── Tool: set_speed ─────────────────────────────────────────────────────────

server.tool(
  "set_speed",
  "Change the print speed profile. Levels: silent (1), standard (2), sport (3), ludicrous (4).",
  {
    level: z
      .enum(["silent", "standard", "sport", "ludicrous"])
      .describe("Speed profile name"),
  },
  async ({ level }) => {
    const map: Record<string, SpeedLevel> = {
      silent: 1,
      standard: 2,
      sport: 3,
      ludicrous: 4,
    };
    await ensureConnected();
    await mqttClient.publishCommand(cmdSetSpeed(map[level]));
    return { content: [{ type: "text", text: `⚡ Speed → ${level}` }] };
  },
);

// ─── Tool: preheat ───────────────────────────────────────────────────────────

server.tool(
  "preheat",
  "Preheat the nozzle and/or bed to specified temperatures. Useful before manually loading filament or starting a print.",
  {
    nozzle_c: z
      .number()
      .min(0)
      .max(300)
      .optional()
      .describe("Target nozzle temperature in °C (0–300). Common: PLA 210, PETG 240, ABS 260."),
    bed_c: z
      .number()
      .min(0)
      .max(120)
      .optional()
      .describe("Target bed temperature in °C (0–120). Common: PLA 60, PETG 70, ABS 100."),
  },
  async ({ nozzle_c, bed_c }) => {
    if (nozzle_c == null && bed_c == null) {
      return {
        content: [{ type: "text", text: "Specify at least one of nozzle_c or bed_c." }],
        isError: true,
      };
    }
    await ensureConnected();
    await mqttClient.publishCommand(cmdPreheat(nozzle_c, bed_c));
    const parts: string[] = [];
    if (nozzle_c != null) parts.push(`nozzle → ${nozzle_c}°C`);
    if (bed_c != null) parts.push(`bed → ${bed_c}°C`);
    return { content: [{ type: "text", text: `🔥 Preheat: ${parts.join(", ")}` }] };
  },
);

// ─── Tool: run_gcode ─────────────────────────────────────────────────────────

server.tool(
  "run_gcode",
  "Send raw G-code to the printer. POWER USER. Multiple lines separated by \\n. Common: G28 (home), M84 (disable steppers), M104 S210 (set nozzle), G0 Z50 (raise Z). The printer rejects most prints/firmware-affecting commands during a running job.",
  {
    gcode: z
      .string()
      .min(1)
      .max(500)
      .describe(
        "G-code to send. May contain multiple lines separated by \\n. Keep it concise (<500 chars).",
      ),
  },
  async ({ gcode }) => {
    await ensureConnected();
    await mqttClient.publishCommand(cmdGcode(gcode));
    return {
      content: [
        {
          type: "text",
          text: `🛠️  Sent ${gcode.split("\n").filter(Boolean).length} G-code line(s).`,
        },
      ],
    };
  },
);

// ─── Tool: change_active_tray ────────────────────────────────────────────────

server.tool(
  "change_active_tray",
  "Switch the AMS to feed from a different filament slot. Slot IDs are 0–3 within an AMS unit. Use `get_ams_info` first to see what's loaded.",
  {
    ams_id: z
      .number()
      .int()
      .min(0)
      .max(3)
      .describe("Which AMS unit (0 if you only have one)"),
    slot_id: z
      .number()
      .int()
      .min(0)
      .max(3)
      .describe("Which slot in that unit (0–3)"),
  },
  async ({ ams_id, slot_id }) => {
    await ensureConnected();
    await mqttClient.publishCommand(cmdAmsChangeFilament(ams_id, slot_id));
    return {
      content: [
        { type: "text", text: `🔄 Requested AMS ${ams_id} switch to slot ${slot_id}.` },
      ],
    };
  },
);

// ─── Tool: get_recent_prints ─────────────────────────────────────────────────

server.tool(
  "get_recent_prints",
  "List recent print sessions from the maintenance ledger — names, durations, completion timestamps.",
  {
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("How many recent sessions to return. Defaults to 10."),
  },
  async ({ limit }) => {
    const sessions = maintenance.getRecentSessions(limit ?? 10);
    if (sessions.length === 0) {
      return {
        content: [{ type: "text", text: "No print sessions logged yet." }],
      };
    }
    const lines = ["**Recent Prints** (newest first)", ""];
    for (const s of sessions) {
      const hr = (s.durationMinutes / 60).toFixed(1);
      const ended = s.endedAt ? new Date(s.endedAt).toLocaleString() : "—";
      lines.push(`  • ${s.subtaskName ?? "(unnamed)"}`);
      lines.push(`      ${hr}h — finished ${ended}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

// ─── Tool: forecast_maintenance ──────────────────────────────────────────────

server.tool(
  "forecast_maintenance",
  "Predict when each maintenance task will become due, based on recent print rate.",
  {
    window_days: z
      .number()
      .int()
      .min(1)
      .max(90)
      .optional()
      .describe("How many days of history to use for the rate estimate. Defaults to 14."),
  },
  async ({ window_days }) => {
    const forecasts = maintenance.forecast(window_days ?? 14);
    const lines = [
      `**Maintenance Forecast** (based on last ${window_days ?? 14} days)`,
      "",
    ];
    const dailyMin = forecasts[0]?.recentDailyMinutes ?? 0;
    lines.push(
      `Recent print rate: ~${(dailyMin / 60).toFixed(1)} h/day (${dailyMin} min/day)`,
      "",
    );
    for (const f of forecasts) {
      let eta: string;
      if (f.minutesUntilDue <= 0) {
        eta = `**OVERDUE** by ${(-f.minutesUntilDue / 60).toFixed(1)}h`;
      } else if (f.etaDays == null) {
        eta = `~${(f.minutesUntilDue / 60).toFixed(1)}h until due (no recent prints to forecast)`;
      } else {
        eta = `~${f.etaDays} days from now (${(f.minutesUntilDue / 60).toFixed(1)}h of printing)`;
      }
      lines.push(`  • ${f.task}: ${eta}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

// ─── Tool: list_active_warnings ──────────────────────────────────────────────

server.tool(
  "list_active_warnings",
  "List currently active HMS warnings/errors from the printer with links to the official wiki page for each.",
  {},
  async () => {
    await ensureConnected();
    const report = await mqttClient.requestFullStatus();
    if (!report.hms || report.hms.length === 0) {
      return {
        content: [{ type: "text", text: "✅ No active HMS warnings." }],
      };
    }
    const lines = [`**${report.hms.length} active HMS warning(s)**`, ""];
    for (const w of report.hms) {
      const d = describeHms(w);
      lines.push(`  • [${d.severity}] ${d.module}`);
      lines.push(`      ${d.code}`);
      lines.push(`      ${d.wikiUrl}`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

} // end of `if (!SETUP_MODE)` printer-tools block

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (SETUP_MODE) {
    process.stderr.write(
      `[bambu-nexus] Setup mode — no credentials in ${envFilePath()}. ` +
        `Use the setup_printer tool from Claude to configure.\n`,
    );
  } else if (mqttClient && maintenance) {
    // Attempt initial connection; non-fatal if printer is offline at startup
    try {
      await mqttClient.connect();
      try {
        const initial = await mqttClient.requestFullStatus();
        // Don't act on a stale cached snapshot — the printer may currently
        // be RUNNING but our cache is from before the crash.
        if (!initial.stale) {
          maintenance.finalizeRecoveredSessionIfIdle(initial.gcode_state);
        }
      } catch {
        // Printer not responding to pushall — leave the recovered session in
        // place; the live `report` listener will resolve it once data arrives.
      }
    } catch (err) {
      process.stderr.write(
        `[bambu-nexus] Warning: initial MQTT connect failed — will retry on first tool call. ${err}\n`,
      );
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (SETUP_MODE) {
    process.stderr.write(`[bambu-nexus] MCP server ready in SETUP MODE.\n`);
  } else {
    process.stderr.write(
      `[bambu-nexus] MCP server ready. Printer: ${BAMBU_SERIAL} @ ${BAMBU_IP}\n`,
    );
  }
}

function shutdown(): void {
  process.stderr.write("[bambu-nexus] Shutting down...\n");
  mqttClient?.disconnect();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((err) => {
  process.stderr.write(`[bambu-nexus] Fatal: ${err}\n`);
  process.exit(1);
});
