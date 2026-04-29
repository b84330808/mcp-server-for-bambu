import { describe, it, expect } from "vitest";
import {
  cmdPause,
  cmdResume,
  cmdStop,
  cmdSetLight,
  cmdSetSpeed,
  cmdGcode,
  cmdAmsChangeFilament,
  cmdPreheat,
} from "../src/commands.js";

describe("command builders", () => {
  it("pause/resume/stop go on the print topic", () => {
    expect(cmdPause()).toEqual({ topic: "print", body: { command: "pause" } });
    expect(cmdResume()).toEqual({ topic: "print", body: { command: "resume" } });
    expect(cmdStop()).toEqual({ topic: "print", body: { command: "stop" } });
  });

  it("set_light goes on the system topic with the right node + mode", () => {
    const cmd = cmdSetLight("chamber_light", true);
    expect(cmd.topic).toBe("system");
    expect(cmd.body.command).toBe("ledctrl");
    expect(cmd.body.led_node).toBe("chamber_light");
    expect(cmd.body.led_mode).toBe("on");

    expect(cmdSetLight("chamber_light", false).body.led_mode).toBe("off");
  });

  it("set_speed coerces to string param", () => {
    expect(cmdSetSpeed(2)).toEqual({
      topic: "print",
      body: { command: "print_speed", param: "2" },
    });
  });

  it("gcode appends a trailing newline if missing", () => {
    expect(cmdGcode("G28").body.param).toBe("G28\n");
    expect(cmdGcode("G28\n").body.param).toBe("G28\n");
  });

  it("gcode supports multiple lines", () => {
    const cmd = cmdGcode("M104 S210\nM140 S60");
    expect(cmd.body.param).toBe("M104 S210\nM140 S60\n");
  });

  it("ams_change_filament includes ams_id and slot_id", () => {
    const cmd = cmdAmsChangeFilament(0, 2);
    expect(cmd.body.command).toBe("ams_change_filament");
    expect(cmd.body.ams_id).toBe(0);
    expect(cmd.body.slot_id).toBe(2);
    expect(cmd.body.target).toBe(2);
  });

  it("preheat builds Marlin gcode for both temps", () => {
    const cmd = cmdPreheat(210, 60);
    expect(cmd.body.param).toContain("M104 S210");
    expect(cmd.body.param).toContain("M140 S60");
  });

  it("preheat with only nozzle skips bed line", () => {
    const cmd = cmdPreheat(210);
    expect(cmd.body.param).toContain("M104 S210");
    expect(cmd.body.param).not.toContain("M140");
  });

  it("preheat rounds non-integer temps", () => {
    expect(cmdPreheat(209.7).body.param).toContain("M104 S210");
  });
});
