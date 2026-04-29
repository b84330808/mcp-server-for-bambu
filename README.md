# mcp-server-for-bambu

A lightweight Model Context Protocol (MCP) server for **Bambu Lab 3D printers** over LAN/MQTT. No cloud round-trip, no STL parsing, no slicing bloat — just real-time status, print control, and a maintenance ledger.

Built and tested against the **P1S**; should work on other MQTT-speaking models (P1P, X1C, etc.).

> **⚠️ Unofficial — not affiliated with Bambu Lab**
>
> This is a community-built project. It is **not affiliated with, endorsed by, or sponsored by Bambu Lab / Shenzhen Tuozhu Technology Co., Ltd.** "Bambu Lab", "Bambu Studio", "P1S", "P1P", "X1C", and "AMS" are trademarks of their respective owners; references in this project are descriptive only (nominative fair use), made for compatibility purposes. Provided "as is" with no warranty.

## What it does

Exposes a set of MCP tools to your AI assistant (Claude Desktop, Cursor, etc.):

**Read**

| Tool | Purpose |
| --- | --- |
| `get_status` | Real-time temperatures, state, progress, layer count, current stage, HMS warnings, Wi-Fi signal |
| `get_ams_info` | Per-slot AMS filament type / color / remaining % |
| `get_maintenance_status` | Cumulative print-hours and warnings for lube / clean / inspect |
| `get_recent_prints` | List the last N print sessions (names, durations, completion timestamps) |
| `forecast_maintenance` | Predict when each maintenance task will be due, based on recent print rate |
| `list_active_warnings` | Active HMS warnings with links to Bambu Lab's wiki page for each code |

**Control**

| Tool | Purpose |
| --- | --- |
| `pause_print` / `resume_print` | Pause and resume the current print |
| `stop_print` | Cancel the print (requires explicit `confirm: true`) |
| `set_light` | Toggle the chamber light |
| `set_speed` | Switch profile: silent / standard / sport / ludicrous |
| `preheat` | Preheat nozzle and/or bed to specified temps |
| `change_active_tray` | Switch the AMS feed to a different filament slot |
| `run_gcode` | Send raw G-code (power-user; useful for homing, Z-hop, manual unload, etc.) |

**Maintenance ledger**

| Tool | Purpose |
| --- | --- |
| `mark_maintenance_done` | Log that you completed a maintenance task (with optional `hours_ago` back-dating) |

The ledger persists to a local JSON file and survives crashes (active sessions are checkpointed every 5 elapsed minutes).

## Requirements

- Node.js **20+** (`.nvmrc` provided)
- Bambu Lab printer on the same LAN with **LAN Mode Liveview enabled**
  - On the printer: `Settings → General → LAN Mode Liveview = ON`

## Setup (recommended: guided through Claude)

This server can configure itself. You don't need to edit credentials by hand.

### 1. Install & build

```bash
npm install
npm run build
```

### 2. Register with Claude Desktop (no credentials yet)

Edit `claude_desktop_config.json`:

- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`

Add (adjust the path to where you cloned the repo):

```json
{
  "mcpServers": {
    "bambu-nexus": {
      "command": "node",
      "args": ["D:\\workspace\\mcp-server-bambu-nexus\\dist\\index.js"]
    }
  }
}
```

That's it — no `env` block needed. Fully quit Claude Desktop and reopen it.

### 3. Find your printer's credentials

On the printer touchscreen:

- **IP**: `Settings → WLAN → tap the small circle next to the connected network`
- **Serial**: `Settings → Device → Device Info` (P1S format: `01P00AXXXXXXXXX`)
- **Access Code**: `Settings → WLAN → LAN Mode Liveview` (8 characters — NOT the Wi-Fi password)

Make sure **LAN Mode Liveview is ON** (`Settings → General`).

### 4. Configure through Claude

Open Claude Desktop. The server starts in **setup mode** with one tool: `setup_printer`. Just tell Claude:

> "Set up my Bambu printer. IP is 192.168.1.50, serial 01P00A1234567890, access code 12345678."

Claude will call `setup_printer`. The tool:
1. Validates the format
2. Tests the MQTT connection live (≤8 second timeout)
3. **Only writes credentials on success** — typos can't corrupt your config

If it succeeds, fully quit and reopen Claude Desktop one more time. The full set of printer tools (`get_status`, `get_ams_info`, `get_maintenance_status`, `mark_maintenance_done`) becomes available.

### 5. Try it

Ask Claude:

**Read**
- "What's my printer doing right now?"
- "What filament is in AMS slot 2?"
- "Anything overdue on the printer maintenance?"
- "Show me my last 5 prints."
- "When will I next need to lube the rails?"

**Control**
- "Pause the print."
- "Turn the chamber light off."
- "Switch to silent mode."
- "Preheat the nozzle to 210 and bed to 60."
- "Switch AMS to slot 2."
- "Home all axes." (run_gcode `G28`)
- "Cancel this print." (will require confirmation)

**Log**
- "I just lubricated the rails — log it."
- "I cleaned the carbon rods 30 hours ago, please back-date it."

---

## Setup (alternative: manual `.env`)

If you'd rather skip the guided flow:

```bash
cp .env.example .env
# edit .env with your IP / serial / access code
npm start   # verifies the connection from the terminal
```

Then register with Claude Desktop as in step 2 above. Credentials are read from `.env` (located next to the binary, so `cwd` doesn't matter).

You can also put credentials directly in the `env` block of `claude_desktop_config.json`; this overrides `.env`.

## Maintenance thresholds

Defined in `src/types.ts`:

| Task | Interval |
| --- | --- |
| Clean carbon rods | 100 print-hours |
| Lubricate linear rails | 200 print-hours |
| Inspect hotend / nozzle wear | 500 print-hours |

A task flips to `DUE_SOON` (🔔) within 10 hours of the threshold and `OVERDUE` (⚠️) past it.

## Development

```bash
npm run dev          # tsc --watch
npm test             # run tests once
npm run test:watch   # vitest watch mode
npm run test:coverage
```

## Architecture

```
src/
  index.ts          MCP server bootstrap + tool definitions
  mqtt-client.ts    TLS MQTT client for the printer (port 8883, self-signed cert)
  maintenance.ts    Print-time ledger with crash-safe atomic writes + recovery
  hms.ts            Bambu HMS error code → human label
  types.ts          Shared types + maintenance thresholds
tests/              vitest suite
```

**Protocol notes:**
- Subscribe: `device/{serial}/report`
- Publish: `device/{serial}/request` with `{"pushing":{"sequence_id":"...","command":"pushall"}}`
- Auth: username `bblp`, password = access code, clientId = serial
- Cert is self-signed → `rejectUnauthorized: false`

## License

MIT
