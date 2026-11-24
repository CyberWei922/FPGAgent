import { Pause, Play, SkipForward, Sparkles, Square } from 'lucide-react';
import { useState } from 'react';
import type { PresetProject } from '../types/contracts';

export type ClockSpeed = 'realtime' | 'slow' | 'step';

export const SPEED_INTERVAL_MS: Record<Exclude<ClockSpeed, 'step'>, number> = {
  realtime: 500,
  slow: 2500,
};

interface Props {
  presets: PresetProject[];
  activePresetId?: string;
  generating: boolean;
  running: boolean;
  speed: ClockSpeed;
  remainingQuota?: number;
  onGenerate: (prompt: string) => void;
  onCancel: () => void;
  onLoadPreset: (preset: PresetProject) => void;
  onSpeedChange: (speed: ClockSpeed) => void;
  onToggleRun: () => void;
  onStep: () => void;
}

const SPEEDS: [ClockSpeed, string][] = [
  ['realtime', '实时'],
  ['slow', '0.2x'],
  ['step', '单步'],
];

export function TopBar(props: Props) {
  const [prompt, setPrompt] = useState('');
  const canGenerate = prompt.trim().length > 0 && !props.generating;

  return (
    <header className="flex flex-col gap-2 border-b border-slate-800 bg-slate-950/80 px-4 py-3">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (canGenerate) props.onGenerate(prompt.trim());
        }}
      >
        <span className="mr-2 font-semibold tracking-wide text-cyan-300">VibeFPGA Lab</span>
        <input
          className="flex-1 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm outline-none focus:border-cyan-500"
          placeholder="用一句话描述想做的硬件电路（如：带紧急制动按钮的交通灯）"
          value={prompt}
          maxLength={300}
          onChange={(e) => setPrompt(e.target.value)}
        />
        {props.generating ? (
          <button type="button" onClick={props.onCancel} className="flex items-center gap-1 rounded-md bg-rose-600 px-4 py-2 text-sm">
            <Square size={14} /> 取消
          </button>
        ) : (
          <button
            type="submit"
            disabled={!canGenerate}
            className="flex items-center gap-1 rounded-md bg-cyan-600 px-4 py-2 text-sm disabled:opacity-40"
          >
            <Sparkles size={14} /> AI 生成
          </button>
        )}
        {props.remainingQuota !== undefined && (
          <span className="text-xs text-slate-400">今日剩余 {props.remainingQuota} 次</span>
        )}
      </form>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-slate-400">预置案例：</span>
        {props.presets.map((p) => (
          <button
            key={p.id}
            onClick={() => props.onLoadPreset(p)}
            className={`rounded px-2 py-1 ${p.id === props.activePresetId ? 'bg-cyan-700' : 'bg-slate-800 hover:bg-slate-700'}`}
          >
            {p.name}
          </button>
        ))}

        <span className="ml-auto text-slate-400">时钟：</span>
        <div className="flex overflow-hidden rounded border border-slate-700">
          {SPEEDS.map(([value, label]) => (
            <button
              key={value}
              onClick={() => props.onSpeedChange(value)}
              className={`px-2 py-1 ${props.speed === value ? 'bg-cyan-700' : 'bg-slate-900 hover:bg-slate-800'}`}
            >
              {label}
            </button>
          ))}
        </div>
        {props.speed !== 'step' && (
          <button onClick={props.onToggleRun} className="rounded bg-slate-800 p-1.5 hover:bg-slate-700" title={props.running ? '暂停' : '运行'}>
            {props.running ? <Pause size={16} /> : <Play size={16} />}
          </button>
        )}
        <button onClick={props.onStep} className="rounded bg-slate-800 p-1.5 hover:bg-slate-700" title="单步一个时钟">
          <SkipForward size={16} />
        </button>
      </div>
    </header>
  );
}
