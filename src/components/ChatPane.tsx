import {
  Brain,
  Check,
  ChevronRight,
  CircuitBoard,
  Code2,
  Download,
  ExternalLink,
  FileCode2,
  Settings2,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { HarnessStage, HarnessTraceEvent, WebReference } from '../types/contracts';

export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  status?: 'running' | 'done' | 'failed' | 'cancelled';
  traces?: HarnessTraceEvent[];
  liveReasoning?: Record<string, string>;
  startedAt?: number;
  finishedAt?: number;
  version?: number;
  filename?: string;
  code?: string;
  passedChecks?: number;
  totalChecks?: number;
  modelUsed?: string;
  references?: WebReference[];
  errorCode?: string;
}

export interface AgentStep {
  key: string;
  stage: HarnessStage;
  status: 'running' | 'pass' | 'fail';
  title: string;
  detail: string;
  startedAt: number;
  endedAt?: number;
  checkpoints?: string[];
  reasoning?: string;
  sources?: WebReference[];
  codeLines?: number;
  highlightLine?: number;
}

export function stepKeyForTrace(stage: HarnessStage, round?: number): string {
  if (stage === 'linting' || stage === 'simulating') return `${stage}-${round ?? 0}`;
  if (stage === 'repairing') return `repairing-${round ?? 1}`;
  return stage;
}

export function mergeTracesToSteps(
  traces: HarnessTraceEvent[],
  liveReasoning?: Record<string, string>,
): AgentStep[] {
  const steps: AgentStep[] = [];
  const byKey = new Map<string, AgentStep>();

  for (const event of traces) {
    if (event.stage === 'done' || event.stage === 'idle') continue;

    if (event.stage === 'failed') {
      const runningStep = [...steps].reverse().find((s) => s.status === 'running');
      if (runningStep) {
        runningStep.status = 'fail';
        runningStep.endedAt = event.timestamp;
        if (event.detail) runningStep.detail = event.detail;
      } else {
        steps.push({
          key: `failed-${event.timestamp}`,
          stage: 'failed',
          status: 'fail',
          title: event.title || '执行中断',
          detail: event.detail,
          startedAt: event.timestamp,
          endedAt: event.timestamp,
        });
      }
      continue;
    }

    const key = stepKeyForTrace(event.stage, event.meta?.round);
    const existing = byKey.get(key);
    const reasoningFromLive = liveReasoning?.[key];
    const resolvedReasoning = event.meta?.reasoning || reasoningFromLive || existing?.reasoning;

    if (existing) {
      existing.status = event.status;
      existing.title = event.title || existing.title;
      existing.detail = event.detail || existing.detail;
      if (event.status !== 'running') {
        existing.endedAt = event.timestamp;
      }
      if (event.meta?.checkpoints?.length) existing.checkpoints = event.meta.checkpoints;
      if (event.meta?.sources?.length) existing.sources = event.meta.sources;
      if (event.meta?.codeLines !== undefined) existing.codeLines = event.meta.codeLines;
      if (event.meta?.highlightLine !== undefined) existing.highlightLine = event.meta.highlightLine;
      if (resolvedReasoning) existing.reasoning = resolvedReasoning;
    } else {
      const created: AgentStep = {
        key,
        stage: event.stage,
        status: event.status,
        title: event.title,
        detail: event.detail,
        startedAt: event.timestamp,
        endedAt: event.status !== 'running' ? event.timestamp : undefined,
        checkpoints: event.meta?.checkpoints,
        reasoning: resolvedReasoning,
        sources: event.meta?.sources,
        codeLines: event.meta?.codeLines,
        highlightLine: event.meta?.highlightLine,
      };
      byKey.set(key, created);
      steps.push(created);
    }
  }

  return steps;
}

function formatDuration(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 1000) return `${Math.max(0.1, safe / 1000).toFixed(1)}s`;
  return `${(safe / 1000).toFixed(1)}s`;
}

function StepRow({
  step,
  now,
  isLast,
  turnRunning,
  onJumpToLine,
}: {
  step: AgentStep;
  now: number;
  isLast: boolean;
  turnRunning: boolean;
  onJumpToLine?: (line: number) => void;
}) {
  const hasDetails = Boolean(
    step.reasoning ||
      (step.checkpoints && step.checkpoints.length > 0) ||
      (step.sources && step.sources.length > 0) ||
      step.highlightLine !== undefined,
  );
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const reasoningRef = useRef<HTMLDivElement>(null);

  const isStreamingReasoning = turnRunning && step.status === 'running' && Boolean(step.reasoning);
  const expanded = userExpanded !== null ? userExpanded : isStreamingReasoning;

  useEffect(() => {
    if (isStreamingReasoning && reasoningRef.current) {
      reasoningRef.current.scrollTop = reasoningRef.current.scrollHeight;
    }
  }, [isStreamingReasoning, step.reasoning]);

  const elapsedMs =
    step.endedAt !== undefined
      ? step.endedAt - step.startedAt
      : step.status === 'running'
        ? now - step.startedAt
        : 0;

  const rowState = step.status === 'fail' ? 'fail' : step.status === 'running' && turnRunning ? 'running' : 'done';

  return (
    <li className={`timeline-step ${rowState}${isLast ? ' last' : ''}`}>
      <div className="timeline-rail" aria-hidden="true">
        <span className="timeline-node">
          {rowState === 'fail' ? (
            <XCircle size={12} />
          ) : rowState === 'running' ? (
            <span className="step-dot-active" />
          ) : (
            <Check size={11} />
          )}
        </span>
        {!isLast && <span className="timeline-line" />}
      </div>

      <div className="timeline-body-col">
        <div
          className={`timeline-step-head${hasDetails ? ' interactive' : ''}`}
          role={hasDetails ? 'button' : undefined}
          tabIndex={hasDetails ? 0 : undefined}
          aria-expanded={hasDetails ? expanded : undefined}
          onClick={hasDetails ? () => setUserExpanded((prev) => !(prev ?? expanded)) : undefined}
          onKeyDown={
            hasDetails
              ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setUserExpanded((prev) => !(prev ?? expanded));
                  }
                }
              : undefined
          }
        >
          <span className="timeline-step-title">{step.title}</span>
          <span className="timeline-step-meta">
            {step.codeLines !== undefined && <span className="step-meta-chip mono">{step.codeLines} 行</span>}
            {elapsedMs > 0 && <span className="step-elapsed mono">{formatDuration(elapsedMs)}</span>}
            {hasDetails && (
              <ChevronRight size={13} className={`step-chevron${expanded ? ' open' : ''}`} />
            )}
          </span>
        </div>

        {step.detail && <div className="step-note">{step.detail}</div>}

        {hasDetails && (
          <div className="collapse-grid" data-open={expanded}>
            <div className="collapse-inner">
              <div className="step-detail-drawer">
                {step.reasoning && (
                  <div className="step-reasoning-wrap">
                    <div className="step-sublabel">
                      <Brain size={11} /> 思考过程
                    </div>
                    <div ref={reasoningRef} className="step-reasoning-box">
                      {step.reasoning}
                    </div>
                  </div>
                )}

                {step.checkpoints && step.checkpoints.length > 0 && (
                  <ul className="step-checks-list">
                    {step.checkpoints.map((cp, idx) => (
                      <li key={idx}>{cp}</li>
                    ))}
                  </ul>
                )}

                {step.sources && step.sources.length > 0 && (
                  <div className="step-sources">
                    {step.sources.map((src, idx) => (
                      <a
                        key={`${src.url}-${idx}`}
                        href={src.url}
                        target="_blank"
                        rel="noreferrer"
                        className="step-source-link"
                      >
                        <span>{src.title}</span>
                        <ExternalLink size={10} />
                      </a>
                    ))}
                  </div>
                )}

                {step.highlightLine !== undefined && onJumpToLine && (
                  <button
                    type="button"
                    className="step-jump-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      onJumpToLine(step.highlightLine!);
                    }}
                  >
                    定位至第 {step.highlightLine} 行
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </li>
  );
}

function TraceAccordion({
  turn,
  onJumpToLine,
}: {
  turn: ChatTurn;
  onJumpToLine?: (line: number) => void;
}) {
  const isRunning = turn.status === 'running';
  const [expanded, setExpanded] = useState(isRunning);
  const [now, setNow] = useState(() => Date.now());
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (isRunning) {
      setExpanded(true);
      const id = window.setInterval(() => setNow(Date.now()), 120);
      return () => window.clearInterval(id);
    }
    if (turn.status === 'done') {
      setExpanded(false);
    }
  }, [isRunning, turn.status]);

  const steps = useMemo(
    () => mergeTracesToSteps(turn.traces ?? [], turn.liveReasoning),
    [turn.traces, turn.liveReasoning],
  );

  useEffect(() => {
    if (isRunning && expanded && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [isRunning, expanded, steps.length]);

  if (steps.length === 0) return null;

  const activeStep = [...steps].reverse().find((s) => s.status === 'running') ?? steps[steps.length - 1];
  const firstStart = turn.startedAt ?? steps[0].startedAt;
  const totalMs = isRunning
    ? now - firstStart
    : (turn.finishedAt ?? steps[steps.length - 1].endedAt ?? firstStart) - firstStart;

  const checkText = turn.totalChecks !== undefined ? ` · 自测 ${turn.passedChecks ?? 0}/${turn.totalChecks}` : '';
  const summaryLabel = isRunning
    ? `${activeStep.title}…`
    : turn.status === 'done'
      ? `已完成 · ${steps.length} 个步骤 · 用时 ${formatDuration(totalMs)}${checkText}`
      : turn.status === 'cancelled'
        ? `已停止 · 已执行 ${steps.length} 步`
        : `执行中断 · ${activeStep.title}`;

  return (
    <div
      className={`steps-card${turn.status === 'failed' ? ' failed' : ''}${expanded ? ' expanded' : ' collapsed'}`}
    >
      <button
        type="button"
        className="steps-head"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="steps-head-left">
          {isRunning ? (
            <span className="pulse-dot" />
          ) : turn.status === 'failed' ? (
            <XCircle size={13} className="err" />
          ) : (
            <Check size={13} className="ok" />
          )}
          <span className="steps-head-label">{summaryLabel}</span>
        </span>
        <span className="steps-head-right">
          {isRunning && <span className="steps-total-timer mono">{formatDuration(totalMs)}</span>}
          <ChevronRight size={14} className={`steps-head-chevron${expanded ? ' open' : ''}`} />
        </span>
      </button>

      <div className="collapse-grid" data-open={expanded}>
        <div className="collapse-inner">
          <ol ref={listRef} className="steps-list">
            {steps.map((step, index) => (
              <StepRow
                key={step.key}
                step={step}
                now={now}
                isLast={index === steps.length - 1}
                turnRunning={isRunning}
                onJumpToLine={onJumpToLine}
              />
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}

export function ChatPane({
  turns,
  onOpenCode,
  onDownloadCode,
  onOpenVerify,
  onOpenSettings,
  onJumpToLine,
}: {
  turns: ChatTurn[];
  onOpenCode: (code?: string) => void;
  onDownloadCode: (filename: string, code: string) => void;
  onOpenVerify: () => void;
  onOpenSettings: () => void;
  onJumpToLine?: (line: number) => void;
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
              <TraceAccordion turn={turn} onJumpToLine={onJumpToLine} />

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
                        V{turn.version ?? 1} · 门级网表已上板
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
