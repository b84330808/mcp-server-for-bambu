import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MaintenanceTracker } from "../src/maintenance.js";
import type { PrinterReport, MaintenanceLedger } from "../src/types.js";
import { MAINTENANCE_THRESHOLDS } from "../src/types.js";

let tmpDir: string;
let ledgerPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "bambu-test-"));
  ledgerPath = join(tmpDir, "maintenance.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function report(over: Partial<PrinterReport>): PrinterReport {
  return { gcode_state: "IDLE", ...over };
}

describe("MaintenanceTracker", () => {
  it("creates a default ledger when file doesn't exist", () => {
    const t = new MaintenanceTracker(ledgerPath);
    const l = t.getLedger();
    expect(l.totalPrintMinutes).toBe(0);
    expect(l.sessions).toEqual([]);
    expect(l.maintenanceCompletedAt).toEqual({});
  });

  it("migrates a ledger that lacks maintenanceCompletedAt", () => {
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        totalPrintMinutes: 60,
        sessions: [],
        lastUpdated: "2026-01-01T00:00:00Z",
      }),
    );
    const t = new MaintenanceTracker(ledgerPath);
    expect(t.getLedger().maintenanceCompletedAt).toEqual({});
    expect(t.getLedger().totalPrintMinutes).toBe(60);
  });

  it("falls back to default ledger if JSON is corrupt", () => {
    writeFileSync(ledgerPath, "{not json");
    const t = new MaintenanceTracker(ledgerPath);
    expect(t.getLedger().totalPrintMinutes).toBe(0);
  });

  it("starts a session on RUNNING and finalizes on FINISH", () => {
    const t = new MaintenanceTracker(ledgerPath);
    t.onStatusUpdate(
      report({ gcode_state: "RUNNING", mc_remaining_time: 60, mc_percent: 0 }),
    );
    expect(t.generateReport().hasActiveSession).toBe(true);

    // Half-way through
    t.onStatusUpdate(
      report({ gcode_state: "RUNNING", mc_remaining_time: 30, mc_percent: 50 }),
    );
    // Finish
    t.onStatusUpdate(report({ gcode_state: "FINISH", mc_remaining_time: 0 }));

    const r = t.generateReport();
    expect(r.hasActiveSession).toBe(false);
    expect(r.totalPrintMinutes).toBe(60);
    expect(r.sessionCount).toBe(1);
  });

  it("estimates startMinutes when first RUNNING report has 0 remaining", () => {
    const t = new MaintenanceTracker(ledgerPath);
    // Edge case: connected mid-print, first RUNNING report has remaining=0
    t.onStatusUpdate(
      report({ gcode_state: "RUNNING", mc_remaining_time: 0, mc_percent: 0 }),
    );
    // Then a real report comes in: 25% done, 90 min remaining → total ~120 min
    t.onStatusUpdate(
      report({ gcode_state: "RUNNING", mc_remaining_time: 90, mc_percent: 25 }),
    );
    t.onStatusUpdate(report({ gcode_state: "FINISH", mc_remaining_time: 0 }));
    const r = t.generateReport();
    // Estimated total was 90 / 0.75 = 120, so logged duration should be ~120
    expect(r.totalPrintMinutes).toBeGreaterThan(100);
    expect(r.totalPrintMinutes).toBeLessThanOrEqual(120);
  });

  it("checkpoints active session every 5 elapsed minutes", () => {
    const t = new MaintenanceTracker(ledgerPath);
    t.onStatusUpdate(
      report({ gcode_state: "RUNNING", mc_remaining_time: 60, mc_percent: 0 }),
    );
    // Initial start triggers a save → file should exist with active session
    expect(existsSync(ledgerPath)).toBe(true);
    let saved = JSON.parse(readFileSync(ledgerPath, "utf-8")) as MaintenanceLedger;
    expect(saved.activeSession).toBeDefined();

    // 4 minutes elapsed → no checkpoint yet
    t.onStatusUpdate(
      report({ gcode_state: "RUNNING", mc_remaining_time: 56, mc_percent: 7 }),
    );
    saved = JSON.parse(readFileSync(ledgerPath, "utf-8")) as MaintenanceLedger;
    expect(saved.activeSession?.durationMinutes).toBe(0);

    // 6 minutes elapsed → should checkpoint
    t.onStatusUpdate(
      report({ gcode_state: "RUNNING", mc_remaining_time: 54, mc_percent: 10 }),
    );
    saved = JSON.parse(readFileSync(ledgerPath, "utf-8")) as MaintenanceLedger;
    expect(saved.activeSession?.durationMinutes).toBe(6);
  });

  it("recovers an active session from disk on restart", () => {
    const t1 = new MaintenanceTracker(ledgerPath);
    t1.onStatusUpdate(
      report({ gcode_state: "RUNNING", mc_remaining_time: 60, mc_percent: 0 }),
    );
    t1.onStatusUpdate(
      report({ gcode_state: "RUNNING", mc_remaining_time: 50, mc_percent: 17 }),
    );
    // Simulate process death — new tracker on same file
    const t2 = new MaintenanceTracker(ledgerPath);
    expect(t2.generateReport().hasActiveSession).toBe(true);

    // Print finishes
    t2.onStatusUpdate(report({ gcode_state: "FINISH", mc_remaining_time: 0 }));
    const r = t2.generateReport();
    expect(r.hasActiveSession).toBe(false);
    expect(r.totalPrintMinutes).toBe(60);
  });

  it("finalizeRecoveredSessionIfIdle credits a crashed-then-finished print", () => {
    const t1 = new MaintenanceTracker(ledgerPath);
    t1.onStatusUpdate(
      report({ gcode_state: "RUNNING", mc_remaining_time: 30, mc_percent: 0 }),
    );
    t1.onStatusUpdate(
      report({ gcode_state: "RUNNING", mc_remaining_time: 25, mc_percent: 17 }),
    );

    // Restart — printer is now IDLE (print finished while we were down)
    const t2 = new MaintenanceTracker(ledgerPath);
    expect(t2.generateReport().hasActiveSession).toBe(true);

    t2.finalizeRecoveredSessionIfIdle("IDLE");
    const r = t2.generateReport();
    expect(r.hasActiveSession).toBe(false);
    // Should be at least the last checkpointed durationMinutes, capped at startMinutes
    expect(r.totalPrintMinutes).toBeGreaterThanOrEqual(5);
    expect(r.totalPrintMinutes).toBeLessThanOrEqual(30);
  });

  it("finalizeRecoveredSessionIfIdle is a no-op if printer is still RUNNING", () => {
    const t1 = new MaintenanceTracker(ledgerPath);
    t1.onStatusUpdate(
      report({ gcode_state: "RUNNING", mc_remaining_time: 30, mc_percent: 0 }),
    );
    const t2 = new MaintenanceTracker(ledgerPath);
    t2.finalizeRecoveredSessionIfIdle("RUNNING");
    expect(t2.generateReport().hasActiveSession).toBe(true);
    expect(t2.generateReport().totalPrintMinutes).toBe(0);
  });

  it("flags maintenance tasks as OVERDUE when threshold exceeded", () => {
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        totalPrintMinutes: MAINTENANCE_THRESHOLDS.CLEAN_CARBON_RODS_MINUTES + 10,
        sessions: [],
        lastUpdated: new Date().toISOString(),
        maintenanceCompletedAt: {},
      }),
    );
    const t = new MaintenanceTracker(ledgerPath);
    const r = t.generateReport();
    const carbon = r.checks.find((c) => c.id === "clean_carbon_rods");
    expect(carbon?.status).toBe("OVERDUE");
    expect(r.warnings.some((w) => /OVERDUE/.test(w))).toBe(true);
  });

  it("flags DUE_SOON when within 10 hours of threshold", () => {
    // Set total = threshold - 5h so countdown = 5h, which is < 10h → DUE_SOON
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        totalPrintMinutes: MAINTENANCE_THRESHOLDS.LUBE_RAILS_MINUTES - 5 * 60,
        sessions: [],
        lastUpdated: new Date().toISOString(),
        maintenanceCompletedAt: {},
      }),
    );
    const t = new MaintenanceTracker(ledgerPath);
    const r = t.generateReport();
    const lube = r.checks.find((c) => c.id === "lube_rails");
    expect(lube?.status).toBe("DUE_SOON");
  });

  it("markTaskDone resets the countdown", () => {
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        totalPrintMinutes: MAINTENANCE_THRESHOLDS.CLEAN_CARBON_RODS_MINUTES + 60,
        sessions: [],
        lastUpdated: new Date().toISOString(),
        maintenanceCompletedAt: {},
      }),
    );
    const t = new MaintenanceTracker(ledgerPath);
    expect(t.generateReport().checks.find((c) => c.id === "clean_carbon_rods")?.status).toBe(
      "OVERDUE",
    );
    t.markTaskDone("clean_carbon_rods");
    expect(t.generateReport().checks.find((c) => c.id === "clean_carbon_rods")?.status).toBe(
      "OK",
    );
  });

  it("markTaskDone with hoursAgo back-dates the completion", () => {
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        totalPrintMinutes: 100 * 60, // 100h
        sessions: [],
        lastUpdated: new Date().toISOString(),
        maintenanceCompletedAt: {},
      }),
    );
    const t = new MaintenanceTracker(ledgerPath);
    t.markTaskDone("lube_rails", 50); // "I oiled them 50 print-hours ago"
    const completedAt = t.getLedger().maintenanceCompletedAt["lube_rails"];
    expect(completedAt).toBe(50 * 60); // 100h - 50h = 50h
  });

  it("markTaskDone returns false for unknown task ids", () => {
    const t = new MaintenanceTracker(ledgerPath);
    expect(t.markTaskDone("not_a_real_task")).toBe(false);
  });

  it("caps stored sessions to the last 100 to bound file size", () => {
    const t = new MaintenanceTracker(ledgerPath);
    for (let i = 0; i < 105; i++) {
      t.onStatusUpdate(
        report({ gcode_state: "RUNNING", mc_remaining_time: 1, mc_percent: 0 }),
      );
      t.onStatusUpdate(report({ gcode_state: "FINISH", mc_remaining_time: 0 }));
    }
    expect(t.getLedger().sessions.length).toBe(100);
  });

  it("uses atomic writes (no half-written file on crash)", () => {
    const t = new MaintenanceTracker(ledgerPath);
    t.markTaskDone("lube_rails");
    // After save the .tmp file should not exist
    expect(existsSync(`${ledgerPath}.tmp`)).toBe(false);
    expect(existsSync(ledgerPath)).toBe(true);
    // File should be valid JSON
    expect(() =>
      JSON.parse(readFileSync(ledgerPath, "utf-8")),
    ).not.toThrow();
  });

  it("getRecentSessions returns newest first, capped at limit", () => {
    const sessions = Array.from({ length: 5 }, (_, i) => ({
      startedAt: `2026-01-0${i + 1}T00:00:00Z`,
      endedAt: `2026-01-0${i + 1}T01:00:00Z`,
      durationMinutes: 60,
      subtaskName: `print-${i}`,
    }));
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        totalPrintMinutes: 300,
        sessions,
        lastUpdated: new Date().toISOString(),
        maintenanceCompletedAt: {},
      }),
    );
    const t = new MaintenanceTracker(ledgerPath);
    const recent = t.getRecentSessions(3);
    expect(recent).toHaveLength(3);
    expect(recent[0].subtaskName).toBe("print-4");
    expect(recent[2].subtaskName).toBe("print-2");
  });

  it("forecast returns OVERDUE eta=0 for tasks past threshold", () => {
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        totalPrintMinutes: MAINTENANCE_THRESHOLDS.CLEAN_CARBON_RODS_MINUTES + 60,
        sessions: [],
        lastUpdated: new Date().toISOString(),
        maintenanceCompletedAt: {},
      }),
    );
    const t = new MaintenanceTracker(ledgerPath);
    const forecasts = t.forecast(14);
    const carbon = forecasts.find((f) => f.id === "clean_carbon_rods")!;
    expect(carbon.minutesUntilDue).toBeLessThan(0);
    expect(carbon.etaDays).toBe(0);
  });

  it("forecast returns null etaDays when no recent prints", () => {
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        totalPrintMinutes: 60,
        sessions: [],
        lastUpdated: new Date().toISOString(),
        maintenanceCompletedAt: {},
      }),
    );
    const t = new MaintenanceTracker(ledgerPath);
    const forecasts = t.forecast(14);
    expect(forecasts.every((f) => f.etaDays === null || f.etaDays === 0)).toBe(true);
  });

  it("forecast extrapolates etaDays from recent print rate", () => {
    // 14 days of 60 min/day = 840 minutes recent. Lube threshold is 200h = 12000 min.
    // Total at 100h cumulative → 6000 min remaining → 6000 / 60 = 100 days
    const now = new Date();
    const sessions = Array.from({ length: 14 }, (_, i) => {
      const day = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      return {
        startedAt: day.toISOString(),
        endedAt: day.toISOString(),
        durationMinutes: 60,
        subtaskName: `daily-${i}`,
      };
    });
    writeFileSync(
      ledgerPath,
      JSON.stringify({
        totalPrintMinutes: 100 * 60,
        sessions,
        lastUpdated: now.toISOString(),
        maintenanceCompletedAt: {},
      }),
    );
    const t = new MaintenanceTracker(ledgerPath);
    const forecasts = t.forecast(14);
    const lube = forecasts.find((f) => f.id === "lube_rails")!;
    expect(lube.etaDays).toBeGreaterThan(80);
    expect(lube.etaDays).toBeLessThan(120);
    expect(lube.recentDailyMinutes).toBe(60);
  });
});
