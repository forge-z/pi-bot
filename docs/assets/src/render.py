#!/usr/bin/env python3
"""Render landing PNGs from the captured setup transcript and the chat HTML.

Run from the repository root (Chrome on PATH, JetBrains Mono and Inter fonts):

    python3 docs/assets/src/capture-setup.py   # optional: refreshes the .txt files
    python3 docs/assets/src/render.py

The QR image in place of @@QR@@ uses fictional data and is blurred.
It is not a pairing code.
"""

from __future__ import annotations

import html
import shutil
import struct
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SRC = Path(__file__).resolve().parent
ASSETS = ROOT / "docs" / "assets"
CLI = SRC / "cli"
CHROME = "/opt/google/chrome/chrome"
if not Path(CHROME).exists():
    CHROME = shutil.which("google-chrome-stable") or shutil.which("google-chrome") or ""
NODE = shutil.which("node") or "node"

WIDTH = 1200
CLI_HEIGHT = 750
CHAT_HEIGHT = 2133
FAKE_QR_TEXT = "mockup-pi-bot-nao-e-um-pareamento"


def png_info(path: Path) -> tuple[int, int, int]:
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"{path} is not a PNG")
    width, height = struct.unpack(">II", data[16:24])
    return width, height, path.stat().st_size


def wrap_line(line: str, width: int) -> list[str]:
    if len(line) <= width:
        return [line]
    indent = len(line) - len(line.lstrip(" "))
    pad = " " * indent
    rows: list[str] = []
    current = ""
    for word in line[indent:].split(" "):
        if not word:
            continue
        candidate = word if not current else current + " " + word
        if len(pad) + len(candidate) <= width:
            current = candidate
            continue
        if current:
            rows.append(pad + current)
        current = word
    if current:
        rows.append(pad + current)
    return rows or [line]


def view_for(name: str, text: str) -> list[str]:
    lines = text.splitlines()
    if name == "cli-4-modelo":
        # Top of the real provider list: Text model menu and [0] ChatGPT.
        # The rest of the catalog, and the SetupRequiredError that stops
        # ChatGPT login, stay in the .txt transcript.
        return lines[:22]
    return lines


def fake_qr() -> str:
    script = (
        "import qr from 'qrcode-terminal';"
        f"qr.generate({FAKE_QR_TEXT!r}, {{small:true}}, (out) => process.stdout.write(out));"
    )
    result = subprocess.run(
        [NODE, "--input-type=module", "-e", script],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.rstrip("\n")


def line_html(line: str) -> str:
    escaped = html.escape(line)
    if line.startswith(">"):
        return f'<span class="dim">{escaped}</span>'
    if line.startswith("Choice:") or line.startswith("Provider [") or line.startswith("Subscription ["):
        head, sep, tail = escaped.partition(": ")
        if sep:
            return f'<span class="dim">{head}{sep}</span><span class="cmd">{tail}</span>'
    if "configured" in line:
        return escaped.replace("configured", '<span class="ok">configured</span>')
    if line.strip().startswith("[") or line.strip().startswith("["):
        return escaped
    return escaped


def terminal_html(lines: list[str], qr: str | None) -> str:
    body: list[str] = []
    visual = 0
    for line in lines:
        if line.strip() == "@@QR@@":
            if qr:
                body.append(
                    '<div class="qr" aria-hidden="true"><pre>'
                    + html.escape(qr)
                    + "</pre></div>"
                )
            continue
        wrapped = wrap_line(line, 64)
        visual += len(wrapped)
        for piece in wrapped:
            body.append(f"<div class=\"ln\">{line_html(piece) or '&nbsp;'}</div>")
    chrome = 52 + 28 + 24 + (200 if qr else 0)
    room = CLI_HEIGHT - chrome
    font = max(16, min(26, int(room / max(visual, 1) / 1.38)))
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <style>
    html, body {{
      margin: 0;
      width: {WIDTH}px;
      height: {CLI_HEIGHT}px;
      overflow: hidden;
      background: #10141f;
      color: #e6e9f2;
      font-family: "JetBrains Mono", ui-monospace, monospace;
    }}
    .window {{ display: flex; flex-direction: column; height: 100%; }}
    .bar {{
      display: flex;
      align-items: center;
      gap: 10px;
      height: 52px;
      padding: 0 22px;
      background: #181e2e;
      color: #a3acc0;
      font-size: 18px;
    }}
    .dot {{ width: 14px; height: 14px; border-radius: 50%; }}
    .dot.r {{ background: #ff5f57; }}
    .dot.y {{ background: #febc2e; }}
    .dot.g {{ background: #28c840; }}
    .title {{ margin-left: 12px; }}
    .screen {{
      flex: 1;
      padding: 26px 36px 32px;
      font-size: {font}px;
      line-height: 1.38;
    }}
    .ln {{ white-space: pre; }}
    .dim {{ color: #8b93a7; }}
    .cmd {{ color: #ffffff; font-weight: 700; }}
    .ok {{ color: #7dcea0; }}
    .qr {{
      width: 280px;
      margin: 10px 0 0 4px;
      filter: blur(7px);
      opacity: 0.8;
    }}
    .qr pre {{
      margin: 0;
      font-size: 11px;
      line-height: 1.05;
      color: #d5d8e2;
    }}
  </style>
</head>
<body>
  <div class="window">
    <div class="bar">
      <span class="dot r"></span><span class="dot y"></span><span class="dot g"></span>
      <span class="title">npm run setup</span>
    </div>
    <div class="screen">
      {''.join(body)}
    </div>
  </div>
</body>
</html>
"""


def shoot(html_path: Path, png_path: Path, width: int, height: int) -> None:
    if not CHROME:
        raise SystemExit("google-chrome is not on PATH")
    png_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="pi-bot-chrome-") as profile:
        subprocess.run(
            [
                CHROME,
                "--headless=new",
                "--disable-gpu",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--hide-scrollbars",
                "--no-first-run",
                "--force-device-scale-factor=1",
                f"--user-data-dir={profile}",
                f"--window-size={width},{height}",
                f"--screenshot={png_path}",
                html_path.as_uri(),
            ],
            check=True,
            capture_output=True,
            timeout=60,
        )


def main() -> None:
    qr = fake_qr()
    shots = [
        "cli-1-inicio",
        "cli-2-gateway",
        "cli-3-whatsapp",
        "cli-4-modelo",
        "cli-5-pronto",
    ]
    with tempfile.TemporaryDirectory(prefix="pi-bot-frames-") as tmp:
        folder = Path(tmp)
        for name in shots:
            text = (CLI / f"{name}.txt").read_text(encoding="utf-8")
            page = terminal_html(view_for(name, text), qr if name == "cli-3-whatsapp" else None)
            html_path = folder / f"{name}.html"
            html_path.write_text(page, encoding="utf-8")
            shoot(html_path, ASSETS / f"{name}.png", WIDTH, CLI_HEIGHT)
        shoot(SRC / "chat-whatsapp.html", ASSETS / "chat-whatsapp.png", WIDTH, CHAT_HEIGHT)
        shoot(SRC / "chat-telegram.html", ASSETS / "chat-telegram.png", WIDTH, CHAT_HEIGHT)

    for name in shots + ["chat-whatsapp", "chat-telegram"]:
        path = ASSETS / f"{name}.png"
        width, height, size = png_info(path)
        print(f"{path.name} {width}x{height} {size} bytes")
        if size > 500 * 1024:
            raise SystemExit(f"{path.name} passou de 500 KB")
        if not 1100 <= width <= 1300:
            raise SystemExit(f"{path.name} largura {width}, esperado ~1200")


if __name__ == "__main__":
    main()
