"""Bounded, offline RTL lint. Reports findings; never changes the source."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True
VERSION = '12.0.0'
RULES_VERSION = 'rtl-lint.v1'
RULES = ('-Wstatic-init-value', '-Wunassigned-variable', '-Wundriven-port',
         '-Wunsigned-arith-shift', '-Wmultiple-always-assigns', '-Wmixed-var-assigns')
HEADER = re.compile(r'^(.*?):(\d+):(\d+): (warning|error|fatal error): (.*?)(?: \[(-W[\w-]+)\])?$')


def check(source: Path, top: str, limit: int) -> dict:
    result = dict(schema_version=1, tool='pyslang', version=VERSION, rules_version=RULES_VERSION,
                  status='unavailable', reason='helper_unavailable', source_sha256=None, findings=[], other_codes={})
    def deny_network(event, _args):
        if event in ('socket.connect', 'socket.getaddrinfo'):
            raise RuntimeError('Network access is disabled in RTL lint')
    sys.addaudithook(deny_network)
    try:
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,127}', top):
            return dict(result, reason='invalid_top')
        if source.is_symlink() or not source.is_file() or source.stat().st_size > 131072:
            return dict(result, reason='source_boundary')
        if source.name != 'dut.sv' or source.parent.resolve() != Path.cwd().resolve():
            return dict(result, reason='source_boundary')
        data = source.read_bytes()
        result['source_sha256'] = hashlib.sha256(data).hexdigest()
        code = data.decode('utf-8')
        masked = re.sub(r'"(?:\\.|[^"\\])*"|/\*[\s\S]*?\*/|//[^\n]*', ' ', code)
        if re.search(r'`\s*(?:include|pragma)\b', masked):
            return dict(result, reason='external_source_directive')
        vendor = Path(__file__).resolve().parents[2] / 'competition/vendor/pyslang/site-packages'
        if vendor.is_dir():
            sys.path.insert(0, str(vendor))
        import pyslang
        from pyslang.driver import Driver
        if pyslang.__version__ != VERSION:
            return dict(result, reason='version_mismatch')
        driver = Driver(); driver.addStandardArgs(); driver.diagEngine.clearClients()
        client = pyslang.TextDiagnosticClient(); client.showColors(False); driver.diagEngine.addClient(client)
        ok = driver.parseCommandLine(f'slang dut.sv --top {top} -Weverything --error-limit 50') and driver.processOptions()
        if ok and driver.parseAllSources():
            driver.runFullCompilation(True)
        else:
            driver.reportDiagnostics(True)
        lines, findings, other = code.splitlines(), [], {}
        for line in client.getString().splitlines():
            match = HEADER.match(line)
            if not match:
                continue
            _, number, column, severity, message, rule = match.groups()
            if rule in RULES:
                index = int(number)
                findings.append(dict(code=rule, severity=severity, line=index, column=int(column),
                                     message=message[:300], source_line=lines[index - 1].strip()[:200] if 0 < index <= len(lines) else ''))
            elif rule:
                other[rule] = other.get(rule, 0) + 1
        findings.sort(key=lambda row: (row['line'], row['column'], row['code']))
        return dict(result, status='fail' if findings else 'pass',
                    reason='rule_findings' if findings else 'parse_or_elaboration_errors_left_to_vivado' if driver.diagEngine.numErrors else 'no_findings',
                    findings=findings[:limit], other_codes=dict(sorted(other.items())))
    except Exception:
        return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--top', required=True)
    parser.add_argument('--max-findings', default=8, type=int)
    args = parser.parse_args()
    if not 1 <= args.max_findings <= 16:
        result = dict(schema_version=1, tool='pyslang', version=VERSION, rules_version=RULES_VERSION,
                      status='unavailable', reason='invalid_max_findings', source_sha256=None, findings=[], other_codes={})
    else:
        result = check(args.source, args.top, args.max_findings)
    print(json.dumps(result, ensure_ascii=True))


if __name__ == '__main__':
    main()
