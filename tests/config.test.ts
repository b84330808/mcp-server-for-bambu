import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLanAddress, loadConfig, migrateLegacyLedger } from "../src/config.js";
import { configDir } from "../src/paths.js";
import { describeTrayNow } from "../src/stages.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bambu-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("reads credentials from the config-dir .env", () => {
    writeFileSync(join(dir, ".env"), "BAMBU_IP=192.168.1.9\nBAMBU_SERIAL=01P00A000000001\nBAMBU_ACCESS_CODE=abcdefgh\n");
    const c = loadConfig({ BAMBU_CONFIG_DIR: dir });
    expect(c).toMatchObject({ ip: "192.168.1.9", serial: "01P00A000000001", accessCode: "abcdefgh", port: 8883 });
    expect(c.ledgerPath).toBe(join(dir, "maintenance.json"));
    expect(c.envPath).toBe(join(dir, ".env"));
  });

  it("lets env vars override the file", () => {
    writeFileSync(join(dir, ".env"), "BAMBU_IP=192.168.1.9\n");
    expect(loadConfig({ BAMBU_CONFIG_DIR: dir, BAMBU_IP: "10.0.0.5" }).ip).toBe("10.0.0.5");
  });

  it("ignores empty values and unexpanded ${...} placeholders", () => {
    // A client that substitutes nothing must not mask what setup_printer saved.
    writeFileSync(join(dir, ".env"), "BAMBU_IP=192.168.1.9\nBAMBU_ACCESS_CODE=abcdefgh\n");
    const c = loadConfig({ BAMBU_CONFIG_DIR: dir, BAMBU_IP: "", BAMBU_ACCESS_CODE: "${user_config.access_code}" });
    expect(c.ip).toBe("192.168.1.9");
    expect(c.accessCode).toBe("abcdefgh");
  });

  it("accepts the PRINTER_* names older READMEs documented", () => {
    const c = loadConfig({
      BAMBU_CONFIG_DIR: dir,
      PRINTER_IP: "192.168.1.50",
      PRINTER_SERIAL: "01P00A1234567890",
      PRINTER_ACCESS_CODE: "12345678",
    });
    expect(c).toMatchObject({ ip: "192.168.1.50", serial: "01P00A1234567890", accessCode: "12345678" });
  });

  it("parses BAMBU_READ_ONLY and BAMBU_MQTT_PORT", () => {
    expect(loadConfig({ BAMBU_CONFIG_DIR: dir, BAMBU_READ_ONLY: "true" }).readOnly).toBe(true);
    expect(loadConfig({ BAMBU_CONFIG_DIR: dir, BAMBU_READ_ONLY: "0" }).readOnly).toBe(false);
    expect(loadConfig({ BAMBU_CONFIG_DIR: dir, BAMBU_MQTT_PORT: "18883" }).port).toBe(18883);
    expect(loadConfig({ BAMBU_CONFIG_DIR: dir, BAMBU_MQTT_PORT: "nope" }).port).toBe(8883);
  });
});

describe("configDir", () => {
  it("uses a per-user directory outside the package", () => {
    expect(configDir({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32")).toMatch(/Roaming[\\/]mcp-server-for-bambu$/);
    expect(configDir({}, "darwin")).toMatch(/Library[\\/]Application Support[\\/]mcp-server-for-bambu$/);
    expect(configDir({ XDG_CONFIG_HOME: "/xdg" }, "linux")).toMatch(/xdg[\\/]mcp-server-for-bambu$/);
    expect(configDir({ BAMBU_CONFIG_DIR: dir }, "linux")).toBe(dir);
  });
});

describe("migrateLegacyLedger", () => {
  it("copies an old ledger once and never overwrites a new one", () => {
    const legacy = join(dir, "old.json");
    const target = join(dir, "nested", "maintenance.json");
    writeFileSync(legacy, '{"totalPrintMinutes":42}');
    expect(migrateLegacyLedger(target, legacy)).toBe(true);
    expect(readFileSync(target, "utf-8")).toContain("42");
    writeFileSync(legacy, '{"totalPrintMinutes":1}');
    expect(migrateLegacyLedger(target, legacy)).toBe(false);
    expect(readFileSync(target, "utf-8")).toContain("42");
    expect(existsSync(legacy)).toBe(true);
  });
});

describe("isLanAddress", () => {
  it("accepts private, loopback, link-local and CGNAT ranges", () => {
    for (const ip of ["192.168.1.50", "10.0.0.1", "172.16.0.1", "172.31.255.255", "127.0.0.1", "169.254.1.1", "100.101.102.103"]) {
      expect(isLanAddress(ip), ip).toBe(true);
    }
  });

  it("rejects public addresses and junk", () => {
    for (const ip of ["8.8.8.8", "172.32.0.1", "1.2.3.4", "192.169.0.1", "300.1.1.1", "printer.local", ""]) {
      expect(isLanAddress(ip), ip).toBe(false);
    }
  });
});

describe("describeTrayNow", () => {
  it("decodes the global tray index", () => {
    expect(describeTrayNow("0")).toBe("AMS 0 slot 0");
    expect(describeTrayNow("6")).toBe("AMS 1 slot 2");
    expect(describeTrayNow("254")).toBe("external spool");
    expect(describeTrayNow("255")).toBe("none loaded");
    expect(describeTrayNow(undefined)).toBeNull();
  });
});
