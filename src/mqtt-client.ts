import mqtt, { MqttClient } from "mqtt";
import { EventEmitter } from "events";
import { randomBytes } from "crypto";
import type { MqttReport, PrinterReport, PushAllCommand } from "./types.js";
import type { CommandEnvelope } from "./commands.js";

export const MQTT_PORT = 8883;
export const MQTT_USERNAME = "bblp";
const PUSHALL_TIMEOUT_MS = 5000;
const CONNECT_TIMEOUT_MS = 10000;
const RECONNECT_PERIOD_MS = 5000;

export interface BambuMqttOptions {
  /** Broker port. The printer always uses 8883; tests and the simulator override it. */
  port?: number;
  /** How long connect() waits before giving up. */
  connectTimeoutMs?: number;
  /** Delay between automatic reconnect attempts after a dropped connection. */
  reconnectPeriodMs?: number;
}

// Each connection needs its own client ID: MQTT brokers drop the older
// connection when an ID is reused, so two copies of this server (say, Claude
// Desktop and Claude Code) using the serial as ID would kick each other off in
// a loop. ha-bambulab uses a random ID for the same reason.
export function newClientId(): string {
  return `mcp-bambu-${randomBytes(4).toString("hex")}`;
}

// Turn mqtt.js connection errors into something a user can act on.
export function describeConnectError(err: Error, host: string, port: number): Error {
  const msg = err.message.toLowerCase();
  if (msg.includes("not authorized") || msg.includes("bad user name")) {
    return new Error(
      `Authentication rejected. The 8-character access code is wrong. ` +
        `It's at Settings → WLAN → LAN Mode Liveview on the printer (NOT the Wi-Fi password).`,
    );
  }
  return new Error(
    `Could not reach the printer at ${host}:${port}: ${err.message}. ` +
      `Check the IP, that the printer is powered on and on the same LAN, and that LAN Mode Liveview is enabled.`,
  );
}

export class BambuMqttClient extends EventEmitter {
  private client: MqttClient | null = null;
  private readonly host: string;
  private readonly serial: string;
  private readonly accessCode: string;
  private readonly port: number;
  private readonly connectTimeoutMs: number;
  private readonly reconnectPeriodMs: number;
  private readonly clientId = newClientId();
  private lastReport: PrinterReport = {};
  private connected = false;
  private pushallSequence = 1;
  private inflightPushall: Promise<PrinterReport> | null = null;
  private inflightConnect: Promise<void> | null = null;

  private get reportTopic() {
    return `device/${this.serial}/report`;
  }

  private get requestTopic() {
    return `device/${this.serial}/request`;
  }

  constructor(host: string, serial: string, accessCode: string, options: BambuMqttOptions = {}) {
    super();
    this.host = host;
    this.serial = serial;
    this.accessCode = accessCode;
    this.port = options.port ?? MQTT_PORT;
    this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.reconnectPeriodMs = options.reconnectPeriodMs ?? RECONNECT_PERIOD_MS;
  }

  // Resolves once connected; rejects after connectTimeoutMs. Concurrent and
  // repeated calls share one underlying mqtt.js client, so retrying from every
  // tool call never opens a second connection.
  connect(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.inflightConnect) return this.inflightConnect;
    this.inflightConnect = (this.client ? this.waitForReconnect(this.client) : this.openClient()).finally(
      () => {
        this.inflightConnect = null;
      },
    );
    return this.inflightConnect;
  }

  private openClient(): Promise<void> {
    return new Promise((resolve, reject) => {
      const client = mqtt.connect(`mqtts://${this.host}:${this.port}`, {
        clientId: this.clientId,
        username: MQTT_USERNAME,
        password: this.accessCode,
        rejectUnauthorized: false,   // Bambu printers use self-signed certs
        reconnectPeriod: this.reconnectPeriodMs,
        connectTimeout: this.connectTimeoutMs,
        keepalive: 60,
        clean: true,
        resubscribe: true,
      });
      this.client = client;
      let settled = false;

      // A first connection that never succeeds is torn down completely, so the
      // next call starts fresh instead of leaving mqtt.js retrying behind our back.
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.end(true);
        if (this.client === client) this.client = null;
        reject(describeConnectError(err, this.host, this.port));
      };

      // mqtt.js does not emit `error` when the TCP connection opens but the
      // broker never answers; it just reconnects forever. Without our own
      // deadline, connect() (and the tool call awaiting it) would hang.
      const timer = setTimeout(
        () => fail(new Error(`no answer within ${this.connectTimeoutMs}ms`)),
        this.connectTimeoutMs,
      );

      // Use `on`, not `once` — mqtt.js fires `connect` again after every
      // auto-reconnect, and we need to flip `this.connected` back to true
      // each time.
      client.on("connect", () => {
        this.connected = true;
        client.subscribe(this.reportTopic, { qos: 0 });
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.emit("connected");
          resolve();
        } else {
          this.emit("reconnected");
        }
      });

      client.on("error", (err: Error) => {
        if (!settled) {
          fail(err);
          return;
        }
        // An EventEmitter `error` with no listener throws; only forward it
        // when someone is listening.
        if (this.listenerCount("error") > 0) this.emit("error", err);
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

  // The connection dropped after having worked once; mqtt.js is already
  // reconnecting. Wait for that instead of opening a second connection.
  private waitForReconnect(client: MqttClient): Promise<void> {
    return new Promise((resolve, reject) => {
      const onConnect = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        client.off("connect", onConnect);
        reject(
          new Error(
            `Lost the connection to the printer at ${this.host} and could not reconnect within ` +
              `${this.connectTimeoutMs}ms. Is it powered on and on the LAN? Still retrying in the background.`,
          ),
        );
      }, this.connectTimeoutMs);
      client.once("connect", onConnect);
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
      // Merge incremental updates into the cached state. Listeners get the
      // merged state plus the raw fields of this message.
      this.lastReport = { ...this.lastReport, ...report.print };
      this.emit("report", this.lastReport, report.print);
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

        // Wait for a message that itself carries gcode_state (the pushall
        // answer). Checking the merged cache instead would resolve on the next
        // one-field incremental push and skip the full dump.
        const onReport = (merged: PrinterReport, raw: PrinterReport) => {
          if (raw.gcode_state !== undefined) {
            cleanup();
            resolve(merged);
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
    this.inflightConnect = null;
  }

  isConnected(): boolean {
    return this.connected;
  }
}
