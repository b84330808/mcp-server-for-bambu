# Changelog

## 0.3.0

### Fixed
- A printer that accepts the TCP connection but never answers no longer hangs tool calls forever; `connect()` now fails after 10 s with a clear message.
- Retrying after a failed connection no longer leaves extra MQTT clients reconnecting in the background.
- Each connection uses its own MQTT client ID. Two copies of the server (say Claude Desktop and Claude Code) no longer kick each other off.
- The server exits when the MCP client closes stdin, instead of staying alive and holding a printer connection.
- HMS severity is read from the `code` field (it was read from `attr`, so most warnings showed as "level 0").
- `change_active_tray` sends the right `target` for AMS units 2–4 (it always targeted unit 1).
- `get_status` shows progress for a paused print, and `get_ams_info` names the active slot instead of printing a raw index.
- The server reports its real version instead of 0.1.0.
- The README's manual setup used `PRINTER_*` variable names the server never read. The docs now use `BAMBU_*`, and `PRINTER_*` is accepted too.

### Changed
- Credentials and the maintenance ledger moved from the package directory (wiped by `npx` updates) to a per-user config directory. An existing `.env` is still read from the old place, and an old ledger is copied over once.
- `run_gcode` and `change_active_tray` now need `confirm: true`, like `stop_print`.
- `setup_printer` only accepts local-network addresses.

### Added
- `BAMBU_READ_ONLY=1`: register only the read tools.
- MCP tool annotations and titles on every tool.
- Claude Code plugin and marketplace (`/plugin marketplace add b84330808/mcp-server-for-bambu`).
- `server.json` for the official MCP Registry, `glama.json`, and client config examples for Claude Desktop, Cursor and VS Code.
- A simulated printer (`npm run sim`) and end-to-end tests that drive the built server over stdio.
- CI on Linux, Windows and macOS.
