#!/usr/bin/env node
// A simulated Bambu Lab printer: a TLS MQTT broker on localhost that speaks
// enough of the printer's LAN protocol for tests and demos.
//
// - Auth: username "bblp", password = access code (like the real printer).
// - Topics: subscribe to device/<serial>/report, publish to device/<serial>/request.
// - Answers `pushall`, and applies pause / resume / stop / print_speed /
//   gcode_line (M104/M140) / ams_change_filament / ledctrl to its state.
// - Every command it receives is recorded in `sim.commands` for assertions.
//
// Run it standalone (`npm run sim`) to try the MCP server or record a demo
// without touching a real printer. Used by the test suite via startSimPrinter().

import { createServer } from "node:tls";
import { pathToFileURL } from "node:url";
import { Aedes } from "aedes";
import selfsigned from "selfsigned";

export const SIM_SERIAL = "01P00ASIMULATOR";
export const SIM_ACCESS_CODE = "12345678";

/** Snapshot of a P1S halfway through a print, with a 4-slot AMS. */
export function defaultPrinterState() {
  return {
    gcode_state: "RUNNING",
    stg_cur: 0,
    print_type: "local",
    subtask_name: "3DBenchy",
    gcode_file: "3DBenchy.gcode.3mf",
    mc_percent: 42,
    mc_remaining_time: 37,
    layer_num: 104,
    total_layer_num: 248,
    nozzle_temper: 219.8,
    nozzle_target_temper: 220,
    bed_temper: 54.9,
    bed_target_temper: 55,
    chamber_temper: 31,
    nozzle_diameter: "0.4",
    spd_lvl: 2,
    spd_mag: 100,
    wifi_signal: "-48dBm",
    print_error: 0,
    hms: [],
    lights_report: [{ node: "chamber_light", mode: "on" }],
    ams: {
      tray_now: "0",
      ams: [
        {
          id: "0",
          humidity: "4",
          temp: "26.1",
          tray: [
            { id: "0", tray_type: "PLA", tray_sub_brands: "PLA Basic", tray_color: "FFFFFFFF", remain: 78 },
            { id: "1", tray_type: "PLA", tray_sub_brands: "PLA Matte", tray_color: "000000FF", remain: 35 },
            { id: "2", tray_type: "PETG", tray_sub_brands: "PETG HF", tray_color: "2850E0FF", remain: 92 },
            { id: "3" },
          ],
        },
      ],
    },
  };
}

/**
 * Start a simulated printer.
 *
 * @param {object} [opts]
 * @param {string} [opts.host] Interface to listen on. Default 127.0.0.1.
 * @param {number} [opts.port] TCP port. Default 0 (pick a free one).
 * @param {string} [opts.serial]
 * @param {string} [opts.accessCode]
 * @param {boolean} [opts.respondToPushall] Answer `pushall`. Default true.
 * @param {number} [opts.tickMs] If > 0, advance the print and push an update this often.
 * @param {object} [opts.state] Initial state, merged over defaultPrinterState().
 */
export async function startSimPrinter(opts = {}) {
  const host = opts.host ?? "127.0.0.1";
  const serial = opts.serial ?? SIM_SERIAL;
  const accessCode = opts.accessCode ?? SIM_ACCESS_CODE;
  const reportTopic = `device/${serial}/report`;
  const requestTopic = `device/${serial}/request`;

  const pems = await selfsigned.generate([{ name: "commonName", value: serial }], {
    keyType: "ec",
    algorithm: "sha256",
  });

  const broker = await Aedes.createBroker();
  const state = { ...defaultPrinterState(), ...(opts.state ?? {}) };
  const commands = [];
  const connectedClients = new Set();
  let respondToPushall = opts.respondToPushall ?? true;

  broker.authenticate = (_client, username, password, callback) => {
    if (username === "bblp" && password?.toString() === accessCode) {
      callback(null, true);
      return;
    }
    const err = new Error("Not authorized");
    err.returnCode = 5;
    callback(err, false);
  };
  broker.authorizeSubscribe = (_client, sub, callback) => {
    callback(sub.topic === reportTopic ? null : new Error(`no such topic: ${sub.topic}`), sub);
  };
  broker.on("client", (client) => connectedClients.add(client.id));
  broker.on("clientDisconnect", (client) => connectedClients.delete(client.id));

  function push(fields) {
    const payload = JSON.stringify({ print: fields });
    broker.publish({ cmd: "publish", topic: reportTopic, payload, qos: 0, retain: false, dup: false }, () => {});
  }

  function update(patch) {
    Object.assign(state, patch);
    push({ ...patch, command: "push_status", msg: 1 });
  }

  function handleCommand(message) {
    if (message.pushing?.command === "pushall") {
      if (respondToPushall) {
        push({ ...state, command: "push_status", msg: 0, sequence_id: message.pushing.sequence_id });
      }
      return;
    }
    const print = message.print;
    if (print) {
      switch (print.command) {
        case "pause":
          if (state.gcode_state === "RUNNING") update({ gcode_state: "PAUSE", stg_cur: 16 });
          break;
        case "resume":
          if (state.gcode_state === "PAUSE") update({ gcode_state: "RUNNING", stg_cur: 0 });
          break;
        case "stop":
          update({ gcode_state: "FAILED", stg_cur: -1, mc_remaining_time: 0 });
          break;
        case "print_speed":
          update({ spd_lvl: Number(print.param) });
          break;
        case "gcode_line": {
          const nozzle = /M104 S(\d+)/.exec(print.param ?? "");
          const bed = /M140 S(\d+)/.exec(print.param ?? "");
          const patch = {};
          if (nozzle) patch.nozzle_target_temper = Number(nozzle[1]);
          if (bed) patch.bed_target_temper = Number(bed[1]);
          if (Object.keys(patch).length) update(patch);
          break;
        }
        case "ams_change_filament":
          update({ ams: { ...state.ams, tray_now: String(print.target) } });
          break;
      }
    }
    if (message.system?.command === "ledctrl") {
      update({ lights_report: [{ node: message.system.led_node, mode: message.system.led_mode }] });
    }
  }

  broker.on("publish", (packet, client) => {
    if (!client || packet.topic !== requestTopic) return;
    let message;
    try {
      message = JSON.parse(packet.payload.toString());
    } catch {
      return;
    }
    commands.push(message);
    handleCommand(message);
  });

  let ticker = null;
  if (opts.tickMs > 0) {
    ticker = setInterval(() => {
      if (state.gcode_state !== "RUNNING") return;
      const pct = Math.min(100, state.mc_percent + 1);
      const patch = {
        mc_percent: pct,
        layer_num: Math.round((state.total_layer_num * pct) / 100),
        mc_remaining_time: Math.max(0, Math.round(((100 - pct) * 64) / 100)),
        nozzle_temper: state.nozzle_target_temper + (Math.random() - 0.5),
        bed_temper: state.bed_target_temper + (Math.random() - 0.5) / 2,
      };
      if (pct === 100) Object.assign(patch, { gcode_state: "FINISH", stg_cur: -1 });
      update(patch);
    }, opts.tickMs);
  }

  const server = createServer({ key: pems.private, cert: pems.cert }, broker.handle);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, resolve);
  });
  const { port } = server.address();

  return {
    host,
    port,
    serial,
    accessCode,
    state,
    commands,
    /** Client IDs currently connected to the broker. */
    connectedClients,
    /** Change state and push the changed fields, like the printer does. */
    update,
    setRespondToPushall(value) {
      respondToPushall = value;
    },
    async close() {
      if (ticker) clearInterval(ticker);
      await new Promise((resolve) => broker.close(resolve));
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// ── CLI: `npm run sim` ───────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.SIM_PORT ?? 8883);
  const sim = await startSimPrinter({ port, tickMs: 3000 });
  process.stdout.write(
    [
      `Simulated Bambu printer listening on mqtts://${sim.host}:${sim.port}`,
      "",
      "Point the MCP server at it with these env vars:",
      `  BAMBU_IP=${sim.host}`,
      `  BAMBU_SERIAL=${sim.serial}`,
      `  BAMBU_ACCESS_CODE=${sim.accessCode}`,
      ...(sim.port === 8883 ? [] : [`  BAMBU_MQTT_PORT=${sim.port}`]),
      "",
      "Ctrl+C to stop.",
      "",
    ].join("\n"),
  );
  const stop = async () => {
    await sim.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
