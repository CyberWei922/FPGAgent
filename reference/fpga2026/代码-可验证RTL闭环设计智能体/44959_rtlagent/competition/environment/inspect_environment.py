"""Offline version inventory. Does not install packages or load model weights."""
from __future__ import annotations
import argparse
import importlib.metadata
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import time

HERE = Path(__file__).resolve().parent

def command(arguments, timeout=8, cwd=None):
    try:
        result = subprocess.run(arguments, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding='utf-8', errors='replace', timeout=timeout, cwd=cwd)
        return {'rc': result.returncode, 'text': result.stdout[-12000:]}
    except (OSError, subprocess.TimeoutExpired) as error:
        return {'rc': None, 'text': type(error).__name__}

def distribution(name):
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None

def release(text, components=3):
    match = re.search(r'(?<!\d)(\d+\.\d+(?:\.\d+)?)(?!\d)', text or '')
    return '.'.join(match[1].split('.')[:components]) if match else None

def llama_build(text):
    match = re.search(r'\b(?:version|build)\s*[:=]\s*b?(\d+)\b(?!\.)|\bbuild\s+(\d+)\b', text or '', re.I)
    return int(match[1] or match[2]) if match else None

def observe(env=None):
    env = os.environ if env is None else env
    observed = {'system': platform.system(), 'python': platform.python_version(),
        'python_executable': sys.executable, 'torch': distribution('torch'), 'vllm': distribution('vllm')}
    node = command([env.get('NODE_BIN', 'node'), '--version'])
    observed['node'] = release(node['text']) if node['rc'] == 0 else None
    if observed['system'] != 'Linux':
        observed.update(distribution=None, distribution_version=None, baseline_python=None,
            rocm=None, hip=None, torch_hip=None, llama_cpp_build=None, llama_backend=None, vivado=None)
        return observed
    try:
        os_info = {}
        for line in Path('/etc/os-release').read_text(encoding='utf-8').splitlines():
            if '=' in line:
                key, value = line.split('=', 1)
                os_info[key] = value.strip('"\'')
        observed.update(distribution=os_info.get('ID'), distribution_version=os_info.get('VERSION_ID'))
    except OSError:
        observed.update(distribution=None, distribution_version=None)
    baseline = command(['python3', '-c', 'import platform; print(platform.python_version())'])
    observed['baseline_python'] = release(baseline['text']) if baseline['rc'] == 0 else None
    rocm_roots = [Path(env[key]) for key in ['ROCM_PATH', 'ROCM_HOME'] if env.get(key)] + [Path('/opt/rocm')]
    observed['rocm'] = None
    for root in rocm_roots:
        for name in ['version', 'version-dev']:
            file = root / '.info' / name
            try:
                observed['rocm'] = release(file.read_text(encoding='utf-8'))
                if observed['rocm']:
                    observed['rocm_version_file'] = str(file)
                    break
            except OSError:
                pass
        if observed['rocm']:
            break
    hip_bin = env.get('HIPCONFIG_BIN') or shutil.which('hipconfig')
    if not hip_bin:
        hip_bin = next((str(root / 'bin/hipconfig') for root in rocm_roots if (root / 'bin/hipconfig').is_file()), 'hipconfig')
    hip = command([hip_bin, '--version'])
    observed['hip'] = release(hip['text']) if hip['rc'] == 0 else None
    observed['torch_hip'] = None
    if observed['torch']:
        torch = command([sys.executable, '-c', 'import json,torch; print(json.dumps({"hip":torch.version.hip}))'], timeout=20)
        if torch['rc'] == 0:
            try:
                observed['torch_hip'] = json.loads(torch['text'].splitlines()[-1]).get('hip')
            except (ValueError, IndexError):
                pass
    binary = env.get('LLAMA_SERVER_BIN') or shutil.which('llama-server')
    observed['llama_cpp_build'] = None
    observed['llama_backend'] = None
    if binary:
        version = command([binary, '--version'])
        observed['llama_version_probe'] = version
        if version['rc'] == 0:
            observed['llama_cpp_build'] = llama_build(version['text'])
        devices = command([binary, '--list-devices'])
        observed['llama_devices_probe'] = devices
        if devices['rc'] == 0 and re.search(r'^\s*(?:ROCm|HIP)\d+\s*:', devices['text'], re.M):
            observed['llama_backend'] = 'rocm'
        observed['llama_server_binary'] = str(Path(binary).resolve())
        try:
            with Path(binary).open('rb') as source:
                observed['llama_cpp_sha256'] = hashlib.file_digest(source, 'sha256').hexdigest()
        except OSError:
            observed['llama_cpp_sha256'] = None
    vivado = env.get('VIVADO_BIN') or (str(Path(env['XILINX_VIVADO']) / 'bin') if env.get('XILINX_VIVADO') else None)
    if not vivado and env.get('XILINX_VITIS'):
        vivado = str(Path(env['XILINX_VITIS']).parent / 'Vivado' / 'bin')
    work = Path(env.get('EDA_TMP', '/var/tmp/eda'))
    observed['vivado'] = None
    try:
        work.mkdir(parents=True, exist_ok=True)
        version = command([str(Path(vivado) / 'vivado') if vivado else 'vivado', '-version'], cwd=work)
        observed['vivado_version_probe'] = version
        match = re.search(r'Vivado\s+v?(\d+\.\d+)\b', version['text'], re.I)
        if version['rc'] == 0 and match:
            observed['vivado'] = match[1]
    except OSError:
        pass
    return observed

def evaluate(observed, profile, backend='llama.cpp', scope='runtime'):
    if backend not in ('llama.cpp', 'vllm') or scope not in ('runtime', 'image'):
        raise ValueError('Unsupported backend or check scope')
    expected = profile['provided_by_image']
    checks = []
    def check(name, wanted, actual, match=None, required=True):
        checks.append(dict(component=name, expected=wanted, actual=actual,
            match=actual == wanted if match is None else bool(match), required=required))
    check('system', profile['platform']['system'], observed.get('system'))
    check('distribution', profile['platform']['distribution'], observed.get('distribution'))
    check('distribution_version', profile['platform']['version'], observed.get('distribution_version'))
    check('python', expected['python'], observed.get('python'), release(observed.get('python'), 2) == expected['python'])
    check('baseline_python', expected['python'], observed.get('baseline_python'), release(observed.get('baseline_python'), 2) == expected['python'])
    check('node', profile['project_runtime']['node'], observed.get('node'),
        str(observed.get('node', '')).split('.')[0] == profile['project_runtime']['node'].split('.')[0])
    check('rocm', expected['rocm'], observed.get('rocm'), release(observed.get('rocm')) == expected['rocm'])
    check('hip', expected['hip'], observed.get('hip'), release(observed.get('hip'), 2) == expected['hip'])
    check('vivado', expected['vivado'], observed.get('vivado'))
    frameworks_required = scope == 'image' or backend == 'vllm'
    check('torch', expected['torch'], observed.get('torch'), required=frameworks_required)
    check('torch_hip', expected['hip'], observed.get('torch_hip'), release(observed.get('torch_hip'), 2) == expected['hip'], required=frameworks_required)
    check('vllm', expected['vllm'], observed.get('vllm'),
        re.fullmatch(re.escape(expected['vllm']) + r'(?:\+[^\s]+)?', observed.get('vllm') or '') is not None, required=frameworks_required)
    check('llama_cpp_build', expected['llama_cpp_build'], observed.get('llama_cpp_build'), required=scope == 'image' or backend == 'llama.cpp')
    check('llama_backend', 'rocm', observed.get('llama_backend'), required=scope == 'image' or backend == 'llama.cpp')
    if expected.get('llama_cpp_sha256'):
        check('llama_cpp_sha256', expected['llama_cpp_sha256'], observed.get('llama_cpp_sha256'), required=scope == 'image' or backend == 'llama.cpp')
    failures = [item['component'] for item in checks if item['required'] and not item['match']]
    return dict(schema_version=1, profile_id=profile['profile_id'], scope=scope, backend=backend,
        runtime_matches=not failures, full_image_matches=all(item['match'] for item in checks),
        failed_components=failures, checks=checks, observed=observed,
        acceptance='Version inspection only; not GPU, functional, memory or offline acceptance')

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', type=Path, default=HERE / 'versions.json')
    parser.add_argument('--backend', choices=['llama.cpp', 'vllm'], default=os.environ.get('SERVING_BACKEND', 'llama.cpp'))
    parser.add_argument('--scope', choices=['runtime', 'image'], default='runtime')
    args = parser.parse_args()
    profile = json.loads(args.profile.read_text(encoding='utf-8-sig'))
    result = evaluate(observe(), profile, args.backend, args.scope)
    result['checked_at'] = time.time()
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result['runtime_matches'] else 1

if __name__ == '__main__':
    raise SystemExit(main())
