#!/usr/bin/env python3
"""Run `npm run setup` in a PTY and save sanitized slices for the landing images.

Reproduzir, na raiz do repositório, com Node 24 e as dependências instaladas
(`npm ci && npm run build`):

    python3 docs/assets/src/capture-setup.py

O script não grava segredo. A chave digitada é falsa e o prompt é oculto.
Um QR de pareamento real, se aparecer, é descartado e trocado pelo marcador
@@QR@@. O renderizador desenha no lugar um QR borrado de um texto fictício.
"""

from __future__ import annotations

import codecs
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import fcntl
import time
from pathlib import Path

import pyte

REPO = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent / "cli"
NODE = os.environ.get("NODE", "node")
# Wide on purpose: the program prints logical lines, and the renderer wraps them.
# A narrow PTY splits words like "reloads" in the middle.
COLS = 220
ROWS = 40
FAKE_KEY = "sk-exemplo-nao-e-real"
FAKE_NUMBER = "5511900000000"
QR_MARKER = "@@QR@@"
BLOCK = set("▄▀█▌▐░▒▓■□▪▫")


def line_text(row: object, columns: int) -> str:
    chars: list[str] = []
    for index in range(columns):
        cell = row[index]  # type: ignore[index]
        chars.append(cell.data)
    return "".join(chars).rstrip()


class Session:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.screen = pyte.HistoryScreen(COLS, ROWS, history=20000)
        self.stream = pyte.Stream(self.screen)
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.master: int | None = None
        self.proc: subprocess.Popen[bytes] | None = None

    def start(self) -> None:
        # A new container creates the volume schema before `npm run setup`.
        # Opening Store does the same thing, then releases the file.
        prepared = subprocess.run(
            [
                NODE,
                "--input-type=module",
                "-e",
                "import { Store } from './dist/src/store.js';"
                "const store = new Store(process.env.DATA_DIR); store.close();",
            ],
            cwd=REPO,
            env={
                "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
                "HOME": "/tmp",
                "LANG": "C.UTF-8",
                "DATA_DIR": str(self.data_dir),
            },
            capture_output=True,
            text=True,
        )
        if prepared.returncode != 0:
            raise SystemExit(prepared.stderr or prepared.stdout or "schema init failed")
        master, slave = pty.openpty()
        fcntl.ioctl(
            slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0)
        )
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "HOME": "/tmp",
            "TERM": "xterm-256color",
            "LANG": "C.UTF-8",
            "DATA_DIR": str(self.data_dir),
        }
        self.proc = subprocess.Popen(
            ["npm", "run", "setup"],
            stdin=slave,
            stdout=slave,
            stderr=slave,
            cwd=REPO,
            env=env,
            start_new_session=True,
        )
        os.close(slave)
        self.master = master

    def pump(self, timeout: float = 0.2) -> None:
        assert self.master is not None
        while True:
            readable, _, _ = select.select([self.master], [], [], timeout)
            if not readable:
                return
            try:
                chunk = os.read(self.master, 65536)
            except OSError:
                return
            if not chunk:
                return
            self.stream.feed(self.decoder.decode(chunk))
            timeout = 0.02

    def text(self) -> str:
        self.pump(0)
        lines = [line_text(row, COLS) for row in self.screen.history.top]
        lines.extend(line.rstrip() for line in self.screen.display)
        while lines and lines[-1] == "":
            lines.pop()
        return "\n".join(lines)

    def wait(self, needle: str, timeout: float) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.pump(0.1)
            if needle in self.text():
                return True
            if self.proc and self.proc.poll() is not None:
                return needle in self.text()
        return False

    def tail(self, lines: int = 18) -> str:
        return "\n".join(self.text().splitlines()[-lines:])

    def wait_tail(self, needle: str, timeout: float, lines: int = 18) -> bool:
        """Match only recent lines, so an earlier menu cannot satisfy the wait."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.pump(0.1)
            if needle in self.tail(lines):
                return True
            if self.proc and self.proc.poll() is not None:
                return needle in self.tail(lines)
        return False

    def send(self, data: str) -> None:
        assert self.master is not None
        os.write(self.master, data.encode())
        time.sleep(0.05)

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
            except OSError:
                pass
            try:
                self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(self.proc.pid, signal.SIGKILL)
                except OSError:
                    pass
                self.proc.wait(timeout=3)
        if self.master is not None:
            os.close(self.master)
            self.master = None
        self.stream.feed(self.decoder.decode(b"", final=True))


def slice_from(text: str, start: str) -> str:
    index = text.rfind(start)
    if index < 0:
        raise SystemExit(f"marcador não encontrado: {start!r}")
    return text[index:].rstrip() + "\n"


def is_qr_line(line: str) -> bool:
    stripped = line.strip()
    if len(stripped) < 12:
        return False
    blocks = sum(1 for char in stripped if char in BLOCK)
    return blocks / len(stripped) > 0.45


def strip_qr(text: str) -> str:
    """Drop live pairing QR art. Leave a marker the renderer replaces."""
    lines = text.split("\n")
    out: list[str] = []
    pending = False
    for line in lines:
        if is_qr_line(line):
            pending = True
            continue
        if pending:
            out.append(QR_MARKER)
            pending = False
        if "pairing code:" in line.lower():
            out.append("WhatsApp pairing code: XXXX-XXXX  (oculto; valor real descartado)")
            continue
        out.append(line)
    if pending:
        out.append(QR_MARKER)
    return "\n".join(out)


def without_npm_noise(text: str) -> str:
    lines = [
        line
        for line in text.split("\n")
        if not line.startswith("npm notice") and not line.startswith("npm warn")
    ]
    return "\n".join(lines).rstrip() + "\n"


def assert_clean(name: str, text: str) -> None:
    if FAKE_KEY in text:
        raise SystemExit(f"{name} contém a chave falsa; o prompt deveria ocultá-la")
    lowered = text.lower()
    for banned in ("sk-ant-", "sk-proj-", "xoxb-", "ghp_", "bearer "):
        if banned in lowered:
            raise SystemExit(f"{name} parece conter um segredo ({banned})")


def dedupe_echo(text: str) -> str:
    """Drop a PTY echo that repeats the answer on its own line (`Choice: s` / `s`)."""
    lines = text.splitlines()
    kept: list[str] = []
    for line in lines:
        if kept and line and kept[-1].endswith(": " + line):
            continue
        kept.append(line)
    return "\n".join(kept).rstrip() + "\n"


def write_slice(name: str, text: str) -> None:
    text = dedupe_echo(without_npm_noise(text))
    assert_clean(name, text)
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"{name}.txt"
    path.write_text(text if text.endswith("\n") else text + "\n", encoding="utf-8")
    print(f"wrote {path} ({text.count(chr(10))} lines)")


def capture_gateway(log: Path) -> None:
    data = Path("/tmp/pi-bot-data-gateway")
    if data.exists():
        subprocess.run(["rm", "-rf", str(data)], check=True)
    session = Session(data)
    session.start()
    try:
        if not session.wait("q - Exit without saving", 40):
            log.write_text(strip_qr(session.text()), encoding="utf-8")
            raise SystemExit("menu inicial não apareceu")
        # The prompt is the last line; give readline a beat to paint it.
        time.sleep(0.3)
        session.pump(0.2)
        write_slice("cli-1-inicio", session.text())

        session.send("1\n")
        if not session.wait("One phone gateway per install", 20):
            log.write_text(strip_qr(session.text()), encoding="utf-8")
            raise SystemExit("menu de gateway não apareceu")
        time.sleep(0.2)
        session.pump(0.2)
        write_slice("cli-2-gateway", slice_from(session.text(), "Setup gateway"))

        session.send("2\n")
        if not session.wait("Unofficial WhatsApp Web", 20):
            log.write_text(strip_qr(session.text()), encoding="utf-8")
            raise SystemExit("menu de WhatsApp não apareceu")
        session.send("1\n")
        if not session.wait("Numbers with country code", 20):
            log.write_text(strip_qr(session.text()), encoding="utf-8")
            raise SystemExit("pergunta do número não apareceu")
        session.send(FAKE_NUMBER + "\n")
        if not session.wait(FAKE_NUMBER, 20):
            log.write_text(strip_qr(session.text()), encoding="utf-8")
            raise SystemExit("número não foi aceito")
        time.sleep(0.2)
        session.pump(0.2)
        session.send("2\n")
        # Pairing blocks until the phone connects. Keep only the real text.
        saw_wait = session.wait("waiting for the QR", 25)
        # A live QR may follow. Give it a short window, then discard the art.
        time.sleep(4)
        session.pump(0.3)
        raw = slice_from(session.text(), "WhatsApp\n")
        cleaned = strip_qr(raw)
        if QR_MARKER not in cleaned:
            if not saw_wait and "waiting for the QR" not in cleaned:
                cleaned = cleaned.rstrip() + "\n"
            cleaned = cleaned.rstrip() + "\n" + QR_MARKER + "\n"
        write_slice("cli-3-whatsapp", cleaned)
        log.write_text(strip_qr(session.text()), encoding="utf-8")
    finally:
        session.stop()
        subprocess.run(["rm", "-rf", str(data)], check=False)


def capture_model(log: Path) -> None:
    data = Path("/tmp/pi-bot-data-model")
    if data.exists():
        subprocess.run(["rm", "-rf", str(data)], check=True)
    session = Session(data)
    session.start()
    try:
        if not session.wait("q - Exit without saving", 40):
            log.write_text(strip_qr(session.text()), encoding="utf-8")
            raise SystemExit("menu inicial (modelo) não apareceu")
        session.send("2\n")
        if not session.wait("Text model", 20):
            log.write_text(strip_qr(session.text()), encoding="utf-8")
            raise SystemExit("menu de texto não apareceu")
        session.send("1\n")
        if not session.wait("Official pi-ai providers", 20):
            log.write_text(strip_qr(session.text()), encoding="utf-8")
            raise SystemExit("lista de provedores não apareceu")
        if not session.wait("Provider [", 20):
            log.write_text(strip_qr(session.text()), encoding="utf-8")
            raise SystemExit("prompt de provedor não apareceu")
        session.send("0\n")
        if not session.wait("Subscription [1]", 20):
            log.write_text(strip_qr(session.text()), encoding="utf-8")
            raise SystemExit("pergunta de assinatura não apareceu")
        session.send("1\n")
        # Do not answer a login prompt. On a fresh volume this build exits with
        # SetupRequiredError before the device-code question, which is still
        # before any external login.
        deadline = time.time() + 30
        while time.time() < deadline:
            session.pump(0.1)
            current = session.text()
            if (
                "(s/n)" in current
                or "npm run login" in current
                or "SetupRequiredError" in current
            ):
                break
            if session.proc and session.proc.poll() is not None:
                break
        else:
            log.write_text(strip_qr(session.text()), encoding="utf-8")
            raise SystemExit("o login do modelo não chegou a uma pergunta ou a um erro")
        time.sleep(0.4)
        session.pump(0.2)
        body = slice_from(session.text(), "\nText model\n").lstrip("\n")
        if "(s/n)" not in body and "npm run login" not in body:
            log.write_text(strip_qr(session.text()), encoding="utf-8")
            raise SystemExit("a saída do modelo não parou antes do login externo")
        write_slice("cli-4-modelo", strip_qr(body))
        log.write_text(strip_qr(session.text()), encoding="utf-8")
    finally:
        session.stop()
        subprocess.run(["rm", "-rf", str(data)], check=False)


def capture_ready(log: Path) -> None:
    data = Path("/tmp/pi-bot-data")
    if data.exists():
        subprocess.run(["rm", "-rf", str(data)], check=True)
    session = Session(data)
    session.start()
    try:
        if not session.wait("q - Exit without saving", 40):
            log.write_text(strip_qr(session.text()), encoding="utf-8")
            raise SystemExit("menu inicial (pronto) não apareceu")
        session.send("1\n")
        if not session.wait("1 - Telegram", 20):
            raise SystemExit("gateway não abriu")
        session.send("2\n")
        if not session.wait("1 - Allowed numbers", 20):
            raise SystemExit("WhatsApp não abriu")
        session.send("1\n")
        if not session.wait("Numbers with country code", 20):
            raise SystemExit("número não foi pedido")
        session.send(FAKE_NUMBER + "\n")
        if not session.wait(FAKE_NUMBER, 20):
            raise SystemExit("número recusado")
        session.send("s\n")
        if not session.wait("WhatsApp saved on the volume", 20):
            log.write_text(strip_qr(session.text()), encoding="utf-8")
            raise SystemExit("WhatsApp não foi gravado")
        # Saving WhatsApp returns to the gateway menu, not the main menu.
        if not session.wait_tail("Active: WhatsApp", 20):
            log.write_text(strip_qr(session.text()), encoding="utf-8")
            raise SystemExit("não voltou ao menu do gateway")
        session.send("b\n")
        if not session.wait_tail("configured (WhatsApp)", 20):
            log.write_text(strip_qr(session.text()), encoding="utf-8")
            raise SystemExit("não voltou ao menu principal")

        session.send("2\n")
        if not session.wait_tail("1 - Provider", 20):
            log.write_text(strip_qr(session.text()), encoding="utf-8")
            raise SystemExit("menu de texto não abriu")
        session.send("1\n")
        if not session.wait("Provider [", 20):
            raise SystemExit("provedor não foi pedido")
        session.send("anthropic\n")
        if not session.wait("API key (hidden):", 20):
            log.write_text(strip_qr(session.text()), encoding="utf-8")
            raise SystemExit("chave não foi pedida")
        session.send(FAKE_KEY + "\n")
        if not session.wait("Key saved for anthropic", 30):
            log.write_text(strip_qr(session.text()), encoding="utf-8")
            raise SystemExit("catálogo do provedor não carregou")
        session.send("2\n")
        if not session.wait("claude-sonnet-4-6", 20):
            log.write_text(strip_qr(session.text()), encoding="utf-8")
            raise SystemExit("modelo claude-sonnet-4-6 não está no catálogo")
        if not session.wait("Model [", 20):
            raise SystemExit("prompt de modelo não apareceu")
        session.send("claude-sonnet-4-6\n")
        if not session.wait("Model: claude-sonnet-4-6", 20):
            log.write_text(strip_qr(session.text()), encoding="utf-8")
            raise SystemExit("modelo não ficou selecionado")
        session.send("4\n")
        if not session.wait("Effort for", 20):
            log.write_text(strip_qr(session.text()), encoding="utf-8")
            raise SystemExit("esforço não foi pedido")
        effort_window = session.text()
        effort_line = next(
            (line for line in effort_window.splitlines() if line.startswith("Effort for ")),
            "",
        )
        session.send("medium\n" if " medium" in f" {effort_line} " else "\n")
        if not session.wait("Effort: ", 20):
            log.write_text(strip_qr(session.text()), encoding="utf-8")
            raise SystemExit("esforço não foi aceito")
        session.send("s\n")
        if not session.wait("Saved on the volume (anthropic)", 40):
            log.write_text(strip_qr(session.text()), encoding="utf-8")
            raise SystemExit("modelo de texto não foi gravado")
        if not session.wait_tail("configured (anthropic/", 20):
            log.write_text(strip_qr(session.text()), encoding="utf-8")
            raise SystemExit("não voltou ao menu depois do texto")

        session.send("3\n")
        deadline = time.time() + 30
        while time.time() < deadline:
            session.pump(0.1)
            image_tail = session.tail(24)
            if "accepts images" in image_tail or "does not accept images" in image_tail:
                break
        else:
            log.write_text(strip_qr(session.text()), encoding="utf-8")
            raise SystemExit("menu de imagem não abriu")
        time.sleep(0.3)
        session.pump(0.2)
        image_tail = session.tail(24)
        if "does not accept images" in image_tail:
            session.send("-\n")
            if not session.wait_tail("Image model disabled", 20):
                raise SystemExit("não desligou a imagem")
        session.send("s\n")
        if not session.wait_tail("3 - Image model", 40):
            log.write_text(strip_qr(session.text()), encoding="utf-8")
            raise SystemExit("não voltou ao menu depois da imagem")

        session.send("5\n")
        if not session.wait_tail("1 - Composio", 20):
            raise SystemExit("menu MCP não abriu")
        session.send("6\n")
        if not session.wait_tail("MCP platform set to none", 20):
            log.write_text(strip_qr(session.text()), encoding="utf-8")
            raise SystemExit("MCP none não foi escolhido")
        session.send("s\n")
        if not session.wait_tail("not set (none)", 20):
            log.write_text(strip_qr(session.text()), encoding="utf-8")
            raise SystemExit("não voltou ao menu depois do MCP")

        session.send("s\n")
        if not session.wait("No gateway is running", 40):
            log.write_text(strip_qr(session.text()), encoding="utf-8")
            raise SystemExit("confirmação final não apareceu")
        time.sleep(0.4)
        session.pump(0.2)
        write_slice("cli-5-pronto", slice_from(session.text(), "\nSetup\n").lstrip("\n"))
        log.write_text(strip_qr(session.text()), encoding="utf-8")
    finally:
        session.stop()
        subprocess.run(["rm", "-rf", str(data)], check=False)


def main() -> None:
    if not (REPO / "package.json").exists():
        raise SystemExit(f"raiz do repositório não encontrada a partir de {REPO}")
    logs = Path("/tmp/pi-bot-capture-logs")
    logs.mkdir(parents=True, exist_ok=True)
    which = subprocess.run(["npm", "--version"], check=False, capture_output=True, text=True)
    node = subprocess.run([NODE, "--version"], check=False, capture_output=True, text=True)
    print(f"node {node.stdout.strip()} npm {which.stdout.strip()}")
    capture_gateway(logs / "gateway.txt")
    capture_model(logs / "model.txt")
    capture_ready(logs / "ready.txt")
    print("ok")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
