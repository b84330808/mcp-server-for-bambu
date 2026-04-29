// Bambu Lab MQTT report payload ("print" object)
export interface PrinterReport {
  // State
  gcode_state?: string;          // "IDLE" | "RUNNING" | "PAUSE" | "FAILED" | "FINISH"
  stg_cur?: number;              // Current stage code (see stages.ts)
  mc_print_stage?: string;       // String form of current stage
  print_type?: string;           // "cloud" | "local" | "idle" | "system"

  // Temperatures
  nozzle_temper?: number;
  nozzle_target_temper?: number;
  bed_temper?: number;
  bed_target_temper?: number;
  chamber_temper?: number;

  // Progress
  mc_percent?: number;           // 0-100
  mc_remaining_time?: number;    // minutes
  layer_num?: number;
  total_layer_num?: number;
  subtask_name?: string;
  gcode_file?: string;           // Currently loaded G-code filename
  gcode_file_prepare_percent?: string; // Download/prep progress

  // AMS (Automatic Material System)
  ams?: AmsStatus;

  // Fan speeds (string in protocol, looks like "0".."15")
  cooling_fan_speed?: string | number;
  big_fan1_speed?: string | number;     // Auxiliary fan
  big_fan2_speed?: string | number;     // Chamber fan
  heatbreak_fan_speed?: string | number;

  // Hardware / environment
  nozzle_diameter?: string;      // e.g. "0.4"
  wifi_signal?: string;          // e.g. "-52dBm"
  home_flag?: number;
  hw_switch_state?: number;
  sdcard?: boolean;

  // Errors / health
  print_error?: number;
  mc_print_error_code?: string;
  fail_reason?: string;
  hms?: HmsWarning[];

  // Speed
  spd_lvl?: number;              // Speed level 1-4 (see stages.ts SPEED_PROFILE)
  spd_mag?: number;              // Speed magnitude %

  // Lights
  lights_report?: LightReport[];

  // Misc / metadata
  sequence_id?: string;
  command?: string;
  task_id?: string;
  subtask_id?: string;
  project_id?: string;
}

// HMS warning entry — the printer publishes an array of these on every report
// when there are active warnings/errors. Empty array means everything is fine.
export interface HmsWarning {
  attr: number;   // Module + severity packed
  code: number;   // Specific issue code
}

export interface AmsStatus {
  ams: AmsUnit[];
  ams_exist_bits?: string;
  tray_exist_bits?: string;
  tray_now?: string;
  tray_pre?: string;
  version?: number;
}

export interface AmsUnit {
  id: string;
  humidity?: string;
  temp?: string;
  tray: Tray[];
}

export interface Tray {
  id: string;
  tray_type?: string;            // "PLA" | "PETG" | "ABS" | "ASA" | etc.
  tray_color?: string;           // RRGGBBAA hex
  tray_sub_brands?: string;
  tray_weight?: string;
  tray_diameter?: string;
  tray_temp?: string;
  tray_time?: string;
  bed_temp_type?: string;
  bed_temp?: string;
  nozzle_temp_max?: string;
  nozzle_temp_min?: string;
  remain?: number;               // Percentage remaining
  k?: number;                    // Flow ratio
}

export interface LightReport {
  node: string;
  mode: string;
}

// Full MQTT report envelope
export interface MqttReport {
  print?: PrinterReport;
  info?: Record<string, unknown>;
  system?: Record<string, unknown>;
}

// MQTT command envelopes
export interface PushAllCommand {
  pushing: {
    sequence_id: string;
    command: "pushall";
  };
}

// Maintenance ledger stored in JSON
export interface MaintenanceLedger {
  totalPrintMinutes: number;      // Cumulative minutes across all sessions
  sessions: PrintSession[];
  lastUpdated: string;            // ISO timestamp
  // Key = task id; value = totalPrintMinutes when the task was last completed.
  maintenanceCompletedAt: Record<string, number>;
  // Snapshot of an in-flight session so we can recover after a crash/restart.
  activeSession?: ActiveSessionSnapshot;
}

export interface ActiveSessionSnapshot {
  startedAt: string;
  startMinutes: number;
  durationMinutes: number;
  subtaskName?: string;
  lastCheckpointAt: string;
}

export interface PrintSession {
  startedAt: string;              // ISO timestamp
  endedAt?: string;               // ISO timestamp (set when session ends)
  durationMinutes: number;
  subtaskName?: string;
}

// Thresholds (minutes)
export const MAINTENANCE_THRESHOLDS = {
  LUBE_RAILS_MINUTES: 200 * 60,           // 200 print-hours
  CLEAN_CARBON_RODS_MINUTES: 100 * 60,    // 100 print-hours
  CHECK_HOTEND_MINUTES: 500 * 60,         // 500 print-hours
} as const;
