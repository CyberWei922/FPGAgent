import { CircuitBoard, ExternalLink, GitBranch, Users, X } from 'lucide-react';
import { useEffect, useRef } from 'react';

const REPO_URL = 'https://github.com/CyberWei922/qoderationability';

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
            AI 驱动的可验证浏览器虚拟 FPGA 实验室。输入自然语言需求，自动规划蓝图、生成可综合 Verilog、在浏览器内完成静态 Lint 与确定性自测，并通过门级原理图、实时波形与虚拟开发板直观呈现数字电路信号流。
          </p>
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
