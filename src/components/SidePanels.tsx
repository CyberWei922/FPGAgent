import {
  AlertTriangle,
  ArrowRight,
  Bug,
  CheckCircle2,
  Clock,
  Download,
  Lightbulb,
  Play,
  RotateCcw,
  Sparkles,
  Trash2,
  Wrench,
} from 'lucide-react';
import type { HistoryEntry } from '../services/sessionHistory';
import type { BugClinicCase, PresetProject, SelfTestResult } from '../types/contracts';

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
                <span className="mono-meta">{preset.bugs.length} 个故障关卡</span>
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

export function BugClinicPanel({
  presets,
  activePreset,
  hasCircuit,
  activeBug,
  hintLevel,
  selfTest,
  injecting,
  onInjectPresetBug,
  onInjectAiBug,
  onRevealHint,
  onApplyFix,
  onExitBug,
  onLoadPreset,
  onJumpToLine,
}: {
  presets: PresetProject[];
  activePreset?: PresetProject;
  hasCircuit: boolean;
  activeBug: BugClinicCase | null;
  hintLevel: 0 | 1 | 2 | 3;
  selfTest?: SelfTestResult;
  injecting: boolean;
  onInjectPresetBug: (bug: BugClinicCase, sourcePreset?: PresetProject) => void;
  onInjectAiBug: () => void;
  onRevealHint: (level: 1 | 2 | 3) => void;
  onApplyFix: () => void;
  onExitBug: () => void;
  onLoadPreset: (preset: PresetProject) => void;
  onJumpToLine: (line?: number) => void;
}) {
  const availableBugs: Array<{ bug: BugClinicCase; preset: PresetProject }> = activePreset
    ? activePreset.bugs.map((bug) => ({ bug, preset: activePreset }))
    : presets.slice(0, 3).flatMap((preset) => preset.bugs.slice(0, 1).map((bug) => ({ bug, preset })));

  return (
    <div className="drawer-scroll">
      {activeBug ? (
        <div className="clinic-active">
          <div className="clinic-banner">
            <div className="clinic-banner-head">
              <span className="clinic-badge">
                <AlertTriangle size={13} /> 故障排错中
              </span>
              <span className="mono-meta">{activeBug.pitfallTag}</span>
            </div>
            <h3>{activeBug.title}</h3>
            <p className="clinic-symptom">{activeBug.symptom}</p>
            {selfTest && !selfTest.passed && (
              <div className="clinic-failure-box">
                {selfTest.firstFailure ? (
                  <>
                    自测第 <strong>{selfTest.firstFailure.cycle}</strong> 拍失配：
                    <code>{selfTest.firstFailure.signal}</code> 期望{' '}
                    <code>{selfTest.firstFailure.expected}</code>，实际{' '}
                    <code>{selfTest.firstFailure.actual}</code>
                  </>
                ) : (
                  <>自测未通过（{selfTest.passedChecks}/{selfTest.totalChecks}），请检查 Lint 与波形。</>
                )}
              </div>
            )}
            {selfTest?.passed && (
              <div className="clinic-pass-box">
                <CheckCircle2 size={14} /> 已通过全部 {selfTest.totalChecks} 项自测！故障修复成功。
              </div>
            )}
          </div>

          <div className="hint-ladder">
            <h4>苏格拉底渐进提示</h4>

            <div className={`hint-step${hintLevel >= 1 ? ' revealed' : ''}`}>
              <div className="hint-step-head">
                <span><Lightbulb size={14} /> 第 1 档 · 思考线索</span>
                {hintLevel < 1 && (
                  <button type="button" className="mini-action-btn" onClick={() => onRevealHint(1)}>
                    查看线索
                  </button>
                )}
              </div>
              {hintLevel >= 1 && <p>{activeBug.diagnosis.level1Hint}</p>}
            </div>

            <div className={`hint-step${hintLevel >= 2 ? ' revealed' : ''}`}>
              <div className="hint-step-head">
                <span><Bug size={14} /> 第 2 档 · 错因定位</span>
                {hintLevel < 2 && (
                  <button type="button" className="mini-action-btn" onClick={() => onRevealHint(2)}>
                    定位错因
                  </button>
                )}
              </div>
              {hintLevel >= 2 && (
                <div>
                  <p>{activeBug.diagnosis.level2Cause}</p>
                  {activeBug.diagnosis.highlightLine && (
                    <button
                      type="button"
                      className="text-link inline-link"
                      onClick={() => onJumpToLine(activeBug.diagnosis.highlightLine)}
                    >
                      跳转到 Verilog 第 {activeBug.diagnosis.highlightLine} 行 <ArrowRight size={12} />
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className={`hint-step${hintLevel >= 3 ? ' revealed' : ''}`}>
              <div className="hint-step-head">
                <span><Wrench size={14} /> 第 3 档 · 标准修复方案</span>
                {hintLevel < 3 && (
                  <button type="button" className="mini-action-btn" onClick={() => onRevealHint(3)}>
                    展开修复
                  </button>
                )}
              </div>
              {hintLevel >= 3 && (
                <div className="hint-fix-actions">
                  <p className="field-help">点击下方按钮将应用修复补丁并重新执行确定性自测。</p>
                  <button type="button" className="primary-button compact-btn" onClick={onApplyFix}>
                    <Wrench size={13} /> 一键应用修复并复测
                  </button>
                </div>
              )}
            </div>
          </div>

          <button type="button" className="outline-button full-width" onClick={onExitBug}>
            <RotateCcw size={14} /> 退出诊所并恢复原电路
          </button>
        </div>
      ) : (
        <>
          <div className="drawer-intro">
            <p>选择一个典型 RTL 踩坑关卡注入到当前电路，结合板卡现象、自测波形与三档提示定位并修复故障。</p>
          </div>

          {hasCircuit ? (
            <button
              type="button"
              className="ai-inject-card"
              disabled={injecting}
              onClick={onInjectAiBug}
            >
              <span className="ai-inject-icon">
                <Sparkles size={16} />
              </span>
              <span className="ai-inject-copy">
                <strong>{injecting ? 'AI 正在构造隐蔽故障…' : 'AI 为当前电路注入隐蔽故障'}</strong>
                <small>自动生成典型阻塞赋值 / 锁存器 / 位宽截断坑点与三档提示</small>
              </span>
            </button>
          ) : (
            <div className="empty-box">
              <p>先载入一个电路，即可开始故障排错挑战。</p>
              <div className="empty-actions">
                {presets.slice(0, 2).map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className="outline-button compact-btn"
                    onClick={() => onLoadPreset(preset)}
                  >
                    载入「{preset.name}」
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="clinic-list">
            <h4 className="drawer-subheading">
              {activePreset ? `「${activePreset.name}」内置故障关卡` : '精选教学故障关卡'}
            </h4>
            {availableBugs.map(({ bug, preset }) => (
              <article key={bug.id} className="bug-card">
                <div className="bug-card-head">
                  <span className="tag-pill warn">{bug.pitfallTag}</span>
                  <span className="mono-meta">{preset.name}</span>
                </div>
                <h3>{bug.title}</h3>
                <p>{bug.symptom}</p>
                <button
                  type="button"
                  className="outline-button compact-btn"
                  onClick={() => onInjectPresetBug(bug, preset)}
                >
                  <Bug size={13} /> 注入此故障开始排错
                </button>
              </article>
            ))}
          </div>
        </>
      )}
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
                <Play size={12} /> 载入工作台
              </button>
              <button
                type="button"
                className="icon-button"
                title={`导出 ${entry.filename}`}
                aria-label={`导出 ${entry.filename}`}
                onClick={() => onDownload(entry)}
              >
                <Download size={14} />
              </button>
              <button
                type="button"
                className="icon-button"
                title="删除记录"
                aria-label="删除记录"
                onClick={() => onDelete(entry.id)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
