import {
  Clock,
  Download,
  Play,
  Trash2,
} from 'lucide-react';
import type { HistoryEntry } from '../services/sessionHistory';
import type { PresetProject } from '../types/contracts';

const PRESET_META: Record<string, { category: string; difficulty: string }> = {
  'traffic-light': { category: '状态机', difficulty: '入门' },
  'password-lock': { category: '安全逻辑', difficulty: '进阶' },
  'sequence-detector': { category: '串行检测', difficulty: '进阶' },
  stopwatch: { category: '计数器', difficulty: '入门' },
  buzzer: { category: '仲裁锁存', difficulty: '入门' },
};

const DIFFICULTY_TEXT: Record<NonNullable<PresetProject['difficulty']>, string> = {
  beginner: '入门',
  intermediate: '进阶',
  advanced: '挑战',
};

export function PresetsPanel({
  presets,
  activePresetId,
  busy,
  onSelectPreset,
}: {
  presets: PresetProject[];
  activePresetId?: string;
  busy: boolean;
  onSelectPreset: (preset: PresetProject) => void;
}) {
  return (
    <div className="drawer-scroll">
      <div className="drawer-intro">
        <p>所有预置案例均由浏览器内真实 RTL 引擎实时编译、自测与仿真，零 Token 消耗。</p>
      </div>
      <div className="preset-cards">
        {presets.map((preset) => {
          const fallback = PRESET_META[preset.id] ?? { category: '数字逻辑', difficulty: '入门' };
          const category = preset.category ?? fallback.category;
          const difficulty = preset.difficulty ? DIFFICULTY_TEXT[preset.difficulty] : fallback.difficulty;
          const active = preset.id === activePresetId;

          return (
            <article key={preset.id} className={`preset-card${active ? ' active' : ''}`}>
              <div className="preset-card-top">
                <div className="preset-tags">
                  <span className="tag-pill">{category}</span>
                  <span className="tag-pill subtle">{difficulty}</span>
                </div>
                <span className="mono-meta">{preset.testVectors.length} 拍自测</span>
              </div>
              <h3>{preset.name}</h3>
              <p>{preset.blueprint.summary}</p>
              <div className="preset-card-foot">
                <span className="mono-meta">零 Token 实时仿真</span>
                <button
                  type="button"
                  className={active ? 'outline-button compact-btn' : 'primary-button compact-btn'}
                  disabled={busy}
                  onClick={() => onSelectPreset(preset)}
                >
                  <Play size={12} /> {active ? '重新载入' : '上板运行'}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

export function HistoryPanel({
  entries,
  onRestore,
  onDownload,
  onDelete,
  onClear,
}: {
  entries: HistoryEntry[];
  onRestore: (entry: HistoryEntry) => void;
  onDownload: (entry: HistoryEntry) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
}) {
  if (entries.length === 0) {
    return (
      <div className="drawer-scroll">
        <div className="empty-box">
          <Clock size={22} />
          <p>尚无本地电路记录</p>
          <small>运行预设演示或生成通过验证的电路后，版本快照会自动保存在这里。</small>
        </div>
      </div>
    );
  }

  return (
    <div className="drawer-scroll">
      <div className="history-top-bar">
        <span>共 {entries.length} 条本地快照</span>
        <button type="button" className="text-link danger" onClick={onClear}>
          清空记录
        </button>
      </div>
      <div className="history-list">
        {entries.map((entry) => (
          <article key={entry.id} className="history-card">
            <div className="history-card-head">
              <strong>{entry.title}</strong>
              <span className="tag-pill subtle">V{entry.version}</span>
            </div>
            <p className="history-prompt">{entry.prompt}</p>
            <div className="history-meta">
              <span className="mono-meta">{entry.filename}</span>
              {entry.totalChecks !== undefined && (
                <span className="mono-meta ok">
                  {entry.passedChecks}/{entry.totalChecks}
                </span>
              )}
              <span className="mono-meta">
                {new Date(entry.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            <div className="history-actions">
              <button type="button" className="outline-button compact-btn" onClick={() => onRestore(entry)}>
                <Play size={12} /> 载入
              </button>
              <button
                type="button"
                className="outline-button compact-btn"
                title={`下载 ${entry.filename}`}
                onClick={() => onDownload(entry)}
              >
                <Download size={12} /> 下载
              </button>
              <button
                type="button"
                className="outline-button compact-btn danger-btn"
                title="删除记录"
                onClick={() => onDelete(entry.id)}
              >
                <Trash2 size={12} /> 删除
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
