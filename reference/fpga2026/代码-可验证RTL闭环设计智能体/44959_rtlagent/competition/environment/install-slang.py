"""Install the pinned local wheel bundle without pip, network or global changes.

Used during Docker build / experimental runtime preparation, never per request.
The target is a private import directory; wheel dist-info and licenses are kept.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path
import platform
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile


def install(wheel_dir: Path, target: Path) -> dict:
    lock_path = Path(__file__).with_name('slang-wheels.lock.json')
    lock = json.loads(lock_path.read_text())
    version = f'{sys.version_info.major}.{sys.version_info.minor}'
    if sys.implementation.name != 'cpython' or sys.platform != 'linux' or platform.machine() != 'x86_64':
        raise RuntimeError('This wheel bundle requires Linux x86_64 CPython')
    libc, release = platform.libc_ver()
    if libc != 'glibc' or tuple(map(int, release.split('.')[:2])) < (2, 28):
        raise RuntimeError('This wheel bundle requires glibc >= 2.28')
    if version not in ('3.12', '3.14'):
        raise RuntimeError('No pinned nanobind wheel for this Python version')
    rows = [row for row in lock['packages'] if row['python'] in ('abi3', version)]
    assert len(rows) == 2
    # Verify both archives before creating or extracting the target.
    for row in rows:
        file = wheel_dir / row['filename']
        if file.is_symlink() or not file.is_file() or file.stat().st_size != row['bytes'] or hashlib.sha256(file.read_bytes()).hexdigest() != row['sha256']:
            raise RuntimeError('Wheel checksum mismatch: ' + row['filename'])
    if target.exists():
        raise RuntimeError('Target already exists; use a fresh private directory')
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix='slang-install-', dir=target.parent))
    try:
        for row in rows:
            with zipfile.ZipFile(wheel_dir / row['filename']) as archive:
                for item in archive.infolist():
                    name = Path(item.filename)
                    if name.is_absolute() or '..' in name.parts or '\\' in item.filename or stat.S_ISLNK(item.external_attr >> 16):
                        raise RuntimeError('Invalid wheel entry')
                    if '.data' in name.parts or any(part.endswith('.data') for part in name.parts):
                        raise RuntimeError('Wheel requires an unsupported install scheme')
                archive.extractall(temporary)
        probe = subprocess.run([sys.executable, '-B', '-c',
            'import sys;sys.path.insert(0,sys.argv[1]);import pyslang;assert pyslang.__version__=="12.0.0";from pyslang.driver import Driver;Driver()',
            str(temporary)], capture_output=True, timeout=15)
        if probe.returncode:
            raise RuntimeError('Pinned pyslang import/driver probe failed')
        receipt = {'schema_version': 1, 'python': platform.python_version(), 'platform': platform.platform(),
                   'lock_sha256': hashlib.sha256(lock_path.read_bytes()).hexdigest(),
                   'packages': [{key: row[key] for key in ('name', 'version', 'filename', 'sha256')} for row in rows],
                   'network_used': False, 'import_driver_probe': 'passed'}
        (temporary / 'installed.json').write_text(json.dumps(receipt, indent=2) + '\n')
        temporary.rename(target)
        return receipt
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--wheel-dir', type=Path, required=True)
    parser.add_argument('--target', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(install(args.wheel_dir.resolve(), args.target.resolve()), indent=2))
