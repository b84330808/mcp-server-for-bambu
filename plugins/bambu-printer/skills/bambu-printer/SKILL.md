---
name: bambu-printer
description: Use when the user asks about their Bambu Lab 3D printer — print progress, temperatures, AMS filament, HMS errors, maintenance, or pausing, resuming, cancelling, preheating or sending G-code. Covers first-time setup and the confirmation rules for actions that change the printer.
---

# Bambu Lab printer

The `bambu` MCP server talks to one Bambu Lab printer on the user's local network over MQTT. It never goes through Bambu's cloud.

## First-time setup

If the only tools are `setup_printer` and `setup_status`, the printer isn't configured yet. Ask the user for three values from the printer's touchscreen, then call `setup_printer`:

- **IP**: Settings → WLAN → tap the connected network.
- **Serial**: Settings → Device → Device Info.
- **Access code**: Settings → WLAN → LAN Mode Liveview. It is 8 characters and is not the Wi-Fi password. LAN Mode Liveview must be ON.

The tool tests the connection and saves the values only if it works. Afterwards the user runs `/mcp` and reconnects the `bambu` server (or restarts Claude Code) to get the printer tools.

## Reading

Start with `get_status` before any control action, so you know whether a print is running. Use `get_ams_info` before suggesting a filament slot, and `list_active_warnings` when the user reports a problem. HMS codes come with a wiki link; give it to the user rather than guessing a fix.

## Changing the printer

- `pause_print`, `resume_print`, `set_light`, `set_speed` and `preheat` can be undone. Do them when asked.
- `stop_print`, `run_gcode` and `change_active_tray` take `confirm: true`. Before calling one, say in plain words what will happen (for G-code, show the exact lines) and wait for the user to agree. Never set `confirm` on the first request.
- Heaters stay on after `preheat` or `M104`/`M140`. If the user is about to leave, offer to set them to 0.
- The printer may be in another room. If a command could move the toolhead or the bed, check that nothing is in the way, or ask the user to.

If tools fail with "Could not reach the printer", the printer is off, on another network, or LAN Mode Liveview is off. Say so; don't retry in a loop.
