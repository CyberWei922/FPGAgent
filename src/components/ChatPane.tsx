import {
  Check,
  ChevronDown,
  ChevronRight,
  CircuitBoard,
  Code2,
  Download,
  ExternalLink,
  FileCode2,
  Settings2,
  XCircle,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { HarnessTraceEvent, WebReference } from '../types/contracts';

export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  status?: 'running' | 'done' | 'failed' | 'cancelled';
  traces?: HarnessTraceEvent[];
  version?: number;
  filename?: string;
  code?: string;
  passedChecks?: number;
  totalChecks?: number;
  modelUsed?: string;
  isPreset?: boolean;
  references?: WebReference[];
  errorCode?: string;
}

function TraceAccordion({
  turn,
}: {
  turn: ChatTurn;
}) {
  const isRunning = turn.status === 'running';
  const [expanded, setExpanded] = useState(isRunning);

  useEffect(() => {
    if (isRunning) setExpanded(true);
    else if (turn.status === 'done') setExpanded(false);
  }, [isRunning, turn.status]);

  const traces = turn.traces ?? [];
  if (traces.length === 0) return null;

  const latest = traces[traces.length - 1];
  const checkText = turn.totalChecks !== undefined ? ` · ${turn.passedChecks ?? 0}/${turn.totalChecks}` : '';
  const summaryLabel = isRunning
    ? `${latest.title} · 步骤 ${traces.length}`
    : turn.status === 'done'
      ? `已完成规划、Lint 与自测${checkText}`
      : turn.status === 'cancelled'
        ? '已停止生成'
        : `执行中断 · ${latest.title}`;

  if (!expanded) {
    return (
      <button
        type="button"
        className={`think-collapsed${turn.status === 'failed' ? ' failed' : ''}`}
        onClick={() => setExpanded(true)}
      >
        {turn.status === 'failed' ? (
          <XCircle size={13} className="err" />
        ) : (
          <Check size={13} className="ok" />
        )}
        <span>{summaryLabel}</span>
        <ChevronRight size={13} />
      </button>
    );
  }

  return (
    <div className="steps-card">
      <button
        type="button"
        className="steps-head"
        onClick={() => setExpanded(false)}
      >
        <span className="steps-head-left">
          {isRunning ? (
            <span className="pulse-dot" />
          ) : turn.status === 'failed' ? (
            <XCircle size={13} className="err" />
          ) : (
            <Check size={13} className="ok" />
          )}
          <span>{summaryLabel}</span>
        </span>
        <ChevronDown size={14} />
      </button>

      <ol className="steps-list">
        {traces.map((trace, index) => {
          const isCurrent = isRunning && index === traces.length - 1;
          const rowState = trace.status === 'fail' ? 'fail' : isCurrent ? 'running' : 'done';
          return (
            <li key={`${trace.timestamp}-${index}`} className={`step-row ${rowState}`}>
              <span className="step-mark">
                {rowState === 'fail' ? (
                  <XCircle size={13} />
                ) : rowState === 'running' ? (
                  <span className="step-dot-active" />
                ) : (
                  <Check size={13} />
                )}
              </span>
              <div className="step-content">
                <div className="step-title">{trace.title}</div>
                {trace.detail && <div className="step-note">{trace.detail}</div>}
                {trace.meta?.checkpoints && trace.meta.checkpoints.length > 0 && (
                  <div className="step-checks">
                    {trace.meta.checkpoints.map((cp, idx) => (
                      <div key={idx}>{cp}</div>
                    ))}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function ChatPane({
  turns,
  onOpenCode,
  onDownloadCode,
  onOpenVerify,
  onOpenSettings,
}: {
  turns: ChatTurn[];
  onOpenCode: (code?: string) => void;
  onDownloadCode: (filename: string, code: string) => void;
  onOpenVerify: () => void;
  onOpenSettings: () => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);

  return (
    <div className="chat-stream" role="log" aria-live="polite" aria-label="对话记录">
      {turns.map((turn) =>
        turn.role === 'user' ? (
          <div key={turn.id} className="msg-user">
            <div className="user-bubble">{turn.text}</div>
          </div>
        ) : (
          <div key={turn.id} className="msg-assistant">
            <div className="ai-avatar" aria-hidden="true">
              <CircuitBoard size={14} />
            </div>
            <div className="ai-body">
              <TraceAccordion turn={turn} />

              {turn.text && (
                <p className="ai-prose">
                  {turn.text}
                  {turn.status === 'running' && <span className="stream-cursor" aria-hidden="true" />}
                </p>
              )}

              {turn.references && turn.references.length > 0 && (
                <div className="ref-list" aria-label="联网参考来源">
                  {turn.references.map((ref, idx) => (
                    <a
                      key={`${ref.url}-${idx}`}
                      className="ref-chip"
                      href={ref.url}
                      target="_blank"
                      rel="noreferrer"
                      title={ref.snippet}
                    >
                      <span>{ref.title}</span>
                      <ExternalLink size={11} />
                    </a>
                  ))}
                </div>
              )}

              {turn.filename && turn.code && turn.status === 'done' && (
                <div className="artifact-card">
                  <div className="artifact-left">
                    <span className="artifact-icon">
                      <FileCode2 size={15} />
                    </span>
                    <div className="artifact-info">
                      <div className="artifact-name mono">{turn.filename}</div>
                      <div className="artifact-meta">
                        V{turn.version ?? 1} · {turn.isPreset ? '预置案例已上板' : '门级网表已上板'}
                        {turn.modelUsed ? ` · ${turn.modelUsed}` : ''}
                      </div>
                    </div>
                  </div>
                  <div className="artifact-actions">
                    <button
                      type="button"
                      className="mini-btn"
                      onClick={() => onOpenCode(turn.code)}
                    >
                      <Code2 size={12} /> 源码
                    </button>
                    <button
                      type="button"
                      className="mini-btn"
                      onClick={() => onDownloadCode(turn.filename!, turn.code!)}
                    >
                      <Download size={12} /> .v
                    </button>
                  </div>
                </div>
              )}

              {turn.status === 'failed' && (
                <div className="fail-actions">
                  {(turn.errorCode === 'NOT_CONFIGURED' || turn.errorCode === 'QUOTA_EXCEEDED' || turn.errorCode === 'NETWORK') && (
                    <button type="button" className="mini-btn" onClick={onOpenSettings}>
                      <Settings2 size={12} /> 检查 API 设置
                    </button>
                  )}
                  <button type="button" className="mini-btn" onClick={onOpenVerify}>
                    查看自测详情
                  </button>
                </div>
              )}
            </div>
          </div>
        ),
      )}
      <div ref={endRef} />
    </div>
  );
}
