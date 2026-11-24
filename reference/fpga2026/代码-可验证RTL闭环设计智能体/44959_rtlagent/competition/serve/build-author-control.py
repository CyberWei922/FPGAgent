"""Offline, opt-in build against the one reviewed cloud backend. No replacement.

Usage: python3 build-author-control.py NEW_OUTPUT_DIRECTORY
Then set LD_PRELOAD=OUTPUT/libauthor-control.so and RTL_AUTHOR_CONTROL_DIR to a
new owned 0700 directory on the dedicated 8B process ONLY. Leave 27B unchanged.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys

PINNED = {
    '/opt/llamacpp/llama-server': '290708d22f8b495d36b8aedd0afb0cdc081c415548f855e6a950a75dd742ad97',
    '/opt/llamacpp/libllama.so': '8cdfc03ff87bf1463d11ef367b61202af0b805812ba3d76321b820b1b9e5ab94',
}

def digest(p):
    return hashlib.file_digest(Path(p).open('rb'), 'sha256').hexdigest()

def main():
    if sys.platform != 'linux' or len(sys.argv) != 2:
        raise SystemExit('Linux only; provide one NEW absolute build directory')
    out = Path(sys.argv[1])
    if not out.is_absolute() or out == Path('/') or out.exists():
        raise SystemExit('A new absolute output directory is required')
    for p, expected in PINNED.items():
        if digest(p) != expected:
            raise SystemExit('Unreviewed backend ABI/build; refusing preload: '+p)
    source = Path(__file__).resolve().parents[2] / 'third_party/llama-author-control'
    out.mkdir(mode=0o700)
    command = ['g++', '-std=c++17', '-O2', '-fPIC', '-shared', str(source/'author-control.cpp'), '-ldl', '-o', str(out/'libauthor-control.so')]
    result = subprocess.run(command, capture_output=True, text=True, timeout=120)
    (out/'BUILD.log').write_text(result.stdout+result.stderr)
    if result.returncode:
        raise SystemExit('Build failed; preserved '+str(out/'BUILD.log'))
    manifest = {'version':'rtl-author-control-v3','abi':'f114f91','backend':PINNED,
                'sources':{n:digest(source/n) for n in ['author-control.cpp','phase.h','llama-sampler-abi.h']},
                'library_sha256':digest(out/'libauthor-control.so'),'command':command,
                'compiler':subprocess.check_output(['g++','--version'],text=True).splitlines()[0]}
    (out/'BUILD.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print(json.dumps(manifest))

if __name__ == '__main__':
    main()
