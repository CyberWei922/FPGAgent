import { CheckCircle2, CircleDashed, XCircle } from 'lucide-react';
import { useState } from 'react';
import type { AgentBlueprint, HarnessTraceEvent, LintIssue, SelfTestResult } from '../types/contracts';

interface Props {
  blueprint?: AgentBlueprint;
  traces: HarnessTraceEvent[];
  issues: LintIssue[];
  selfTest?: SelfTestResult;
  code: string;
  canCompile: boolean;
  onCodeChange: (code: string) => void;
  onCompile: () => void;
}

const TABS = [['blueprint', '蓝图'], ['verify', '自测'], ['code', 'Verilog']] as const;

export function AgentPanel(props: Props) {
  const [tab, setTab] = useState<typeof TABS[number][0]>('blueprint');
  const failure = props.selfTest?.firstFailure;

  return (
    <section className="agent-panel">
      <nav className="panel-tabs" aria-label="电路资料页签">
        {TABS.map(([value, label]) => <button key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>{label}</button>)}
      </nav>
      <div className="panel-content">
        {tab === 'blueprint' && (props.blueprint ? (
          <div className="blueprint-content">
            <h3>{props.blueprint.title}</h3>
            <p>{props.blueprint.summary}</p>
            <ol>{props.blueprint.behaviors.map((behavior, index) => <li key={index}>{behavior}</li>)}</ol>
            <table><tbody>{props.blueprint.pinMappings.map((pin, index) => (
              <tr key={index}><th scope="row">{pin.port}</th><td>{pin.role}</td></tr>
            ))}</tbody></table>
            {props.blueprint.mermaidFsm && <pre>{props.blueprint.mermaidFsm}</pre>}
          </div>
        ) : <p className="muted">规划完成后显示电路蓝图。</p>)}
        {tab === 'verify' && (
          <div className="verification-panel">
            {props.selfTest && <div className={`test-result ${props.selfTest.passed ? 'passed' : 'failed'}`}>
              自测 {props.selfTest.passedChecks}/{props.selfTest.totalChecks} 通过
              {failure && <p>第 {failure.cycle} 拍，{failure.signal} 期望 {failure.expected}，实际 {failure.actual}。</p>}
            </div>}
            {props.issues.map((issue, index) => <div key={index} className="issue">
              <strong>{issue.code} · 第 {issue.line} 行</strong><p>{issue.message}</p><p className="muted">{issue.hint}</p>
            </div>)}
            {props.traces.length > 0 && <ol className="trace-list">{props.traces.map((trace, index) => {
              const Icon = trace.status === 'pass' ? CheckCircle2 : trace.status === 'fail' ? XCircle : CircleDashed;
              return <li key={index} data-status={trace.status}>
                <Icon size={15} /><div><strong>{trace.title}</strong>{trace.detail && <p>{trace.detail}</p>}</div>
              </li>;
            })}</ol>}
            {!props.selfTest && !props.issues.length && !props.traces.length && <p className="muted">暂无自测记录。</p>}
          </div>
        )}
        {tab === 'code' && (
          <div className="code-editor">
            <textarea aria-label="Verilog 源码" placeholder="暂无 Verilog 源码" value={props.code} readOnly={!props.canCompile} spellCheck={false} onChange={(event) => props.onCodeChange(event.target.value)} />
            <button type="button" className="primary-button" disabled={!props.canCompile} onClick={props.onCompile}>编译并自测</button>
          </div>
        )}
      </div>
    </section>
  );
}
