import type { HmsWarning } from "./types.js";

// Bambu print_error code → human-readable label.
// This is a small curated subset — Bambu publishes a much larger HMS table,
// but most users only ever see a handful of codes in practice. Unknown codes
// are returned as-is so we don't silently swallow them.
const PRINT_ERRORS: Record<number, string> = {
  0: "No error",
  0x0500_0001: "Filament runout (AMS)",
  0x0500_0003: "Filament tangle / feed jam (AMS)",
  0x0300_4001: "Hotend temperature error",
  0x0300_4002: "Bed temperature error",
  0x0500_4001: "Nozzle clog suspected",
  0x07ff_8003: "Nozzle wipe failed",
  0x12_00_4001: "First layer inspection failed",
};

export function describePrintError(code: number | undefined): string | null {
  if (code == null || code === 0) return null;
  const known = PRINT_ERRORS[code];
  if (known) return `${known} (0x${code.toString(16).toUpperCase()})`;
  return `Unknown error code 0x${code.toString(16).toUpperCase()}`;
}

// HMS module IDs — top byte of the `attr` field. Sourced from ha-bambulab.
const HMS_MODULES: Record<number, string> = {
  0x03: "MC (motion controller)",
  0x05: "Mainboard",
  0x07: "AMS",
  0x08: "Toolhead",
  0x0c: "XCam",
};

// HMS severity is encoded in the lower bits of `attr`.
// Bambu uses: 1=fatal, 2=serious, 3=common, 4=info (per community refs).
const HMS_SEVERITY: Record<number, string> = {
  1: "FATAL",
  2: "SERIOUS",
  3: "WARNING",
  4: "INFO",
};

export interface DescribedHms {
  severity: string;
  module: string;
  code: string;     // formatted "HMS_AAAA_BBBB_CCCC_DDDD"
  wikiUrl: string;  // direct link to Bambu's HMS wiki page for this code
}

// Decode an HMS warning entry into a human-readable description plus a
// link to Bambu's official wiki (which has full instructions per code).
export function describeHms(entry: HmsWarning): DescribedHms {
  const moduleId = (entry.attr >>> 24) & 0xff;
  const severityId = entry.attr & 0xf;
  const aaaa = ((entry.attr >>> 16) & 0xffff).toString(16).toUpperCase().padStart(4, "0");
  const bbbb = (entry.attr & 0xffff).toString(16).toUpperCase().padStart(4, "0");
  const cccc = ((entry.code >>> 16) & 0xffff).toString(16).toUpperCase().padStart(4, "0");
  const dddd = (entry.code & 0xffff).toString(16).toUpperCase().padStart(4, "0");

  return {
    severity: HMS_SEVERITY[severityId] ?? `level ${severityId}`,
    module: HMS_MODULES[moduleId] ?? `module 0x${moduleId.toString(16)}`,
    code: `HMS_${aaaa}_${bbbb}_${cccc}_${dddd}`,
    wikiUrl: `https://wiki.bambulab.com/en/x1/troubleshooting/hmscode/${aaaa}_${bbbb}_${cccc}_${dddd}`,
  };
}
