"""Offline SystemVerilog preflight. Emits one JSON object, never modifies RTL.

Only a small, tested set of language errors can short-circuit AMD compilation.
Unknown diagnostics, unavailable libraries and tool failures request AMD fallback.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import time

sys.dont_write_bytecode = True
VERSION = '12.0.0'
MAX_BYTES = 131072
RULES = [
    ('procedural_net_assignment', r'^cannot assign to a net within a procedural context$'),
    ('undeclared_identifier', r"^use of undeclared identifier '[^']+'$"),
    ('redefinition', r"^redefinition of '[^']+'(?: \[-Wredefinition\])?$"),
    ('multiple_always_ff_drivers', r"^variable '[^']+' driven by always_ff procedure cannot be written to by any other process(?: \[-Wmultiple-always-assigns\])?$"),
    ('missing_semicolon', r"^expected ';'$"),
]
HEADER = re.compile(r'^(.*?):(\d+):(\d+): (fatal error|error|warning|note): (.*)$')


def diagnostics(text: str, limit: int) -> list[dict]:
    rows = []
    for line in text.splitlines():
        match = HEADER.match(line)
        if not match:
            continue
        _, number, column, severity, message = match.groups()
        rule = next((name for name, pattern in RULES if re.fullmatch(pattern, message)), None)
        rows.append({'file': 'dut.sv', 'line': int(number), 'column': int(column),
                     'severity': severity, 'message': message[:1000], 'rule': rule})
    # Hard errors lead the bounded model feedback; notes and warnings cannot hide them.
    return sorted(rows, key=lambda row: row['severity'] not in ('error', 'fatal error'))[:limit]


def check(source: Path, top: str, limit: int) -> dict:
    def deny_network(event, _args):
        if event in ('socket.connect', 'socket.getaddrinfo'):
            raise RuntimeError('Network access is disabled in RTL preflight')
    sys.addaudithook(deny_network)
    vendor = Path(__file__).resolve().parents[2] / 'competition/vendor/pyslang/site-packages'
    if vendor.is_dir():
        sys.path.insert(0, str(vendor))
    import pyslang
    from pyslang.driver import Driver
    if pyslang.__version__ != VERSION:
        raise RuntimeError('Unexpected pyslang version')
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,127}', top):
        raise ValueError('Invalid top module')
    if source.is_symlink() or not source.is_file() or source.stat().st_size > MAX_BYTES:
        raise ValueError('Expected a bounded regular RTL source')
    code = source.read_bytes().decode('utf-8')
    # A fixed private filename avoids driver globbing / command-file expansion.
    # Includes and pragmas are outside the existing standalone RTL contract.
    masked = re.sub(r'"(?:\\.|[^"\\])*"|/\*[\s\S]*?\*/|//[^\n]*', ' ', code)
    if re.search(r'`\s*(?:include|pragma)\b', masked):
        return {'decision': 'fallback', 'reason': 'external_source_directive'}
    if source.name != 'dut.sv' or source.parent.resolve() != Path.cwd().resolve():
        raise ValueError('Expected private dut.sv in the preflight working directory')
    driver = Driver()
    driver.addStandardArgs()
    driver.diagEngine.setErrorLimit(limit)
    driver.diagEngine.clearClients()
    client = pyslang.TextDiagnosticClient()
    client.showColors(False)
    driver.diagEngine.addClient(client)
    if not driver.parseCommandLine(f'slang dut.sv --top {top} -Wwidth-trunc') or not driver.processOptions():
        raise RuntimeError('Cannot configure slang driver')
    parsed = driver.parseAllSources()
    ok = driver.runFullCompilation(True) if parsed else driver.reportDiagnostics(True)
    text = client.getString()
    rows = diagnostics(text, limit)
    errors = driver.diagEngine.numErrors
    hard = [row for row in rows if row['severity'] in ('error', 'fatal error')]
    trusted = errors > 0 and len(hard) == errors and all(row['rule'] for row in hard)
    decision = 'reject' if trusted else 'pass' if ok and errors == 0 else 'fallback'
    return {'decision': decision, 'reason': 'known_language_error' if trusted else 'no_hard_errors' if decision == 'pass' else 'unverified_diagnostic_or_missing_library',
            'source_sha256': hashlib.sha256(code.encode()).hexdigest(), 'errors': errors,
            'warnings': driver.diagEngine.numWarnings, 'diagnostics': rows}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--top', required=True)
    parser.add_argument('--max-diagnostics', default=12, type=int)
    args = parser.parse_args()
    if not 1 <= args.max_diagnostics <= 24:
        parser.error('max-diagnostics must be in [1, 24]')
    started = time.monotonic()
    try:
        result = check(args.source, args.top, args.max_diagnostics)
    except Exception as error:
        # Never serialize raw exception text, environment, or import search paths.
        result = {'decision': 'fallback', 'reason': 'helper_unavailable', 'error_type': type(error).__name__}
    result.update(schema_version=1, tool='pyslang', version=VERSION, elapsed_ms=round((time.monotonic() - started) * 1000, 3))
    print(json.dumps(result, ensure_ascii=True))


if __name__ == '__main__':
    main()
