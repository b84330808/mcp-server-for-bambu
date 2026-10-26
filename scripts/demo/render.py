# Renders docs/demo.gif from the JSON written by scripts/demo/capture.mjs: real
# MCP tool calls and their real output against the simulated printer.
# Needs Pillow and fontTools, and the Windows Consolas / Segoe UI Symbol fonts.
import json, re, sys
from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont

capture, out = sys.argv[1], sys.argv[2]
steps = json.load(open(capture, encoding='utf-8'))

W, H = 900, 560
PAD = 22
LH = 21
BG = (24, 24, 32)
BAR = (36, 36, 48)
FG = (226, 226, 236)
DIM = (150, 150, 170)
ACC = (167, 139, 250)
USER = (125, 211, 252)
OK = (110, 231, 183)
ERR = (248, 113, 113)
NOTE = (250, 204, 21)

FONTS = ['C:/Windows/Fonts/consola.ttf', 'C:/Windows/Fonts/seguisym.ttf', 'C:/Windows/Fonts/seguiemj.ttf']
SIZE = 15
fonts = [(ImageFont.truetype(p, SIZE), TTFont(p).getBestCmap()) for p in FONTS]
bold = ImageFont.truetype('C:/Windows/Fonts/consolab.ttf', SIZE)
CW = fonts[0][0].getlength('M')


def font_for(ch, want_bold=False):
    for f, cmap in fonts:
        if ord(ch) in cmap:
            return bold if (want_bold and f is fonts[0][0]) else f
    return fonts[0][0]


def draw_text(d, x, y, text, color, want_bold=False):
    for ch in text:
        if ch == '\ufe0f':
            continue
        d.text((x, y), ch, font=font_for(ch, want_bold), fill=color)
        x += CW
    return x


def clean(line):
    return line.replace('**', '')


def frame(lines, caption=None):
    img = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 34], fill=BAR)
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([14 + i * 20, 11, 26 + i * 20, 23], fill=c)
    draw_text(d, 90, 9, 'bambu MCP server  ·  simulated P1S (npm run sim)', DIM)
    y = 34 + PAD
    for text, color, b in lines:
        draw_text(d, PAD, y, text, color, b)
        y += LH
    if caption:
        d.rectangle([0, H - 44, W, H], fill=BAR)
        draw_text(d, PAD, H - 32, caption, NOTE)
    return img


frames, durations = [], []


def add(lines, ms, caption=None):
    frames.append(frame(lines, caption))
    durations.append(ms)


def type_line(prefix_lines, text, caption=None):
    shown = ''
    for i in range(0, len(text) + 1, 3):
        shown = text[:i]
        add(prefix_lines + [('> ' + shown + '▌', USER, True)], 45, caption)
    return prefix_lines + [('> ' + text, USER, True)]


def tool_block(tool, args, result, is_error, max_lines=16):
    call = f"⏺ bambu · {tool}({', '.join(f'{k}: {json.dumps(v)}' for k, v in args.items())})"
    out = [(call, ACC, True)]
    body = [clean(l) for l in result.splitlines()]
    if is_error:
        msg = body[0].split(': [')[0]
        detail = next((l.strip() for l in body if '"message"' in l), '')
        path = 'confirm' if any('"confirm"' in l for l in body) else ''
        out.append(('  ⎿ ' + msg, ERR, False))
        if path:
            out.append((f'    path: {path}   {detail}', ERR, False))
        return out
    body = [l for l in body][:max_lines]
    for i, l in enumerate(body):
        out.append((('  ⎿ ' if i == 0 else '    ') + l, FG if i else OK, False))
    return out


# scene 1: status
s = steps
lines = type_line([], s[0]['ask'])
add(lines, 350)
lines = lines + [('', FG, False)] + tool_block(s[0]['tool'], s[0]['args'], s[0]['text'], s[0]['isError'])
add(lines, 3200)

# scene 2: AMS
lines = type_line([], s[1]['ask'])
add(lines, 350)
lines = lines + [('', FG, False)] + tool_block(s[1]['tool'], s[1]['args'], s[1]['text'], s[1]['isError'])
add(lines, 2800)

# scene 3: pause + light, then status shows Paused
lines = type_line([], s[2]['ask'])
add(lines, 350)
lines = lines + [('', FG, False)] + tool_block(s[2]['tool'], s[2]['args'], s[2]['text'], False)
add(lines, 900)
lines = lines + tool_block(s[3]['tool'], s[3]['args'], s[3]['text'], False)
add(lines, 900)
status_lines = s[4]['text'].splitlines()[:2]
lines = lines + tool_block(s[4]['tool'], s[4]['args'], '\n'.join(status_lines), False)
add(lines, 2600)

# scene 4: cancel is refused without confirm
lines = type_line([], s[5]['ask'])
add(lines, 350)
lines = lines + [('', FG, False)] + tool_block(s[5]['tool'], s[5]['args'], s[5]['text'], s[5]['isError'])
add(lines, 900)
add(lines, 3800, 'Cancelling needs confirm: true, so the assistant has to ask you first.')

# outro
outro = [
    ('', FG, False),
    ('mcp-server-for-bambu', ACC, True),
    ('', FG, False),
    ('  Claude Code:     /plugin marketplace add b84330808/mcp-server-for-bambu', FG, False),
    ('  Any MCP client:  npx -y mcp-server-for-bambu', FG, False),
    ('', FG, False),
    ('  LAN only · no cloud · destructive tools need confirmation', DIM, False),
]
add(outro, 3500)

# one palette for every frame, built from the frames with the most colours
ref_src = Image.new('RGB', (W, H * 3))
for i, f in enumerate(sorted(frames, key=lambda f: -len(f.getcolors(1 << 16) or []))[:3]):
    ref_src.paste(f, (0, H * i))
ref = ref_src.quantize(colors=64, method=Image.Quantize.MEDIANCUT)
pal = [f.quantize(palette=ref, dither=Image.Dither.NONE) for f in frames]
pal[0].save(out, save_all=True, append_images=pal[1:], duration=durations, loop=0, optimize=True, disposal=1)
print(len(frames), 'frames', sum(durations) / 1000, 's')
