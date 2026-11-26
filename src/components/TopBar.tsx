import {
  ArrowUp,
  Bug,
  Globe,
  Pause,
  Play,
  Settings2,
  SkipForward,
  Sparkles,
  Square,
} from 'lucide-react';
import { useRef, useState, type CSSProperties } from 'react';
import type { LLMModelOption } from '../types/contracts';
import { CustomModelSelect } from './CustomSelect';

export type ClockSpeed = 'realtime' | 'slow' | 'step';

export const SPEED_INTERVAL_MS: Record<Exclude<ClockSpeed, 'step'>, number> = {
  realtime: 500,
  slow: 2500,
};

export function PromptComposer({
  onSend,
  onCancel,
  busy = false,
  compact = false,
  models,
  selectedModel,
  providerLabel,
  quotaNotice,
  onSelectModel,
  onOpenSettings,
  enableWebResearch,
  onToggleWebResearch,
  onInjectBug,
  liveHint,
  draftValue,
  onDraftChange,
  autoSubmitting = false,
  viewTransitionName,
}: {
  onSend: (prompt: string) => void;
  onCancel?: () => void;
  busy?: boolean;
  compact?: boolean;
  models: LLMModelOption[];
  selectedModel: string;
  providerLabel: string;
  quotaNotice?: { remaining?: number; limit?: number };
  onSelectModel: (modelId: string) => void;
  onOpenSettings: () => void;
  enableWebResearch: boolean;
  onToggleWebResearch: () => void;
  onInjectBug?: () => void;
  liveHint?: string;
  draftValue?: string;
  onDraftChange?: (value: string) => void;
  autoSubmitting?: boolean;
  viewTransitionName?: string;
}) {
  const [internalPrompt, setInternalPrompt] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const controlled = draftValue !== undefined;
  const prompt = controlled ? draftValue : internalPrompt;
  const setPrompt = (next: string) => {
    if (controlled) onDraftChange?.(next);
    else setInternalPrompt(next);
  };
  const placeholder = compact
    ? '继续描述修改需求，例如"把红灯延长到 8 拍"…'
    : '描述你想做的数字电路，例如"做一个带急停按键的十字路口交通灯"…';

  function submit() {
    const text = prompt.trim();
    if (busy || autoSubmitting || !text) return;
    onSend(text);
    setPrompt('');
  }

  return (
    <form
      className={`composer${compact ? ' composer-compact' : ''}${autoSubmitting ? ' composer-prefilling' : ''}`}
      style={viewTransitionName ? ({ viewTransitionName } as CSSProperties) : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <textarea
        ref={textareaRef}
        aria-label={compact ? '继续修改当前电路' : '电路需求'}
        placeholder={placeholder}
        rows={compact ? 2 : 3}
        maxLength={2000}
        value={prompt}
        readOnly={autoSubmitting}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={(event) => {
          if (
            event.key === 'Enter' &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing &&
            event.keyCode !== 229
          ) {
            event.preventDefault();
            submit();
          }
        }}
      />

      <div className="composer-foot">
        <div className="composer-tools">
          {models.length > 1 || Boolean(quotaNotice) ? (
            <CustomModelSelect
              ariaLabel="切换对话模型"
              variant="inline"
              options={models}
              value={selectedModel}
              onChange={onSelectModel}
              title={`当前服务商：${providerLabel} · ${selectedModel}`}
              quotaNotice={quotaNotice}
              footerAction={{ label: '管理 API 与模型…', onClick: onOpenSettings }}
            />
          ) : (
            <div className="model-select-wrap" title={`当前服务商：${providerLabel}`}>
              <Sparkles size={13} className="model-select-icon" />
              <button
                type="button"
                className="inline-model-trigger"
                onClick={onOpenSettings}
              >
                <span className="custom-select-value">{models[0]?.label ?? (selectedModel || providerLabel)}</span>
                <Settings2 size={11} />
              </button>
            </div>
          )}

          <button
            type="button"
            className={`tool-chip${enableWebResearch ? ' active' : ''}`}
            aria-pressed={enableWebResearch}
            title={enableWebResearch ? '联网查阅 Verilog 规范已开启' : '联网查阅已关闭'}
            onClick={onToggleWebResearch}
          >
            <Globe size={13} />
            <span>联网</span>
          </button>

          {onInjectBug && (
            <button
              type="button"
              className="tool-chip"
              disabled={busy}
              title="打开故障诊所或注入教学故障"
              onClick={onInjectBug}
            >
              <Bug size={13} />
              <span>故障诊所</span>
            </button>
          )}
        </div>

        <div className="composer-right">
          {liveHint && <span className="live-hint">{liveHint}</span>}
          {busy ? (
            <button
              className="stop-button"
              type="button"
              aria-label="停止生成"
              title="停止生成"
              onClick={onCancel}
            >
              <Square size={11} fill="currentColor" />
              <span>停止</span>
            </button>
          ) : (
            <button
              className={`send-button${autoSubmitting ? ' sending' : ''}`}
              type="submit"
              aria-label="发送需求"
              title="发送需求 (Enter)"
              disabled={!prompt.trim() && !autoSubmitting}
            >
              <ArrowUp size={17} />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

export function ClockControls({
  speed,
  running,
  disabled,
  onSpeed,
  onToggle,
  onStep,
}: {
  speed: ClockSpeed;
  running: boolean;
  disabled: boolean;
  onSpeed: (speed: ClockSpeed) => void;
  onToggle: () => void;
  onStep: () => void;
}) {
  return (
    <div className="clock-controls" role="group" aria-label="时钟控制">
      <div className="clock-modes">
        <button
          type="button"
          disabled={disabled}
          aria-pressed={speed === 'realtime'}
          onClick={() => onSpeed('realtime')}
        >
          实时
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-pressed={speed === 'slow'}
          onClick={() => onSpeed('slow')}
        >
          0.2×
        </button>
      </div>
      <button type="button" className="control-button" disabled={disabled} onClick={onStep}>
        <SkipForward size={13} /> 单步
      </button>
      <button type="button" className="control-button" disabled={disabled} onClick={onToggle}>
        {running && speed !== 'step' ? (
          <>
            <Pause size={13} /> 暂停
          </>
        ) : (
          <>
            <Play size={13} /> 运行
          </>
        )}
      </button>
    </div>
  );
}
