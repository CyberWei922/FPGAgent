import { CircuitBoard, Compass, ExternalLink, GitBranch, Users, X } from 'lucide-react';
import { useEffect, useRef } from 'react';

const REPO_URL = 'https://github.com/CyberWei922/qoderationability';

const VISION_PILLARS = [
  {
    title: '填补 FPGA 与 Verilog 专属 Agent 空白',
    body: '市面上通用编程助手众多，却鲜有真正面向 FPGA 开发与可综合 Verilog 代码生成的专属 Agent。FPGAgent 围绕硬件描述语言的时序、状态机与综合约束构建，让硬件开发不再依赖通用聊天框反复试错。',
  },
  {
    title: '对话退居侧栏，板卡与代码占据中央',
    body: '硬件调试的重心在于观察电路与信号，而不是翻阅长段对话。我们将 AI 对话收敛到旁观侧栏，把门级原理图、虚拟开发板、实时波形与 Verilog 代码放到工作台中央，回归以硬件为核心的开发体验。',
  },
  {
    title: '零环境门槛，生成即仿真验证',
    body: '无需配置繁重的本地 EDA 工具链，在浏览器内即可打通“自然语言需求 → 蓝图规划 → 可综合 Verilog → 静态 Lint 与确定性自测 → 交互式板卡与波形验证”的完整闭环。',
  },
] as const;

const AUTHORS = [
  {
    handle: 'CyberWei922',
    role: '队长 · 全栈统筹 / 前端工作台 / 云端部署',
    url: 'https://github.com/CyberWei922',
  },
  {
    handle: 'ForrestKang',
    role: '硬件解析 / 周期仿真引擎 / 教学网表',
    url: 'https://github.com/ForrestKang',
  },
  {
    handle: 'fzd1210-beep',
    role: 'AI 智能体闭环 / 故障诊所 / 预置案例',
    url: 'https://github.com/fzd1210-beep',
  },
] as const;

export function AboutModal({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      aria-labelledby="about-modal-title"
      className="about-dialog"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) dialog.current?.close();
      }}
    >
      <div className="dialog-heading">
        <div className="dialog-title-group">
          <CircuitBoard size={18} />
          <h2 id="about-modal-title">关于 FPGAgent</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭关于弹窗"
          onClick={() => dialog.current?.close()}
        >
          <X size={18} />
        </button>
      </div>

      <div className="about-body">
        <div className="about-hero">
          <div className="about-badge">2026 Qoder 高校创造力大赛 · StudyHack 赛道</div>
          <p className="about-desc">
            <strong>专注于 FPGA 的 AI Agent</strong> — 面向数字电路设计与可综合 Verilog
            开发的浏览器端硬件工作台。输入自然语言需求，自动规划蓝图、生成可综合 Verilog、在浏览器内完成静态 Lint
            与确定性自测，并通过门级原理图、实时波形与虚拟开发板直观呈现数字电路信号流。
          </p>
        </div>

        <div className="about-section">
          <span className="about-section-label">
            <Compass size={13} /> 项目初衷与设计理念
          </span>
          <div className="about-pillars">
            {VISION_PILLARS.map((item) => (
              <div key={item.title} className="about-pillar">
                <strong>{item.title}</strong>
                <p>{item.body}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="about-section">
          <span className="about-section-label">
            <GitBranch size={13} /> 开源仓库
          </span>
          <a className="about-repo-link" href={REPO_URL} target="_blank" rel="noreferrer">
            <span className="about-repo-text">
              <strong>CyberWei922 / qoderationability</strong>
              <span>{REPO_URL}</span>
            </span>
            <ExternalLink size={14} />
          </a>
        </div>

        <div className="about-section">
          <span className="about-section-label">
            <Users size={13} /> 开发团队
          </span>
          <div className="about-authors">
            {AUTHORS.map((author) => (
              <a
                key={author.handle}
                className="about-author-card"
                href={author.url}
                target="_blank"
                rel="noreferrer"
              >
                <span className="about-author-info">
                  <strong>@{author.handle}</strong>
                  <span>{author.role}</span>
                </span>
                <ExternalLink size={13} />
              </a>
            ))}
          </div>
        </div>
      </div>
    </dialog>
  );
}
