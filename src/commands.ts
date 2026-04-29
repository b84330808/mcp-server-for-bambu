// Builders for the MQTT command payloads we send to the printer.
// Sourced from greghesp/ha-bambulab pybambu/commands.py + community refs.
//
// All payloads carry a `sequence_id`. The client fills it in before publish.

export type LightNode = "chamber_light" | "work_light";
export type SpeedLevel = 1 | 2 | 3 | 4; // silent / standard / sport / ludicrous

export interface CommandEnvelope {
  topic: "print" | "system";
  body: Record<string, unknown>;
}

export const cmdPause = (): CommandEnvelope => ({
  topic: "print",
  body: { command: "pause" },
});

export const cmdResume = (): CommandEnvelope => ({
  topic: "print",
  body: { command: "resume" },
});

export const cmdStop = (): CommandEnvelope => ({
  topic: "print",
  body: { command: "stop" },
});

export const cmdSetLight = (node: LightNode, on: boolean): CommandEnvelope => ({
  topic: "system",
  body: {
    command: "ledctrl",
    led_node: node,
    led_mode: on ? "on" : "off",
    led_on_time: 500,
    led_off_time: 500,
    loop_times: 0,
    interval_time: 0,
  },
});

export const cmdSetSpeed = (level: SpeedLevel): CommandEnvelope => ({
  topic: "print",
  body: { command: "print_speed", param: String(level) },
});

export const cmdGcode = (gcode: string): CommandEnvelope => ({
  topic: "print",
  body: { command: "gcode_line", param: gcode.endsWith("\n") ? gcode : `${gcode}\n` },
});

export const cmdAmsChangeFilament = (
  amsId: number,
  slotId: number,
): CommandEnvelope => ({
  topic: "print",
  body: {
    command: "ams_change_filament",
    target: slotId, // target tray (0-indexed within the AMS unit)
    curr_temp: 0,
    tar_temp: 0,
    ams_id: amsId,
    slot_id: slotId,
  },
});

// Convenience: build a Marlin-style preheat as a gcode_line.
export const cmdPreheat = (
  nozzleC?: number,
  bedC?: number,
): CommandEnvelope => {
  const lines: string[] = [];
  if (nozzleC != null) lines.push(`M104 S${Math.round(nozzleC)}`);
  if (bedC != null) lines.push(`M140 S${Math.round(bedC)}`);
  return cmdGcode(lines.join("\n"));
};
