#!/usr/bin/env python3
"""Execute one pasted shell block, then answer its /dev/tty secret prompt."""

import base64
import errno
import os
import pty
import select
import signal
import sys
import termios
import time


command = base64.b64decode(os.environ["MX_PTY_COMMAND_B64"]).decode("utf-8")
secret = os.environ["MX_PTY_SECRET"]
shell_path = os.environ["MX_PTY_SHELL"]
pid, master = pty.fork()

if pid == 0:
    environment = os.environ.copy()
    environment["PS1"] = "__MX_PTY_PROMPT__"
    environment["PS2"] = "__MX_PTY_CONTINUE__"
    shell_name = os.path.basename(shell_path)
    if shell_name == "bash":
        arguments = ["bash", "--noprofile", "--norc", "-i"]
    elif shell_name == "zsh":
        arguments = ["zsh", "-f", "-i"]
    else:
        raise ValueError(f"unsupported test shell: {shell_path}")
    os.execve(shell_path, arguments, environment)

output = bytearray()


def read_until(marker, timeout=8, occurrences=1):
    deadline = time.monotonic() + timeout
    marker = marker.encode("utf-8")
    while output.count(marker) < occurrences:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(f"timed out waiting for {marker!r}")
        ready, _, _ = select.select([master], [], [], remaining)
        if not ready:
            continue
        try:
            chunk = os.read(master, 4096)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if not chunk:
            break
        output.extend(chunk)
    if output.count(marker) < occurrences:
        raise RuntimeError(
            f"shell exited before occurrence {occurrences} of {marker!r}"
        )


def write_all(value):
    pending = value.encode("utf-8")
    while pending:
        written = os.write(master, pending)
        pending = pending[written:]


def wait_for_noecho(timeout=2):
    """Wait until the shell's silent read has disabled terminal echo."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not (termios.tcgetattr(master)[3] & termios.ECHO):
            return
        time.sleep(0.005)
    raise TimeoutError("silent tty read did not disable terminal echo")


def wait_for_child(timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        finished, status = os.waitpid(pid, os.WNOHANG)
        if finished == pid:
            return status
        ready, _, _ = select.select([master], [], [], 0.05)
        if ready:
            try:
                output.extend(os.read(master, 4096))
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
    raise TimeoutError("parent shell did not exit after the pasted subshell returned")


try:
    read_until("__MX_PTY_PROMPT__")

    # One write models the browser's whole-block paste. The subshell must be
    # completely parsed before read starts consuming from the controlling tty.
    write_all(command + "\n")
    # The short printf source line contains the first literal; the second is
    # emitted only after the shell has parsed the closing parenthesis and begun
    # executing the tty read. This works despite shell-specific ANSI prompts.
    read_until("API Key: ", occurrences=2)
    wait_for_noecho()
    if b"__MOCK_CURL_RAN__" in output:
        raise RuntimeError("curl ran before the separate tty secret was supplied")

    write_all(secret + "\n")
    read_until("__MOCK_CURL_RAN__")
    write_all(
        "printf '__CURL_STATUS:%s__\\n' \"$?\"; "
        "printf '__PARENT_KEY:%s__\\n' \"${MX_INSIGHT_API_KEY-unset}\"; "
        "printf '__PARENT_SHELL_ALIVE__\\n'; exit 0\n"
    )
    read_until("__CURL_STATUS:37__")
    read_until("__PARENT_KEY:unset__")
    read_until("__PARENT_SHELL_ALIVE__")
    status = wait_for_child()
    sys.stdout.buffer.write(output)
    sys.exit(os.waitstatus_to_exitcode(status))
except Exception as error:
    sys.stdout.buffer.write(output)
    print(f"pty paste failed: {error}", file=sys.stderr)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    os.waitpid(pid, 0)
    sys.exit(1)
finally:
    os.close(master)
