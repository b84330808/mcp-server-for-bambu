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
    // HMS_0700_2000_0002_0001: attr top byte 0x07 = AMS; the severity is the
    // high 16 bits of `code` (2 = serious), as ha-bambulab decodes it.
    const d = describeHms({ attr: 0x07_00_20_00, code: 0x00_02_00_01 });
    expect(d.module).toContain("AMS");
    expect(d.severity).toBe("SERIOUS");
    expect(d.code).toBe("HMS_0700_2000_0002_0001");
    expect(d.wikiUrl).toContain("wiki.bambulab.com");
  });

  it("reads severity from the code field, not the attr field", () => {
    // attr's low nibble is part of the error id, not the severity.
    expect(describeHms({ attr: 0x03_00_01_03, code: 0x00_01_00_07 }).severity).toBe("FATAL");
    expect(describeHms({ attr: 0x05_00_00_00, code: 0x00_04_00_02 }).severity).toBe("INFO");
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
