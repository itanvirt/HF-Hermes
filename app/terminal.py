"""Browser-based terminal: bridges a WebSocket (xterm.js) to a PTY."""
import asyncio
import fcntl
import os
import pty
import struct
import termios

from fastapi import WebSocket, WebSocketDisconnect


def _set_winsize(fd: int, rows: int, cols: int) -> None:
    winsize = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)


async def run_pty(websocket: WebSocket, argv: list[str], cwd: str | None = None) -> None:
    """Spawn argv in a PTY and shuttle bytes between it and the websocket."""
    pid, master_fd = pty.fork()

    if pid == 0:  # child
        try:
            if cwd:
                os.chdir(cwd)
            os.execvp(argv[0], argv)
        except FileNotFoundError:
            os._exit(127)

    os.set_blocking(master_fd, False)
    loop = asyncio.get_event_loop()

    async def read_pty():
        while True:
            try:
                data = await loop.run_in_executor(None, _safe_read, master_fd)
            except OSError:
                break
            if data is None:
                break
            if data:
                await websocket.send_bytes(data)
            else:
                await asyncio.sleep(0.02)

    def _safe_read(fd: int) -> bytes | None:
        try:
            return os.read(fd, 4096)
        except BlockingIOError:
            return b""
        except OSError:
            return None

    reader_task = asyncio.create_task(read_pty())

    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
            if "text" in message and message["text"] is not None:
                text = message["text"]
                if text.startswith("\x01RESIZE:"):
                    try:
                        rows, cols = map(int, text.removeprefix("\x01RESIZE:").split(","))
                        _set_winsize(master_fd, rows, cols)
                    except ValueError:
                        pass
                    continue
                os.write(master_fd, text.encode())
            elif "bytes" in message and message["bytes"] is not None:
                os.write(master_fd, message["bytes"])
    except (WebSocketDisconnect, OSError):
        pass
    finally:
        reader_task.cancel()
        try:
            os.kill(pid, 9)
        except ProcessLookupError:
            pass
        try:
            os.close(master_fd)
        except OSError:
            pass
