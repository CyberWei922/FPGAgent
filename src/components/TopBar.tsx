import { ArrowUp, CircuitBoard, Pause, Play, Plus, Settings2, SkipForward, Square } from 'lucide-react';
import { useState } from 'react';

export type ClockSpeed = 'realtime' | 'slow' | 'step';

export const SPEED_INTERVAL_MS: Record<Exclude<ClockSpeed, 'step'>, number> = { realtime: 500, slow: 2500 };

export function TopBar({ onSettings, onNewChat, hasCustomApi }: {
  onSettings: () => void;
  onNewChat?: () => void;
  hasCustomApi: boolean;
}) {
  return (
    <header className="app-bar">
      <div className="brand"><span className="brand-icon"><CircuitBoard size={19} /></span>FPGAgent</div>
      <div className="bar-actions">
        {onNewChat && <button className="plain-button" onClick={onNewChat}><Plus size={16} /> 新对话</button>}
        <button className="outline-button" onClick={onSettings}>
          <Settings2 size={16} /> API 设置{hasCustomApi && <span className="configured-dot" title="自定义 API 已配置" />}
        </button>
      </div>
    </header>
  );
}

export function PromptComposer({ onSend, onCancel, busy = false, compact = false }: {
  onSend: (prompt: string) => void;
  onCancel?: () => void;
  busy?: boolean;
  compact?: boolean;
}) {
  const [prompt, setPrompt] = useState('');
  const placeholder = compact ? '继续修改当前电路…' : '描述你想做的电路…';

  function submit() {
    const text = prompt.trim();
    if (busy || !text) return;
    onSend(text);
    setPrompt('');
  }

  return (
    <form className={`composer${compact ? ' composer-compact' : ''}`} onSubmit={(event) => {
      event.preventDefault();
      submit();
    }}>
      <textarea
        aria-label={compact ? '继续修改当前电路' : '电路需求'}
        placeholder={placeholder}
        rows={compact ? 1 : 2}
        maxLength={2000}
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            submit();
          }
        }}
      />
      {busy ? (
        <button className="send-button" type="button" aria-label="停止生成" title="停止生成" onClick={onCancel}><Square size={14} /></button>
      ) : (
        <button className="send-button" type="submit" aria-label="发送需求" title="发送需求" disabled={!prompt.trim()}><ArrowUp size={19} /></button>
      )}
    </form>
  );
}

export function ClockControls({ speed, running, disabled, onSpeed, onToggle, onStep }: {
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
        <button disabled={disabled} aria-pressed={speed === 'realtime'} onClick={() => onSpeed('realtime')}>实时</button>
        <button disabled={disabled} aria-pressed={speed === 'slow'} onClick={() => onSpeed('slow')}>0.2×</button>
      </div>
      <button className="control-button" disabled={disabled} onClick={onStep}><SkipForward size={14} /> 单步</button>
      <button className="control-button" disabled={disabled} onClick={onToggle}>
        {running && speed !== 'step' ? <><Pause size={14} /> 暂停</> : <><Play size={14} /> 运行</>}
      </button>
    </div>
  );
}
