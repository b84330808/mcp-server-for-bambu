# Recording the demo GIF

The current `docs/demo.gif` is rendered from real tool output against the simulator:

```bash
SIM_PORT=18883 npm run sim                                  # terminal 1
npm run build && node scripts/demo/capture.mjs demo-capture.json   # terminal 2
python scripts/demo/render.py demo-capture.json docs/demo.gif
```

A screen recording of a real assistant session with a real printer would sell it better. The rest of this page is a script for that.

Goal: a 20–30 second GIF for the top of the README that shows a question, a live answer, and a confirmed action. Save it as `docs/demo.gif` (under 5 MB so GitHub shows it inline).

## Setup

- **Printer**: a real print in progress looks best. To record without risking a print, use the simulator instead: `npm run sim` in a clone, and the server env `BAMBU_IP=127.0.0.1`, `BAMBU_SERIAL=01P00ASIMULATOR`, `BAMBU_ACCESS_CODE=12345678`.
- **Client**: Claude Desktop or Claude Code with the server connected. Check with "what's my printer doing?" once before recording, so the first call isn't the slow one.
- **Window**: about 1000×700, large font, light theme. Hide the printer's serial number and IP if they show (the status header prints the serial; the simulator's serial is safe to show).
- **Recorder**: ScreenToGif (Windows), Kap (macOS) or Peek (Linux). 10–15 fps is enough.

## Script

1. Type: **"What's my printer doing right now?"**
   Claude calls `get_status`. Hold on the answer (state, progress, temperatures) for about 3 seconds.
2. Type: **"Which filament is loaded in the AMS?"**
   Claude calls `get_ams_info`. Hold for about 2 seconds.
3. Type: **"Pause it and turn the chamber light off."**
   Claude calls `pause_print` and `set_light`. If you have a phone or webcam shot of the printer pausing, a split-screen frame here sells it.
4. Type: **"Actually, cancel the print."**
   Claude asks you to confirm instead of cancelling. **Stop the recording on this question.** Don't confirm on a real print.

Optional last frame: "Anything due for maintenance?" with the ledger answer.

## After recording

1. Trim dead time; keep typing at real speed or speed it up 1.5×.
2. Optimize (ScreenToGif's encoder, or `gifsicle -O3 --lossy=80`).
3. Save as `docs/demo.gif` (the README already points at it) and update the caption under it in `README.md`.
