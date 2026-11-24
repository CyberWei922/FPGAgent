import { CheckCircle2, CircleDashed, XCircle } from 'lucide-react';
import { useState } from 'react';
import type { AgentBlueprint, HarnessTraceEvent, LintIssue, SelfTestResult } from '../types/contracts';

interface Props {
  blueprint?: AgentBlueprint;
  traces: HarnessTraceEvent[];
  issues: LintIssue[];
  selfTest?: SelfTestResult;
  code: string;
  onCodeChange: (code: string) => void;
  onCompile: () => void;
}

type Tab = 'blueprint' | 'verify' | 'code';

const TABS: [Tab, string][] = [
  ['blueprint', '蓝图'],
  ['verify', '自测与诊断'],
  ['code', 'Verilog'],
];

function StatusIcon({ status }: { status: HarnessTraceEvent['status'] }) {
  if (status === 'pass') return <CheckCircle2 size={14} className="text-emerald-400" />;
  if (status === 'fail') return <XCircle size={14} className="text-rose-400" />;
  return <CircleDashed size={14} className="animate-spin text-cyan-400" />;
}

export function AgentPanel(props: Props) {
  const [tab, setTab] = useState<Tab>('blueprint');

  return (
    <section className="flex min-h-0 flex-col border-r border-slate-800">
      <nav className="flex border-b border-slate-800 text-sm">
        {TABS.map(([value, label]) => (
          <button
            key={value}
            onClick={() => setTab(value)}
            className={`flex-1 py-2 ${tab === value ? 'border-b-2 border-cyan-400 text-cyan-300' : 'text-slate-400'}`}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-auto p-3 text-sm">
        {tab === 'blueprint' &&
          (props.blueprint ? (
            <div className="space-y-3">
              <h2 className="text-base font-semibold">{props.blueprint.title}</h2>
              <p className="text-slate-300">{props.blueprint.summary}</p>
              <ol className="list-decimal space-y-1 pl-5 text-slate-300">
                {props.blueprint.behaviors.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ol>
              <table className="w-full text-left text-xs">
                <tbody>
                  {props.blueprint.pinMappings.map((p) => (
                    <tr key={p.port} className="border-t border-slate-800">
                      <td className="py-1 font-mono text-cyan-300">{p.port}</td>
                      <td className="py-1 text-slate-300">{p.role}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <pre className="rounded bg-slate-900 p-2 text-xs text-slate-400">{props.blueprint.mermaidFsm}</pre>
            </div>
          ) : (
            <p className="text-slate-500">选择预置案例或输入需求开始。</p>
          ))}

        {tab === 'verify' && (
          <div className="space-y-3">
            <ul className="space-y-1">
              {props.traces.map((t, i) => (
                <li key={i} className="flex items-start gap-2">
                  <StatusIcon status={t.status} />
                  <div>
                    <div>{t.title}</div>
                    {t.detail && <div className="text-xs text-slate-500">{t.detail}</div>}
                  </div>
                </li>
              ))}
            </ul>
            {props.selfTest && (
              <div className={`rounded p-2 ${props.selfTest.passed ? 'bg-emerald-950 text-emerald-300' : 'bg-rose-950 text-rose-300'}`}>
                自测 {props.selfTest.passedChecks}/{props.selfTest.totalChecks} 通过
                {props.selfTest.firstFailure &&
                  `：第 ${props.selfTest.firstFailure.cycle} 拍 ${props.selfTest.firstFailure.signal} 期望 ${props.selfTest.firstFailure.expected}，实际 ${props.selfTest.firstFailure.actual}`}
              </div>
            )}
            {props.issues.map((issue, i) => (
              <div key={i} className={`rounded border p-2 ${issue.severity === 'error' ? 'border-rose-800' : 'border-amber-800'}`}>
                <div className="font-mono text-xs">
                  {issue.code} · 第 {issue.line} 行
                </div>
                <div>{issue.message}</div>
                <div className="text-xs text-slate-400">{issue.hint}</div>
              </div>
            ))}
          </div>
        )}

        {tab === 'code' && (
          <div className="flex h-full flex-col gap-2">
            <textarea
              className="min-h-[24rem] flex-1 resize-none rounded bg-slate-900 p-2 font-mono text-xs leading-5 outline-none"
              spellCheck={false}
              value={props.code}
              onChange={(e) => props.onCodeChange(e.target.value)}
            />
            <button onClick={props.onCompile} className="rounded bg-cyan-700 py-1.5">
              编译并自测
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
