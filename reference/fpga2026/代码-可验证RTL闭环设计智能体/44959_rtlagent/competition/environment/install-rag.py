"""Install one hash-pinned NumPy wheel into a private directory, without pip/network."""
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


def install(wheels, target):
    lock = Path(__file__).with_name('rag-wheels.lock.json')
    version = f'{sys.version_info.major}.{sys.version_info.minor}'
    if sys.implementation.name != 'cpython' or sys.platform != 'linux' or platform.machine() != 'x86_64':
        raise ValueError('Linux x86_64 CPython required')
    libc, release = platform.libc_ver()
    if libc != 'glibc' or tuple(map(int, release.split('.')[:2])) < (2, 28):
        raise ValueError('glibc >= 2.28 required')
    rows = [r for r in json.loads(lock.read_text())['packages'] if r['python'] == version]
    if len(rows) != 1:
        raise ValueError('No pinned NumPy wheel for this Python')
    row = rows[0]; wheel = wheels/row['filename']
    if wheel.is_symlink() or wheel.stat().st_size != row['bytes'] or hashlib.sha256(wheel.read_bytes()).hexdigest() != row['sha256']:
        raise ValueError('NumPy wheel hash mismatch')
    if target.exists():
        raise ValueError('Target already exists')
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix='rag-numpy-', dir=target.parent))
    try:
        with zipfile.ZipFile(wheel) as archive:
            for item in archive.infolist():
                name = Path(item.filename)
                if name.is_absolute() or '..' in name.parts or '\\' in item.filename or stat.S_ISLNK(item.external_attr >> 16) or any(p.endswith('.data') for p in name.parts):
                    raise ValueError('Unsafe wheel entry')
            archive.extractall(temporary)
        probe = subprocess.run([sys.executable, '-B', '-c',
            'import sys;sys.path.insert(0,sys.argv[1]);import numpy as n;assert n.__version__=="2.3.4";assert n.ones(768)@n.ones(768)==768', str(temporary)],
            capture_output=True, timeout=15)
        if probe.returncode:
            raise ValueError('NumPy native import/vector probe failed')
        receipt = dict(python=platform.python_version(), wheel=row, network_used=False, vector_probe='passed')
        (temporary/'installed.json').write_text(json.dumps(receipt, indent=2)+'\n')
        temporary.rename(target)
        return receipt
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--wheel-dir', type=Path, required=True)
    p.add_argument('--target', type=Path, required=True)
    a = p.parse_args()
    print(json.dumps(install(a.wheel_dir.resolve(), a.target.resolve()), indent=2))
