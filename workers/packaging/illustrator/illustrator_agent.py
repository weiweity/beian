from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import queue
import sys
import threading
import time
import uuid
from typing import Any


_AGENT_DIR = Path(__file__).resolve().parent
if str(_AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(_AGENT_DIR))
from unattended_wait import clamp_timeout_ms

PROTOCOL = "beian.illustrator.v1"
DEFAULT_PIPE_NAME = "beian-illustrator-v1"
MAX_RESPONSE_BYTES = 64 * 1024
HEARTBEAT_STALE_SECONDS = 30
HEARTBEAT_FUTURE_SKEW_SECONDS = 5
REPO_ROOT = Path(__file__).resolve().parents[3]
AGENT_SCRIPT = REPO_ROOT / "scripts" / "windows" / "illustrator-agent.ps1"
VERSION_FILE = REPO_ROOT / "VERSION"


class IllustratorAgentError(RuntimeError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = dict(details or {})

    def as_dict(self) -> dict[str, Any]:
        return {
            "ok": False,
            "code": self.code,
            "message": self.message,
            "details": self.details,
        }


def encode_request(
    command: str,
    *,
    config_path: str | None = None,
    exporter: str | None = None,
    timeout_seconds: int = 420,
    request_id: str | None = None,
) -> tuple[str, bytes]:
    if command not in {"probe", "run", "smoke"}:
        raise ValueError(f"unsupported Illustrator agent command: {command}")
    request_id = request_id or uuid.uuid4().hex
    payload: dict[str, Any] = {
        "protocol": PROTOCOL,
        "id": request_id,
        "command": command,
        "timeout_ms": clamp_timeout_ms(timeout_seconds),
    }
    if command == "run":
        if not config_path:
            raise ValueError("config_path is required for run")
        if exporter not in {"legacy", "structure"}:
            raise ValueError("exporter must be legacy or structure")
        payload["config_path"] = str(config_path)
        payload["exporter"] = exporter
    raw = (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    if len(raw) > 64 * 1024:
        raise ValueError("Illustrator agent request is too large")
    return request_id, raw


def decode_response(raw: bytes, request_id: str) -> dict[str, Any]:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise IllustratorAgentError(
            "illustrator_agent_protocol_error",
            f"invalid UTF-8 JSON response: {error}",
        ) from error
    if not isinstance(value, dict):
        raise IllustratorAgentError(
            "illustrator_agent_protocol_error",
            "agent response is not an object",
        )
    if value.get("protocol") != PROTOCOL or value.get("id") != request_id:
        raise IllustratorAgentError(
            "illustrator_agent_protocol_error",
            "agent response protocol or request id does not match",
        )
    if value.get("ok") is not True:
        raise IllustratorAgentError(
            str(value.get("code") or "illustrator_agent_failed"),
            str(value.get("message") or "Illustrator agent request failed"),
            details=value.get("details") if isinstance(value.get("details"), dict) else None,
        )
    return value


def _kernel32() -> Any:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.WaitNamedPipeW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD]
    kernel32.WaitNamedPipeW.restype = wintypes.BOOL
    kernel32.CreateFileW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    ]
    kernel32.CreateFileW.restype = wintypes.HANDLE
    kernel32.WriteFile.argtypes = [
        wintypes.HANDLE,
        wintypes.LPCVOID,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD),
        wintypes.LPVOID,
    ]
    kernel32.WriteFile.restype = wintypes.BOOL
    kernel32.ReadFile.argtypes = [
        wintypes.HANDLE,
        wintypes.LPVOID,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD),
        wintypes.LPVOID,
    ]
    kernel32.ReadFile.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    kernel32.GetNamedPipeServerProcessId.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.ULONG)]
    kernel32.GetNamedPipeServerProcessId.restype = wintypes.BOOL
    kernel32.CancelIoEx.argtypes = [wintypes.HANDLE, wintypes.LPVOID]
    kernel32.CancelIoEx.restype = wintypes.BOOL
    return kernel32


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _expected_agent_pid(heartbeat_name: str, pipe_name: str) -> int:
    if Path(heartbeat_name).name != heartbeat_name:
        raise IllustratorAgentError(
            "illustrator_agent_protocol_error",
            "Illustrator desktop agent heartbeat name is invalid",
        )
    data_root = Path(os.environ.get("WB_DATA_DIR") or r"C:\supply\data")
    heartbeat_path = data_root / "runtime" / heartbeat_name
    try:
        heartbeat = json.loads(heartbeat_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise IllustratorAgentError(
            "illustrator_agent_offline",
            f"Illustrator desktop agent heartbeat is unavailable: {error}",
        ) from error
    expected_script_sha = _file_sha256(AGENT_SCRIPT)
    expected_version = VERSION_FILE.read_text(encoding="utf-8").strip()
    try:
        updated_epoch = datetime.fromisoformat(
            str(heartbeat.get("updated_at") or "").replace("Z", "+00:00")
        ).timestamp()
    except (TypeError, ValueError):
        updated_epoch = 0
    heartbeat_age = time.time() - updated_epoch
    try:
        session_id = int(heartbeat.get("session_id") or 0)
        pid = int(heartbeat.get("pid") or 0)
    except (TypeError, ValueError):
        session_id = 0
        pid = 0
    state = str(heartbeat.get("state") or "")
    if (
        heartbeat.get("protocol") != PROTOCOL
        or heartbeat.get("pipe") != pipe_name
        or str(heartbeat.get("script_sha256") or "").lower() != expected_script_sha
        or heartbeat.get("release_version") != expected_version
        or session_id <= 0
        or heartbeat_age < -HEARTBEAT_FUTURE_SKEW_SECONDS
        or heartbeat_age > HEARTBEAT_STALE_SECONDS
    ):
        raise IllustratorAgentError(
            "illustrator_agent_protocol_error",
            "Illustrator desktop agent heartbeat identity does not match this checkout",
        )
    if state == "faulted":
        raise IllustratorAgentError(
            "illustrator_agent_faulted",
            "Illustrator desktop agent requires an administrator restart",
            details={"last_code": str(heartbeat.get("last_code") or "")},
        )
    if state not in {"idle", "busy"}:
        raise IllustratorAgentError(
            "illustrator_agent_protocol_error",
            "Illustrator desktop agent heartbeat state is invalid",
        )
    if pid <= 0:
        raise IllustratorAgentError(
            "illustrator_agent_protocol_error",
            "Illustrator desktop agent heartbeat has no valid process id",
        )
    return pid


def _wait_for_pipe(kernel32: Any, pipe_path: str, timeout_seconds: float) -> None:
    deadline = time.monotonic() + timeout_seconds
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise IllustratorAgentError(
                "illustrator_agent_offline",
                "Illustrator desktop agent pipe is not available",
            )
        if kernel32.WaitNamedPipeW(pipe_path, max(1, min(1000, int(remaining * 1000)))):
            return
        error_code = ctypes.get_last_error()
        if error_code not in {2, 121, 231}:
            raise IllustratorAgentError(
                "illustrator_agent_offline",
                f"WaitNamedPipe failed with Windows error {error_code}",
            )
        time.sleep(min(0.1, remaining))


def _exchange(
    pipe_name: str,
    request: bytes,
    connect_timeout_seconds: float,
    response_timeout_seconds: float,
    expected_server_pid: int,
) -> bytes:
    if sys.platform != "win32":
        raise IllustratorAgentError(
            "illustrator_agent_wrong_platform",
            "Windows Illustrator desktop agent is only available on Windows",
        )
    kernel32 = _kernel32()
    pipe_path = rf"\\.\pipe\{pipe_name}"
    _wait_for_pipe(kernel32, pipe_path, connect_timeout_seconds)
    generic_read = 0x80000000
    generic_write = 0x40000000
    open_existing = 3
    handle = kernel32.CreateFileW(
        pipe_path,
        generic_read | generic_write,
        0,
        None,
        open_existing,
        0,
        None,
    )
    invalid_handle = ctypes.c_void_p(-1).value
    if handle in {None, invalid_handle}:
        error_code = ctypes.get_last_error()
        raise IllustratorAgentError(
            "illustrator_agent_offline",
            f"CreateFile for Illustrator agent pipe failed with Windows error {error_code}",
        )
    try:
        server_pid = wintypes.ULONG()
        if not kernel32.GetNamedPipeServerProcessId(handle, ctypes.byref(server_pid)):
            error_code = ctypes.get_last_error()
            raise IllustratorAgentError(
                "illustrator_agent_protocol_error",
                f"GetNamedPipeServerProcessId failed with Windows error {error_code}",
            )
        if int(server_pid.value) != expected_server_pid:
            raise IllustratorAgentError(
                "illustrator_agent_protocol_error",
                "Illustrator desktop agent pipe server does not match its heartbeat",
            )
        offset = 0
        while offset < len(request):
            written = wintypes.DWORD()
            chunk = request[offset:]
            buffer = ctypes.create_string_buffer(chunk)
            if not kernel32.WriteFile(handle, buffer, len(chunk), ctypes.byref(written), None):
                error_code = ctypes.get_last_error()
                raise IllustratorAgentError(
                    "illustrator_agent_protocol_error",
                    f"pipe write failed with Windows error {error_code}",
                )
            if written.value <= 0:
                raise IllustratorAgentError(
                    "illustrator_agent_protocol_error",
                    "pipe write returned zero bytes",
                )
            offset += written.value

        outcome: queue.Queue[tuple[bool, bytes | BaseException]] = queue.Queue(maxsize=1)

        def read_response() -> None:
            try:
                response = bytearray()
                while b"\n" not in response:
                    buffer = ctypes.create_string_buffer(4096)
                    read = wintypes.DWORD()
                    if not kernel32.ReadFile(handle, buffer, len(buffer), ctypes.byref(read), None):
                        error_code = ctypes.get_last_error()
                        raise IllustratorAgentError(
                            "illustrator_agent_protocol_error",
                            f"pipe read failed with Windows error {error_code}",
                        )
                    if read.value <= 0:
                        raise IllustratorAgentError(
                            "illustrator_agent_protocol_error",
                            "Illustrator agent closed the pipe without a response",
                        )
                    response.extend(buffer.raw[: read.value])
                    if len(response) > MAX_RESPONSE_BYTES:
                        raise IllustratorAgentError(
                            "illustrator_agent_protocol_error",
                            "Illustrator agent response is too large",
                        )
                outcome.put((True, bytes(response.split(b"\n", 1)[0])))
            except BaseException as error:
                outcome.put((False, error))

        reader = threading.Thread(target=read_response, name="illustrator-agent-pipe-read", daemon=True)
        reader.start()
        reader.join(max(1.0, response_timeout_seconds))
        if reader.is_alive():
            kernel32.CancelIoEx(handle, None)
            reader.join(1)
            raise IllustratorAgentError(
                "illustrator_timeout",
                "Illustrator desktop agent response timed out",
            )
        ok, value = outcome.get_nowait()
        if not ok:
            assert isinstance(value, BaseException)
            raise value
        assert isinstance(value, bytes)
        return value
    finally:
        kernel32.CloseHandle(handle)


def request_agent(
    command: str,
    *,
    config_path: str | None = None,
    exporter: str | None = None,
    timeout_seconds: int = 420,
    connect_timeout_seconds: float = 15,
    pipe_name: str | None = None,
    heartbeat_name: str = "illustrator-agent.json",
) -> dict[str, Any]:
    request_id, request = encode_request(
        command,
        config_path=config_path,
        exporter=exporter,
        timeout_seconds=timeout_seconds,
    )
    selected_pipe = pipe_name or os.environ.get("BEIAN_ILLUSTRATOR_PIPE") or DEFAULT_PIPE_NAME
    expected_server_pid = _expected_agent_pid(heartbeat_name, selected_pipe) if sys.platform == "win32" else 0
    pipe_connect_timeout = float(connect_timeout_seconds)
    if sys.platform == "win32":
        heartbeat_path = Path(os.environ.get("WB_DATA_DIR") or r"C:\supply\data") / "runtime" / heartbeat_name
        try:
            heartbeat = json.loads(heartbeat_path.read_text(encoding="utf-8"))
            if str(heartbeat.get("state") or "") == "busy":
                pipe_connect_timeout = max(pipe_connect_timeout, float(timeout_seconds))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError):
            pass
    response = _exchange(
        selected_pipe,
        request,
        pipe_connect_timeout,
        timeout_seconds,
        expected_server_pid,
    )
    return decode_response(response, request_id)


def main() -> int:
    parser = argparse.ArgumentParser(description="Client for the Session 1 Illustrator desktop agent")
    parser.add_argument("command", choices=("probe", "smoke"))
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--pipe", default="")
    parser.add_argument("--heartbeat", default="illustrator-agent.json")
    args = parser.parse_args()
    try:
        result = request_agent(
            args.command,
            timeout_seconds=args.timeout,
            connect_timeout_seconds=min(30, max(5, args.timeout)),
            pipe_name=args.pipe or None,
            heartbeat_name=args.heartbeat,
        )
    except IllustratorAgentError as error:
        print(json.dumps(error.as_dict(), ensure_ascii=True, separators=(",", ":")))
        return 2
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
