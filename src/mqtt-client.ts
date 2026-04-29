import mqtt, { MqttClient } from "mqtt";
import { EventEmitter } from "events";
import type { MqttReport, PrinterReport, PushAllCommand } from "./types.js";
import type { CommandEnvelope } from "./commands.js";

const MQTT_PORT = 8883;
const MQTT_USERNAME = "bblp";
const PUSHALL_TIMEOUT_MS = 5000;

export class BambuMqttClient extends EventEmitter {
  private client: MqttClient | null = null;
  private readonly host: string;
  private readonly serial: string;
  private readonly accessCode: string;
  private lastReport: PrinterReport = {};
  private connected = false;
  private pushallSequence = 1;
  private inflightPushall: Promise<PrinterReport> | null = null;

  private get reportTopic() {
    return `device/${this.serial}/report`;
  }

  private get requestTopic() {
    return `device/${this.serial}/request`;
  }

  constructor(host: string, serial: string, accessCode: string) {
    super();
    this.host = host;
    this.serial = serial;
    this.accessCode = accessCode;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.connected) {
        resolve();
        return;
      }

      const brokerUrl = `mqtts://${this.host}:${MQTT_PORT}`;

      const client = mqtt.connect(brokerUrl, {
        clientId: this.serial,
        username: MQTT_USERNAME,
        password: this.accessCode,
        rejectUnauthorized: false,   // Bambu printers use self-signed certs
        reconnectPeriod: 5000,
        connectTimeout: 10000,
        keepalive: 60,
        clean: true,
        resubscribe: true,
      });
      this.client = client;
      let firstConnect = true;

      // Use `on`, not `once` — mqtt.js fires `connect` again after every
      // auto-reconnect, and we need to flip `this.connected` back to true
      // each time. Resolving the outer Promise multiple times is a no-op.
      client.on("connect", () => {
        this.connected = true;
        client.subscribe(this.reportTopic, { qos: 0 });
        if (firstConnect) {
          firstConnect = false;
          this.emit("connected");
          resolve();
        } else {
          this.emit("reconnected");
        }
      });

      client.on("error", (err: Error) => {
        this.emit("error", err);
        if (firstConnect) {
          reject(err);
        }
      });

      client.on("close", () => {
        this.connected = false;
        this.emit("disconnected");
      });

      client.on("reconnect", () => {
        this.emit("reconnecting");
      });

      client.on("message", (_topic: string, payload: Buffer) => {
        this.handleMessage(payload);
      });
    });
  }

  private handleMessage(payload: Buffer): void {
    let report: MqttReport;
    try {
      report = JSON.parse(payload.toString()) as MqttReport;
    } catch {
      return;
    }

    if (report.print) {
      // Merge incremental updates into the cached state
      this.lastReport = { ...this.lastReport, ...report.print };
      this.emit("report", this.lastReport);
    }
  }

  // Request a full status dump from the printer and wait for its response.
  // Concurrent callers share a single in-flight request to avoid duplicate
  // pushall commands and stacked listeners. Throws on timeout if no data
  // has ever been received; otherwise returns the cached snapshot with
  // `stale: true` so callers can warn the user.
  async requestFullStatus(): Promise<PrinterReport & { stale?: boolean }> {
    if (!this.client || !this.connected) {
      throw new Error("MQTT client not connected");
    }
    if (this.inflightPushall) return this.inflightPushall;

    const sequenceId = String(this.pushallSequence++);
    const command: PushAllCommand = {
      pushing: { sequence_id: sequenceId, command: "pushall" },
    };

    this.inflightPushall = new Promise<PrinterReport & { stale?: boolean }>(
      (resolve, reject) => {
        const cleanup = () => {
          this.off("report", onReport);
          clearTimeout(timeout);
        };

        const timeout = setTimeout(() => {
          cleanup();
          // If we've never received anything, surface a real error so the
          // tool can tell the user the printer is unreachable instead of
          // showing an empty dashboard.
          if (Object.keys(this.lastReport).length === 0) {
            reject(
              new Error(
                `Printer did not respond to status request within ${PUSHALL_TIMEOUT_MS}ms. ` +
                  `Check the printer is on, on the same LAN, and LAN Mode Liveview is enabled.`,
              ),
            );
            return;
          }
          // Otherwise return cached data flagged as stale.
          resolve({ ...this.lastReport, stale: true });
        }, PUSHALL_TIMEOUT_MS);

        const onReport = (report: PrinterReport) => {
          if (report.gcode_state !== undefined) {
            cleanup();
            resolve(report);
          }
        };

        this.on("report", onReport);
        this.client!.publish(this.requestTopic, JSON.stringify(command), { qos: 1 });
      },
    ).finally(() => {
      this.inflightPushall = null;
    });

    return this.inflightPushall;
  }

  getCachedReport(): PrinterReport {
    return { ...this.lastReport };
  }

  // Publish a command envelope to the printer. The server fills in a
  // monotonically-increasing sequence_id so concurrent commands can be
  // correlated against responses if we ever need to.
  //
  // NOTE: Bambu's MQTT broker often executes the command but doesn't send
  // a PUBACK back, so a QoS 1 publish-with-callback hangs forever. We use
  // QoS 0 and resolve as soon as mqtt.js has handed the packet to the
  // socket — same pattern as `requestFullStatus`'s pushall.
  async publishCommand(envelope: CommandEnvelope): Promise<void> {
    if (!this.client || !this.connected) {
      throw new Error("MQTT client not connected");
    }
    const sequenceId = String(this.pushallSequence++);
    const payload = {
      [envelope.topic]: { sequence_id: sequenceId, ...envelope.body },
    };
    this.client.publish(this.requestTopic, JSON.stringify(payload), { qos: 0 });
  }

  disconnect(): void {
    this.client?.end(true);
    this.client = null;
    this.connected = false;
    this.inflightPushall = null;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
