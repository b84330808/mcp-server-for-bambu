import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { BambuMqttClient } from "../src/mqtt-client.js";
import { startSimPrinter } from "../sim/printer.mjs";

type Sim = Awaited<ReturnType<typeof startSimPrinter>>;

let sim: Sim;
const clients: BambuMqttClient[] = [];

function newClient(overrides: { accessCode?: string; port?: number } = {}): BambuMqttClient {
  const client = new BambuMqttClient(
    sim.host,
    sim.serial,
    overrides.accessCode ?? sim.accessCode,
    { port: overrides.port ?? sim.port, connectTimeoutMs: 1500, reconnectPeriodMs: 200 },
  );
  client.on("error", () => {});
  clients.push(client);
  return client;
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  sim = await startSimPrinter();
});

afterEach(() => {
  while (clients.length) clients.pop()!.disconnect();
});

afterAll(async () => {
  await sim.close();
});

describe("BambuMqttClient against the simulated printer", () => {
  it("connects and reads a full status report", async () => {
    const client = newClient();
    await client.connect();
    const report = await client.requestFullStatus();
    expect(report.gcode_state).toBe("RUNNING");
    expect(report.subtask_name).toBe("3DBenchy");
    expect(report.ams?.ams[0].tray).toHaveLength(4);
  });

  it("delivers commands to the printer", async () => {
    const client = newClient();
    await client.connect();
    const before = sim.commands.length;
    await client.publishCommand({ topic: "print", body: { command: "print_speed", param: "3" } });
    await waitFor(() => sim.commands.length > before);
    expect(sim.commands.at(-1)).toMatchObject({ print: { command: "print_speed", param: "3" } });
    expect(sim.commands.at(-1)?.print?.sequence_id).toMatch(/^\d+$/);
  });

  it("rejects a wrong access code with an actionable message", async () => {
    const client = newClient({ accessCode: "00000000" });
    await expect(client.connect()).rejects.toThrow(/access code/i);
  });

  it("two clients for the same printer don't kick each other off", async () => {
    // Claude Desktop and Claude Code can run the server at the same time.
    // MQTT brokers drop the older connection when a client ID is reused.
    const a = newClient();
    const b = newClient();
    await a.connect();
    await b.connect();
    await new Promise((r) => setTimeout(r, 300));
    expect(a.isConnected()).toBe(true);
    expect(b.isConnected()).toBe(true);
  });

  it("returns the cached snapshot flagged stale when the printer stops answering", async () => {
    const client = newClient();
    await client.connect();
    await client.requestFullStatus();
    sim.setRespondToPushall(false);
    try {
      const report = await client.requestFullStatus();
      expect(report.stale).toBe(true);
      expect(report.gcode_state).toBe("RUNNING");
    } finally {
      sim.setRespondToPushall(true);
    }
  }, 10_000);
});

describe("BambuMqttClient when the printer is unreachable", () => {
  // A TCP server that accepts the connection and then never speaks — what a
  // half-asleep printer or a wrong-but-alive IP looks like to mqtt.js.
  let blackhole: Server;
  let blackholePort: number;
  let opened = 0;
  const sockets = new Set<Socket>();

  beforeAll(async () => {
    blackhole = createServer((s) => {
      opened++;
      sockets.add(s);
      s.on("error", () => {});
    });
    await new Promise<void>((r) => blackhole.listen(0, "127.0.0.1", () => r()));
    blackholePort = (blackhole.address() as { port: number }).port;
  });

  afterAll(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => blackhole.close(r));
  });

  it("connect() rejects instead of hanging forever", async () => {
    const client = newClient({ port: blackholePort });
    const result = await Promise.race([
      client.connect().then(
        () => "connected",
        (err: Error) => `rejected: ${err.message}`,
      ),
      new Promise((r) => setTimeout(() => r("still pending"), 5000)),
    ]);
    expect(result).toMatch(/^rejected: .*Could not reach the printer/);
  }, 10_000);

  it("a failed connect() leaves no reconnect loop behind", async () => {
    const client = newClient({ port: blackholePort });
    const before = opened;
    await client.connect().catch(() => {});
    await client.connect().catch(() => {});
    expect(opened - before).toBe(2);
    // A leaked mqtt.js client would keep reconnecting every 200 ms.
    await new Promise((r) => setTimeout(r, 1000));
    expect(opened - before).toBe(2);
  }, 15_000);
});
