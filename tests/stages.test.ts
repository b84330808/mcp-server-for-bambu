import { describe, it, expect } from "vitest";
import { describeStage, describeSpeed, CURRENT_STAGE_IDS } from "../src/stages.js";

describe("describeStage", () => {
  it("returns null for undefined", () => {
    expect(describeStage(undefined)).toBeNull();
  });

  it("maps -1 to idle", () => {
    expect(describeStage(-1)).toBe("idle");
  });

  it("maps known stages to descriptions", () => {
    expect(describeStage(0)).toBe("printing");
    expect(describeStage(7)).toContain("hotend");
    expect(describeStage(13)).toContain("homing");
    expect(describeStage(35)).toContain("clog");
  });

  it("falls back to a stable label for unknown codes", () => {
    expect(describeStage(9999)).toBe("stage 9999");
  });

  it("has the documented full set of stage codes", () => {
    expect(Object.keys(CURRENT_STAGE_IDS).length).toBeGreaterThanOrEqual(78);
  });
});

describe("describeSpeed", () => {
  it("maps the 4 documented profiles", () => {
    expect(describeSpeed(1)).toBe("silent");
    expect(describeSpeed(2)).toBe("standard");
    expect(describeSpeed(3)).toBe("sport");
    expect(describeSpeed(4)).toBe("ludicrous");
  });

  it("returns null for undefined", () => {
    expect(describeSpeed(undefined)).toBeNull();
  });

  it("falls back to a stable label for unknown levels", () => {
    expect(describeSpeed(99)).toBe("level 99");
  });
});
