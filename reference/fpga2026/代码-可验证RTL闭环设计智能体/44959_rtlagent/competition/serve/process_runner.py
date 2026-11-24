"""One Linux request supervisor. Reap orphans even when EDA starts new sessions.

Only descendants of this per-request process are touched. The persistent model
and HTTP server are outside this tree. No third-party Python dependency is used.
"""
from __future__ import annotations
import argparse
import ctypes
import math
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def descendants(root: int) -> dict[int, int]:
    table = {}
    if sys.platform != 'linux':
        return table
    for item in Path('/proc').iterdir():
        if not item.name.isdigit():
            continue
        try:
            fields = (item / 'stat').read_text().rsplit(')', 1)[1].split()
            table[int(item.name)] = (int(fields[1]), int(fields[2]))
        except (OSError, ValueError, IndexError):
            continue
    owned = {root}
    while True:
        more = {pid for pid, (parent, _) in table.items() if parent in owned}
        if more <= owned:
            break
        owned |= more
    return {pid: table[pid][1] for pid in owned if pid != root and pid in table}


def signal_owned(sig: int) -> None:
    owned = descendants(os.getpid())
    for group in set(owned.values()) - {os.getpgrp()}:
        try:
            os.killpg(group, sig)
        except ProcessLookupError:
            pass
    for pid in owned:
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            pass


def reap(keep: int | None = None) -> None:
    for pid in descendants(os.getpid()):
        if pid == keep:
            continue
        try:
            os.waitpid(pid, os.WNOHANG)
        except (ChildProcessError, ProcessLookupError):
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--timeout', type=float, required=True)
    parser.add_argument('--grace', type=float, default=2)
    parser.add_argument('--cwd', required=True)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not math.isfinite(args.timeout) or not math.isfinite(args.grace) or args.timeout <= 0 or args.grace < 0 or not command:
        parser.error('positive timeout and a command are required')
    if sys.platform != 'linux':
        parser.error('production process supervision requires Linux')
    profile = json.loads((Path(__file__).resolve().parents[1] / 'environment/versions.json').read_text(encoding='utf-8'))
    target_python = tuple(map(int, profile['provided_by_image']['python'].split('.')))
    if sys.version_info[:2] != target_python:
        parser.error('Use the Python ' + profile['provided_by_image']['python'] + ' interpreter from the validation image')
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError('Cannot become a child subreaper')
    stopped = False
    def stop(_sig, _frame):
        nonlocal stopped
        stopped = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    proc = subprocess.Popen(command, cwd=args.cwd, start_new_session=True)
    deadline = time.monotonic() + args.timeout
    timed_out = False
    while proc.poll() is None:
        if stopped or time.monotonic() >= deadline:
            timed_out = True
            break
        reap(proc.pid)
        time.sleep(0.025)
    # Sweep after normal exit too: a successful wrapper may leave EDA children.
    signal_owned(signal.SIGTERM)
    grace_end = time.monotonic() + args.grace
    while descendants(os.getpid()) and time.monotonic() < grace_end:
        proc.poll()
        reap(proc.pid)
        time.sleep(0.025)
    signal_owned(signal.SIGKILL)
    proc.wait()
    reap_end = time.monotonic() + 2
    while descendants(os.getpid()) and time.monotonic() < reap_end:
        signal_owned(signal.SIGKILL)
        reap()
        time.sleep(0.025)
    if descendants(os.getpid()):
        return 125
    return 124 if timed_out else proc.returncode


if __name__ == '__main__':
    raise SystemExit(main())
