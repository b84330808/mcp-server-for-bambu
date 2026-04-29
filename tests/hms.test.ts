import { describe, it, expect } from "vitest";
import { describePrintError, describeHms } from "../src/hms.js";

describe("describePrintError", () => {
  it("returns null for code 0 / undefined", () => {
    expect(describePrintError(0)).toBeNull();
    expect(describePrintError(undefined)).toBeNull();
  });

  it("returns a known label for known codes", () => {
    expect(describePrintError(0x05000001)).toContain("Filament runout");
  });

  it("returns 'Unknown error' for unrecognized codes", () => {
    const out = describePrintError(0xDEADBEEF);
    expect(out).toContain("Unknown");
    expect(out).toContain("DEADBEEF");
  });
});

describe("describeHms", () => {
  it("decodes a typical AMS warning", () => {
    // attr top byte 0x07 = AMS, severity 3 = WARNING
    const d = describeHms({ attr: 0x07_00_00_03, code: 0x00_01_00_07 });
    expect(d.module).toContain("AMS");
    expect(d.severity).toBe("WARNING");
    expect(d.code).toMatch(/^HMS_/);
    expect(d.wikiUrl).toContain("wiki.bambulab.com");
  });

  it("falls back gracefully on unknown module / severity", () => {
    const d = describeHms({ attr: 0xff_00_00_09, code: 0 });
    expect(d.module).toContain("0xff");
    expect(d.severity).toContain("level");
  });

  it("formats the wiki URL with all 4 hex segments", () => {
    const d = describeHms({ attr: 0x05_00_00_01, code: 0x00_07_00_03 });
    expect(d.wikiUrl).toMatch(/[0-9A-F]{4}_[0-9A-F]{4}_[0-9A-F]{4}_[0-9A-F]{4}$/);
  });
});
