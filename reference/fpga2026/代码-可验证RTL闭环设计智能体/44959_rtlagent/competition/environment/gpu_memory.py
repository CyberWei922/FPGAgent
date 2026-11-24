"""Read real device memory via HIP, including WSL installations without rocm-smi."""
import ctypes
import json
import os
from pathlib import Path
import sys


def memory(index=0):
    root = os.environ.get('ROCM_PATH') or os.environ.get('ROCM_HOME')
    library = str(Path(root) / 'lib/libamdhip64.so') if root else 'libamdhip64.so'
    hip = ctypes.CDLL(library)
    hip.hipSetDevice.argtypes = [ctypes.c_int]
    hip.hipMemGetInfo.argtypes = [ctypes.POINTER(ctypes.c_size_t), ctypes.POINTER(ctypes.c_size_t)]
    for operation, arguments in [(hip.hipSetDevice, [index])]:
        rc = operation(*arguments)
        if rc != 0:
            raise RuntimeError(f'HIP initialization failed: {rc}')
    free, total = ctypes.c_size_t(), ctypes.c_size_t()
    rc = hip.hipMemGetInfo(ctypes.byref(free), ctypes.byref(total))
    if rc != 0 or total.value <= 0 or free.value > total.value:
        raise RuntimeError(f'HIP memory counters unavailable: {rc}')
    return dict(source='hipMemGetInfo', device=index, usedBytes=total.value - free.value,
                totalBytes=total.value, usedGb=(total.value - free.value) / 1024 ** 3,
                totalGb=total.value / 1024 ** 3)


if __name__ == '__main__':
    print(json.dumps(memory(int(sys.argv[1]) if len(sys.argv) > 1 else 0)))
