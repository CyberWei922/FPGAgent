import {
  AlertCircle,
  Check,
  CheckCircle2,
  CircleDashed,
  Copy,
  Download,
  ExternalLink,
  FileCode2,
  Play,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { tokenizeVerilogForHighlight } from '../engine';
import type {
  AgentBlueprint,
  HarnessTraceEvent,
  LintIssue,
  SelfTestResult,
} from '../types/contracts';
import { FsmDiagram } from './FsmDiagram';
import { Waveform } from './Waveform';

export interface CodeStreamState {
  active: boolean;
  stage: 'coding' | 'linting' | 'simulating' | 'repairing' | 'verified';
  statusText: string;
}

export function BlueprintView({
  blueprint,
  planning = false,
}: {
  blueprint?: AgentBlueprint;
  planning?: boolean;
}) {
  if (planning && !blueprint) {
    return (
      <div className="wb-doc-scroll">
        <div className="blueprint-doc blueprint-planning">
          <div className="planning-banner">
            <span className="pulse-dot" />
            <div>
              <strong>正在规划电路架构蓝图…</strong>
              <p>拆解端口约束、时序行为、有限状态机转移与自测向量</p>
            </div>
          </div>
          <div className="blueprint-grid">
            <section className="doc-card skeleton-card" aria-hidden="true">
              <div className="skeleton-line w-40" />
              <div className="skeleton-line w-90" />
              <div className="skeleton-line w-80" />
              <div className="skeleton-line w-85" />
              <div className="skeleton-line w-65" />
            </section>
            <section className="doc-card skeleton-card" aria-hidden="true">
              <div className="skeleton-line w-45" />
              <div className="skeleton-line w-95" />
              <div className="skeleton-line w-85" />
              <div className="skeleton-line w-90" />
              <div className="skeleton-line w-70" />
            </section>
          </div>
          <section className="doc-card skeleton-card skeleton-fsm" aria-hidden="true">
            <div className="skeleton-line w-35" />
            <div className="skeleton-block" />
          </section>
        </div>
      </div>
    );
  }

  if (!blueprint) {
    return (
      <div className="wb-empty-view">
        <p>规划完成后将在此展示电路架构蓝图、引脚映射表与状态转移图。</p>
      </div>
    );
  }

  return (
    <div className="wb-doc-scroll">
      <div className="blueprint-doc blueprint-reveal">
        {planning && (
          <div className="planning-banner compact">
            <span className="pulse-dot" />
            <span>正在更新电路架构蓝图与自测向量…</span>
          </div>
        )}
        <header className="blueprint-doc-head">
          <h2>{blueprint.title}</h2>
          <p>{blueprint.summary}</p>
        </header>

        <div className="blueprint-grid">
          <section className="doc-card">
            <h3>核心功能行为</h3>
            <ol className="behavior-list">
              {blueprint.behaviors.map((behavior, index) => (
                <li key={index}>{behavior}</li>
              ))}
            </ol>
          </section>

          <section className="doc-card">
            <h3>开发板引脚映射</h3>
            <table className="pin-table">
              <thead>
                <tr>
                  <th>端口信号</th>
                  <th>功能说明</th>
                </tr>
              </thead>
              <tbody>
                {blueprint.pinMappings.map((pin, index) => (
                  <tr key={index}>
                    <th scope="row" className="mono">{pin.port}</th>
                    <td>{pin.role}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>

        {blueprint.mermaidFsm && <FsmDiagram source={blueprint.mermaidFsm} />}
      </div>
    </div>
  );
}

export function VerilogView({
  code,
  filename,
  canCompile,
  highlightLine,
  issues,
  streamState,
  onCodeChange,
  onCompile,
  onExportVerilog,
  onExportTestbench,
}: {
  code: string;
  filename: string;
  canCompile: boolean;
  highlightLine?: number;
  issues: LintIssue[];
  streamState?: CodeStreamState;
  onCodeChange: (next: string) => void;
  onCompile: () => void;
  onExportVerilog: () => void;
  onExportTestbench: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const gutterRef = useRef<HTMLDivElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const autoFollowRef = useRef(true);
  const wasCodeStreamingRef = useRef(false);
  const highlightedLines = useMemo(() => tokenizeVerilogForHighlight(code), [code]);
  const lineCount = Math.max(1, highlightedLines.length);

  const isCodeStreaming = Boolean(
    streamState?.active && (streamState.stage === 'coding' || streamState.stage === 'repairing'),
  );

  useEffect(() => {
    if (isCodeStreaming && !wasCodeStreamingRef.current) {
      autoFollowRef.current = true;
    }
    wasCodeStreamingRef.current = isCodeStreaming;
  }, [isCodeStreaming]);

  function syncScroll(target: HTMLTextAreaElement, userDriven = false) {
    if (preRef.current) {
      preRef.current.scrollTop = target.scrollTop;
      preRef.current.scrollLeft = target.scrollLeft;
    }
    if (gutterRef.current) {
      gutterRef.current.scrollTop = target.scrollTop;
    }
    if (userDriven && isCodeStreaming) {
      const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
      if (distanceFromBottom > 42) autoFollowRef.current = false;
      else if (distanceFromBottom < 20) autoFollowRef.current = true;
    }
  }

  useEffect(() => {
    if (!isCodeStreaming || !autoFollowRef.current) return;
    const el = textareaRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    syncScroll(el, false);
  }, [code, isCodeStreaming]);

  async function copySource() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Ignore clipboard failures in insecure contexts.
    }
  }

  const readOnly = !canCompile || Boolean(streamState?.active);

  return (
    <div className={`code-studio${streamState?.active ? ' streaming' : ''}`}>
      <div className="code-studio-bar">
        <div className="code-studio-meta">
          <FileCode2 size={15} />
          <span className="mono">{filename}</span>
          <span className="muted">· {lineCount} 行</span>
          {highlightLine !== undefined && (
            <span className="tag-pill warn">关注第 {highlightLine} 行</span>
          )}
        </div>
        <div className="code-studio-actions">
          <button type="button" className="outline-button compact-btn" disabled={!code} onClick={() => void copySource()}>
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? '已复制' : '复制'}
          </button>
          <button type="button" className="outline-button compact-btn" disabled={!code || Boolean(streamState?.active)} onClick={onExportVerilog}>
            <Download size={13} /> 导出 .v
          </button>
          <button type="button" className="outline-button compact-btn" disabled={!code || Boolean(streamState?.active)} onClick={onExportTestbench}>
            <Download size={13} /> tb_top.v
          </button>
          <button type="button" className="primary-button compact-btn" disabled={readOnly || !code.trim()} onClick={onCompile}>
            <Play size={13} /> 编译并自测
          </button>
        </div>
      </div>

      {streamState?.active && (
        <div className={`code-live-banner stage-${streamState.stage}`} role="status" aria-live="polite">
          {streamState.stage === 'verified' ? (
            <CheckCircle2 size={14} className="live-ok-icon" />
          ) : (
            <span className={`pulse-dot${streamState.stage === 'repairing' ? ' warn' : ''}`} />
          )}
          <span className="code-live-text">{streamState.statusText}</span>
          {isCodeStreaming && (
            <span className="code-live-count mono">{lineCount} 行</span>
          )}
        </div>
      )}

      {issues.length > 0 && !isCodeStreaming && (
        <div className="code-issues-strip">
          {issues.slice(0, 3).map((issue, idx) => (
            <div key={idx} className={`issue-inline ${issue.severity}`}>
              <AlertCircle size={13} />
              <strong>第 {issue.line} 行 ({issue.code})</strong>
              <span>{issue.message}</span>
            </div>
          ))}
        </div>
      )}

      <div className="code-editor-wrap">
        <div ref={gutterRef} className="code-gutter" aria-hidden="true">
          {Array.from({ length: lineCount }, (_, i) => (
            <span key={i} className={highlightLine === i + 1 ? 'hl' : undefined}>
              {i + 1}
            </span>
          ))}
        </div>
        <div className="code-editor-stage">
          <pre ref={preRef} className="code-highlight" aria-hidden="true">
            {highlightedLines.map((row, rowIdx) => {
              const isLastRow = rowIdx === highlightedLines.length - 1;
              return (
                <span
                  key={row.line}
                  className={highlightLine === row.line ? 'code-line hl' : 'code-line'}
                >
                  {row.tokens.length === 0 ? (
                    isCodeStreaming && isLastRow ? null : '\u200b'
                  ) : (
                    row.tokens.map((tok, idx) =>
                      tok.kind === 'plain' ? (
                        <span
                          key={`L${row.line}-T${idx}`}
                          className={isCodeStreaming ? 'tok-stream-in' : undefined}
                        >
                          {tok.value}
                        </span>
                      ) : (
                        <span
                          key={`L${row.line}-T${idx}`}
                          className={`tok-${tok.kind}${isCodeStreaming ? ' tok-stream-in' : ''}`}
                        >
                          {tok.value}
                        </span>
                      ),
                    )
                  )}
                  {isCodeStreaming && isLastRow && <span className="code-stream-caret" aria-hidden="true" />}
                </span>
              );
            })}
          </pre>
          <textarea
            ref={textareaRef}
            aria-label="Verilog 源码编辑器"
            className="code-textarea"
            value={code}
            readOnly={readOnly}
            spellCheck={false}
            placeholder={
              isCodeStreaming
                ? '正在编写可综合 Verilog 源码…'
                : '暂无 Verilog 源码，先在左侧输入电路需求或选择一个快捷示例。'
            }
            onScroll={(event) => syncScroll(event.currentTarget, true)}
            onChange={(event) => onCodeChange(event.target.value)}
          />
        </div>
      </div>
    </div>
  );
}

export function VerifyView({
  selfTest,
  issues,
  traces,
  ledFocus,
  onJumpToLine,
}: {
  selfTest?: SelfTestResult;
  issues: LintIssue[];
  traces: HarnessTraceEvent[];
  ledFocus: boolean;
  onJumpToLine: (line: number) => void;
}) {
  const failure = selfTest?.firstFailure;

  if (!selfTest && issues.length === 0 && traces.length === 0) {
    return (
      <div className="wb-empty-view">
        <p>尚无编译与自测记录。生成或编译电路后，这里会展示完整确定性自测报告与波形。</p>
      </div>
    );
  }

  return (
    <div className="wb-doc-scroll">
      <div className="verify-doc">
        {selfTest && (
          <div className={`verify-banner ${selfTest.passed ? 'passed' : 'failed'}`}>
            <div className="verify-banner-head">
              {selfTest.passed ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
              <strong>
                {selfTest.passed
                  ? `确定性自测全部通过（${selfTest.passedChecks}/${selfTest.totalChecks}）`
                  : `自测未通过（${selfTest.passedChecks}/${selfTest.totalChecks}）`}
              </strong>
            </div>
            {selfTest.firstUnstableCycle !== undefined && (
              <p>第 {selfTest.firstUnstableCycle} 拍检测到组合逻辑震荡未收敛。</p>
            )}
            {failure && (
              <p>
                第 <strong>{failure.cycle}</strong> 拍失配：信号 <code>{failure.signal}</code> 期望{' '}
                <code>{failure.expected}</code>，实际 <code>{failure.actual}</code>
                {failure.note ? `（${failure.note}）` : ''}
              </p>
            )}
            {selfTest.regressedCycles.length > 0 && (
              <p>回退警报：第 {selfTest.regressedCycles.join('、')} 拍此前通过、本次失败。</p>
            )}
          </div>
        )}

        {selfTest && selfTest.waveform.length > 0 && (
          <div className="doc-card">
            <Waveform
              title="完整自测采样波形"
              samples={selfTest.waveform}
              failureCycle={selfTest.firstUnstableCycle ?? failure?.cycle}
              ledFocus={failure?.signal === 'led' || ledFocus}
            />
          </div>
        )}

        <div className="verify-columns">
          <section className="doc-card">
            <h3>静态 Lint 体检（{issues.length}）</h3>
            {issues.length === 0 ? (
              <p className="muted">未发现可综合语法或风格问题。</p>
            ) : (
              <div className="issue-list">
                {issues.map((issue, idx) => (
                  <div key={idx} className={`issue-card ${issue.severity}`}>
                    <div className="issue-card-head">
                      <strong className="mono">{issue.code}</strong>
                      <button
                        type="button"
                        className="text-link"
                        onClick={() => onJumpToLine(issue.line)}
                      >
                        第 {issue.line} 行
                      </button>
                    </div>
                    <p>{issue.message}</p>
                    <p className="muted">{issue.hint}</p>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="doc-card">
            <h3>智能体执行轨迹（{traces.length}）</h3>
            {traces.length === 0 ? (
              <p className="muted">暂无执行步骤。</p>
            ) : (
              <ol className="trace-timeline">
                {traces.map((trace, idx) => {
                  const Icon =
                    trace.status === 'pass'
                      ? CheckCircle2
                      : trace.status === 'fail'
                        ? XCircle
                        : CircleDashed;
                  return (
                    <li key={idx} data-status={trace.status}>
                      <Icon size={15} />
                      <div>
                        <div className="trace-head-row">
                          <strong>{trace.title}</strong>
                          {trace.meta?.model && <span className="mono-meta">{trace.meta.model}</span>}
                        </div>
                        {trace.detail && <p>{trace.detail}</p>}
                        {trace.meta?.sources && trace.meta.sources.length > 0 && (
                          <div className="ref-list">
                            {trace.meta.sources.map((src, sIdx) => (
                              <a key={sIdx} className="ref-chip" href={src.url} target="_blank" rel="noreferrer">
                                {src.title} <ExternalLink size={11} />
                              </a>
                            ))}
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
