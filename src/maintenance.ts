import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "fs";
import { dirname } from "path";
import type {
  ActiveSessionSnapshot,
  MaintenanceLedger,
  PrintSession,
  PrinterReport,
} from "./types.js";
import { MAINTENANCE_THRESHOLDS } from "./types.js";

// Persist the active session at most once per this many minutes of progress
// to bound write amplification while still surviving crashes.
const CHECKPOINT_INTERVAL_MINUTES = 5;

function defaultLedger(): MaintenanceLedger {
  return {
    totalPrintMinutes: 0,
    sessions: [],
    lastUpdated: new Date().toISOString(),
    maintenanceCompletedAt: {},
  };
}

export class MaintenanceTracker {
  private readonly ledgerPath: string;
  private ledger: MaintenanceLedger;
  private activeSession: (PrintSession & { startMinutes: number }) | null = null;
  private lastCheckpointMinutes = 0;

  constructor(ledgerPath: string) {
    this.ledgerPath = ledgerPath;
    this.ledger = this.load();
    // Recover an in-flight session if the process died mid-print.
    if (this.ledger.activeSession) {
      this.activeSession = {
        startedAt: this.ledger.activeSession.startedAt,
        durationMinutes: this.ledger.activeSession.durationMinutes,
        subtaskName: this.ledger.activeSession.subtaskName,
        startMinutes: this.ledger.activeSession.startMinutes,
      };
      this.lastCheckpointMinutes = this.activeSession.durationMinutes;
    }
  }

  private load(): MaintenanceLedger {
    if (!existsSync(this.ledgerPath)) {
      return defaultLedger();
    }
    try {
      const raw = JSON.parse(readFileSync(this.ledgerPath, "utf-8")) as MaintenanceLedger;
      // Migrate older ledger files that predate maintenanceCompletedAt
      if (!raw.maintenanceCompletedAt) raw.maintenanceCompletedAt = {};
      return raw;
    } catch {
      return defaultLedger();
    }
  }

  private save(): void {
    this.ledger.lastUpdated = new Date().toISOString();
    // Make sure the parent dir exists (handles a custom MAINTENANCE_LEDGER_PATH
    // pointing at a nested directory that the user hasn't created).
    mkdirSync(dirname(this.ledgerPath), { recursive: true });
    // Atomic write: rename is atomic on the same filesystem, so a crash
    // mid-write can't leave a half-truncated ledger file.
    const tmp = `${this.ledgerPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.ledger, null, 2), "utf-8");
    renameSync(tmp, this.ledgerPath);
  }

  private snapshotActiveSession(): ActiveSessionSnapshot | undefined {
    if (!this.activeSession) return undefined;
    return {
      startedAt: this.activeSession.startedAt,
      startMinutes: this.activeSession.startMinutes,
      durationMinutes: this.activeSession.durationMinutes,
      subtaskName: this.activeSession.subtaskName,
      lastCheckpointAt: new Date().toISOString(),
    };
  }

  // Call on every MQTT status update to track active print sessions.
  onStatusUpdate(report: PrinterReport): void {
    const state = report.gcode_state ?? "IDLE";
    const isRunning = state === "RUNNING";
    const remainingMinutes = report.mc_remaining_time ?? 0;
    const progressPct = report.mc_percent ?? 0;

    if (isRunning && !this.activeSession) {
      // Print just started
      this.activeSession = {
        startedAt: new Date().toISOString(),
        durationMinutes: 0,
        subtaskName: report.subtask_name,
        startMinutes: remainingMinutes,
      };
      this.lastCheckpointMinutes = 0;
      this.ledger.activeSession = this.snapshotActiveSession();
      this.save();
    } else if (!isRunning && this.activeSession) {
      // Print just ended (finished, paused-then-done, or cancelled)
      const elapsed = Math.max(
        this.activeSession.startMinutes - remainingMinutes,
        0,
      );
      const session: PrintSession = {
        startedAt: this.activeSession.startedAt,
        endedAt: new Date().toISOString(),
        durationMinutes: elapsed || this.activeSession.durationMinutes,
        subtaskName: this.activeSession.subtaskName,
      };

      this.ledger.totalPrintMinutes += session.durationMinutes;
      // Keep only last 100 sessions to bound file size
      this.ledger.sessions = [...this.ledger.sessions.slice(-99), session];
      this.activeSession = null;
      this.lastCheckpointMinutes = 0;
      delete this.ledger.activeSession;
      this.save();
    } else if (isRunning && this.activeSession) {
      // Update running elapsed estimate for the report (not persisted until done).
      // startMinutes is fixed at session start; only refine it once when we have
      // enough data (progress > 0) to avoid drift on every tick.
      if (this.activeSession.startMinutes === 0 && progressPct > 0 && remainingMinutes > 0) {
        const estimatedTotal =
          progressPct < 100
            ? remainingMinutes / (1 - progressPct / 100)
            : remainingMinutes;
        this.activeSession.startMinutes = Math.round(estimatedTotal);
      }
      const elapsed = Math.max(this.activeSession.startMinutes - remainingMinutes, 0);
      this.activeSession.durationMinutes = elapsed;

      // Periodically checkpoint so a crash mid-print doesn't lose the session.
      if (elapsed - this.lastCheckpointMinutes >= CHECKPOINT_INTERVAL_MINUTES) {
        this.lastCheckpointMinutes = elapsed;
        this.ledger.activeSession = this.snapshotActiveSession();
        this.save();
      }
    }
  }

  generateReport(): MaintenanceReport {
    const total = this.ledger.totalPrintMinutes;
    const totalHours = (total / 60).toFixed(1);

    const items: MaintenanceItem[] = [
      {
        id: "lube_rails",
        task: "Lubricate linear rails",
        thresholdMinutes: MAINTENANCE_THRESHOLDS.LUBE_RAILS_MINUTES,
        intervalLabel: "200 print-hours",
      },
      {
        id: "clean_carbon_rods",
        task: "Clean carbon rods",
        thresholdMinutes: MAINTENANCE_THRESHOLDS.CLEAN_CARBON_RODS_MINUTES,
        intervalLabel: "100 print-hours",
      },
      {
        id: "inspect_hotend",
        task: "Inspect hotend / nozzle wear",
        thresholdMinutes: MAINTENANCE_THRESHOLDS.CHECK_HOTEND_MINUTES,
        intervalLabel: "500 print-hours",
      },
    ];

    const warnings: string[] = [];
    const checks: CheckResult[] = items.map((item) => {
      const lastDoneAt = this.ledger.maintenanceCompletedAt[item.id] ?? 0;
      const minutesSinceDone = total - lastDoneAt;
      const minutesUntilDue = item.thresholdMinutes - minutesSinceDone;
      const hoursUntilDue = (Math.max(minutesUntilDue, 0) / 60).toFixed(1);

      const status: "OK" | "DUE_SOON" | "OVERDUE" =
        minutesUntilDue <= 0
          ? "OVERDUE"
          : minutesUntilDue < 10 * 60
          ? "DUE_SOON"
          : "OK";

      if (status !== "OK") {
        warnings.push(
          status === "OVERDUE"
            ? `⚠️  ${item.task} is OVERDUE by ${((-minutesUntilDue) / 60).toFixed(1)}h (every ${item.intervalLabel})`
            : `🔔  ${item.task} due in ~${hoursUntilDue}h (every ${item.intervalLabel})`,
        );
      }

      return {
        task: item.task,
        id: item.id,
        intervalLabel: item.intervalLabel,
        status,
        minutesUntilDue,
        hoursUntilDue: parseFloat(hoursUntilDue),
      };
    });

    return {
      totalPrintHours: parseFloat(totalHours),
      totalPrintMinutes: total,
      sessionCount: this.ledger.sessions.length,
      lastUpdated: this.ledger.lastUpdated,
      checks,
      warnings,
      hasActiveSession: this.activeSession !== null,
      activeSessionMinutesElapsed: this.activeSession?.durationMinutes,
    };
  }

  // Record that the user performed a maintenance task. If `hoursAgo` is
  // provided, the completion is back-dated by that many cumulative
  // print-hours (useful for "I oiled the rails yesterday but forgot to log").
  markTaskDone(taskId: string, hoursAgo = 0): boolean {
    const known = ["lube_rails", "clean_carbon_rods", "inspect_hotend"];
    if (!known.includes(taskId)) return false;
    const offsetMinutes = Math.max(0, Math.round(hoursAgo * 60));
    const completedAt = Math.max(0, this.ledger.totalPrintMinutes - offsetMinutes);
    this.ledger.maintenanceCompletedAt[taskId] = completedAt;
    this.save();
    return true;
  }

  // Called once at startup if a recovered active session exists but the
  // printer is now reported as IDLE (i.e. the print finished while we were
  // dead). We can't know the true elapsed time, so we conservatively use
  // the last persisted `durationMinutes` plus the wall-clock gap since the
  // last checkpoint, capped at the original `startMinutes` estimate.
  finalizeRecoveredSessionIfIdle(currentState: string | undefined): void {
    if (!this.activeSession) return;
    if (currentState === "RUNNING" || currentState === "PAUSE") return;

    const snapshot = this.ledger.activeSession;
    let recoveredDuration = this.activeSession.durationMinutes;

    if (snapshot?.lastCheckpointAt) {
      const wallGapMin = Math.max(
        0,
        Math.round(
          (Date.now() - new Date(snapshot.lastCheckpointAt).getTime()) / 60_000,
        ),
      );
      const cap =
        this.activeSession.startMinutes > 0
          ? this.activeSession.startMinutes
          : Number.POSITIVE_INFINITY;
      recoveredDuration = Math.min(
        cap,
        this.activeSession.durationMinutes + wallGapMin,
      );
    }

    const session: PrintSession = {
      startedAt: this.activeSession.startedAt,
      endedAt: new Date().toISOString(),
      durationMinutes: recoveredDuration,
      subtaskName: this.activeSession.subtaskName,
    };
    this.ledger.totalPrintMinutes += session.durationMinutes;
    this.ledger.sessions = [...this.ledger.sessions.slice(-99), session];
    this.activeSession = null;
    this.lastCheckpointMinutes = 0;
    delete this.ledger.activeSession;
    this.save();
  }

  getLedger(): Readonly<MaintenanceLedger> {
    return this.ledger;
  }

  // Return up to `limit` most-recent print sessions, newest first.
  getRecentSessions(limit = 10): PrintSession[] {
    return [...this.ledger.sessions].slice(-limit).reverse();
  }

  // Forecast when each maintenance task will become due, based on the
  // user's average print rate over a recent window. Returns null for tasks
  // already overdue or where we don't have enough history to estimate.
  forecast(windowDays = 14): MaintenanceForecast[] {
    const now = Date.now();
    const cutoff = now - windowDays * 24 * 60 * 60 * 1000;
    const recent = this.ledger.sessions.filter((s) => {
      if (!s.endedAt) return false;
      return new Date(s.endedAt).getTime() >= cutoff;
    });
    const recentMinutes = recent.reduce((acc, s) => acc + s.durationMinutes, 0);
    const minutesPerDay = recentMinutes / windowDays;

    const items = [
      {
        id: "lube_rails",
        task: "Lubricate linear rails",
        thresholdMinutes: MAINTENANCE_THRESHOLDS.LUBE_RAILS_MINUTES,
      },
      {
        id: "clean_carbon_rods",
        task: "Clean carbon rods",
        thresholdMinutes: MAINTENANCE_THRESHOLDS.CLEAN_CARBON_RODS_MINUTES,
      },
      {
        id: "inspect_hotend",
        task: "Inspect hotend / nozzle wear",
        thresholdMinutes: MAINTENANCE_THRESHOLDS.CHECK_HOTEND_MINUTES,
      },
    ];

    return items.map((item) => {
      const lastDoneAt = this.ledger.maintenanceCompletedAt[item.id] ?? 0;
      const minutesUntilDue = item.thresholdMinutes - (this.ledger.totalPrintMinutes - lastDoneAt);

      let etaDays: number | null = null;
      if (minutesUntilDue <= 0) {
        etaDays = 0;
      } else if (minutesPerDay > 0) {
        etaDays = Math.round(minutesUntilDue / minutesPerDay);
      }

      return {
        id: item.id,
        task: item.task,
        minutesUntilDue,
        etaDays,
        windowDays,
        recentDailyMinutes: Math.round(minutesPerDay),
      };
    });
  }
}

export interface MaintenanceForecast {
  id: string;
  task: string;
  minutesUntilDue: number;
  etaDays: number | null;       // null if no recent prints to extrapolate from
  windowDays: number;
  recentDailyMinutes: number;
}

interface MaintenanceItem {
  id: string;
  task: string;
  thresholdMinutes: number;
  intervalLabel: string;
}

export interface CheckResult {
  id: string;
  task: string;
  intervalLabel: string;
  status: "OK" | "DUE_SOON" | "OVERDUE";
  minutesUntilDue: number;
  hoursUntilDue: number;
}

export interface MaintenanceReport {
  totalPrintHours: number;
  totalPrintMinutes: number;
  sessionCount: number;
  lastUpdated: string;
  checks: CheckResult[];
  warnings: string[];
  hasActiveSession: boolean;
  activeSessionMinutesElapsed?: number;
}
