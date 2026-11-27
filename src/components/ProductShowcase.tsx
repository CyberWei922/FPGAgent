import {
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  LayoutGrid,
  Play,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { PresetProject } from '../types/contracts';
import { BrandWordmark } from './BrandWordmark';

const REPO_URL = 'https://github.com/CyberWei922/FPGAgent';

const PIPELINE_STEPS = [
  { step: '01', title: '需求解析', detail: '描述时序、按键与外设行为' },
  { step: '02', title: '架构蓝图', detail: '拆解端口映射与有限状态机' },
  { step: '03', title: '流式编码', detail: '词法级输出可综合 Verilog' },
  { step: '04', title: '静态与自测', detail: 'Lint 体检与多拍向量自修复' },
  { step: '05', title: '上板仿真', detail: '门级原理图、波形与板卡联动' },
] as const;

const DEVELOPERS = [
  {
    index: '01',
    badge: '项目队长',
    handle: 'CyberWei922',
    focus: '全栈统筹 · 前端工作台 · 云端部署',
    summary:
      '主导硬件居中工作台交互架构与跨模块公共契约，负责多模型流式接入、联调与 Qoder Sites 部署。',
    url: 'https://github.com/CyberWei922',
    displayUrl: 'github.com/CyberWei922',
  },
  {
    index: '02',
    badge: '核心引擎',
    handle: 'ForrestKang',
    focus: '硬件解析 · 周期仿真引擎 · 教学网表',
    summary:
      '构建纯浏览器端 Verilog 解析器、可综合静态 Linter 与周期精确仿真内核，支撑门级网表提取与确定性自测。',
    url: 'https://github.com/ForrestKang',
    displayUrl: 'github.com/ForrestKang',
  },
  {
    index: '03',
    badge: '智能体与案例',
    handle: 'fzd1210-beep',
    focus: 'AI 智能体闭环 · 校验自修复 · 预置案例',
    summary:
      '设计多阶段硬件 Agent 规划与校验自修复闭环，构建渐进式排错能力，并沉淀五大经典数字逻辑案例库。',
    url: 'https://github.com/fzd1210-beep',
    displayUrl: 'github.com/fzd1210-beep',
  },
] as const;

function GitHubGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 1.5C6.2 1.5 1.5 6.2 1.5 12c0 4.64 3.01 8.58 7.18 9.97.53.1.72-.23.72-.51 0-.25-.01-1.08-.01-1.96-2.92.63-3.54-1.24-3.54-1.24-.48-1.21-1.16-1.53-1.16-1.53-.95-.65.07-.64.07-.64 1.05.07 1.61 1.08 1.61 1.08.93 1.6 2.45 1.14 3.05.87.09-.68.36-1.14.66-1.4-2.33-.26-4.78-1.17-4.78-5.19 0-1.15.41-2.08 1.08-2.82-.11-.26-.47-1.33.1-2.78 0 0 .88-.28 2.89 1.08a10.1 10.1 0 0 1 5.26 0c2-1.36 2.88-1.08 2.88-1.08.58 1.45.22 2.52.11 2.78.67.74 1.08 1.67 1.08 2.82 0 4.03-2.46 4.92-4.8 5.18.38.32.71.96.71 1.94 0 1.4-.01 2.53-.01 2.87 0 .28.19.62.73.51A10.5 10.5 0 0 0 22.5 12C22.5 6.2 17.8 1.5 12 1.5Z" />
    </svg>
  );
}

function HeroCircuitBackdrop() {
  return (
    <svg
      className="showcase-hero-grid-svg"
      viewBox="0 0 1200 540"
      fill="none"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <defs>
        <pattern id="showcase-dot-grid" width="28" height="28" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1" fill="currentColor" opacity="0.22" />
        </pattern>
        <radialGradient id="showcase-grid-mask-grad" cx="50%" cy="46%" r="54%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
          <stop offset="72%" stopColor="#ffffff" stopOpacity="0.45" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <mask id="showcase-grid-mask">
          <rect width="1200" height="540" fill="url(#showcase-grid-mask-grad)" />
        </mask>
      </defs>
      <rect width="1200" height="540" fill="url(#showcase-dot-grid)" mask="url(#showcase-grid-mask)" />
      <g className="showcase-trace-lines" mask="url(#showcase-grid-mask)">
        <path d="M60 154H232L268 190H364" stroke="var(--accent)" strokeWidth="1.2" opacity="0.34" />
        <path d="M96 292H208L244 256H342" stroke="var(--accent)" strokeWidth="1.1" opacity="0.24" />
        <path d="M1140 166H968L932 202H836" stroke="var(--accent)" strokeWidth="1.2" opacity="0.34" />
        <path d="M1104 304H992L956 268H858" stroke="var(--accent)" strokeWidth="1.1" opacity="0.24" />
        <circle cx="364" cy="190" r="3" fill="var(--accent)" opacity="0.58" />
        <circle cx="342" cy="256" r="2.5" fill="var(--accent)" opacity="0.4" />
        <circle cx="836" cy="202" r="3" fill="var(--accent)" opacity="0.58" />
        <circle cx="858" cy="268" r="2.5" fill="var(--accent)" opacity="0.4" />
      </g>
    </svg>
  );
}

function WorkbenchPreviewArtwork() {
  return (
    <div className="showcase-workbench-mock" aria-hidden="true">
      <div className="mock-window-bar">
        <span className="mock-dot active" />
        <span className="mock-file mono">traffic_light.v · V1</span>
        <span className="mock-status mono">CLK ↑ 14 · 20/20 PASS</span>
      </div>
      <div className="mock-schematic-wrap">
        <svg viewBox="0 0 460 184" fill="none" className="mock-schematic-svg">
          <path d="M24 44H118" className="mock-wire active" />
          <path d="M24 88H92V62H118" className="mock-wire" />
          <path d="M24 134H118" className="mock-wire active" />
          <path d="M188 53H246V74H276" className="mock-wire active" />
          <path d="M188 134H246V102H276" className="mock-wire" />
          <path d="M348 88H432" className="mock-wire active" />
          <path d="M392 88V142H432" className="mock-wire active" />

          <g transform="translate(118, 28)">
            <rect width="70" height="50" rx="4" className="mock-gate-box active" />
            <text x="35" y="23" textAnchor="middle" className="mock-gate-label">FSM</text>
            <text x="35" y="38" textAnchor="middle" className="mock-gate-sub">STATE[1:0]</text>
          </g>

          <g transform="translate(118, 109)">
            <rect width="70" height="50" rx="4" className="mock-gate-box" />
            <text x="35" y="23" textAnchor="middle" className="mock-gate-label">CNT</text>
            <text x="35" y="38" textAnchor="middle" className="mock-gate-sub">TIMER[3:0]</text>
          </g>

          <g transform="translate(276, 62)">
            <rect width="72" height="52" rx="4" className="mock-gate-box active" />
            <text x="36" y="24" textAnchor="middle" className="mock-gate-label">MUX</text>
            <text x="36" y="39" textAnchor="middle" className="mock-gate-sub">OUT_DEC</text>
          </g>

          <circle cx="24" cy="44" r="3.5" className="mock-port active" />
          <circle cx="24" cy="88" r="3.5" className="mock-port" />
          <circle cx="24" cy="134" r="3.5" className="mock-port active" />
          <circle cx="432" cy="88" r="4" className="mock-port active" />
          <circle cx="432" cy="142" r="4" className="mock-port active" />
        </svg>
      </div>
      <div className="mock-bottom-strip">
        <div className="mock-wave-box">
          <span className="mono mock-strip-label">CLK / TRAFFIC</span>
          <svg viewBox="0 0 220 26" fill="none" className="mock-wave-svg">
            <path
              d="M2 20H18V6H38V20H58V6H78V20H98V6H118V20H138V6H158V20H178V6H198V20H218"
              stroke="var(--accent)"
              strokeWidth="1.6"
              strokeLinejoin="miter"
            />
          </svg>
        </div>
        <div className="mock-board-box">
          <span className="mono mock-strip-label">BOARD</span>
          <div className="mock-leds">
            <span className="mock-led on-green" />
            <span className="mock-led" />
            <span className="mock-led on-amber" />
            <span className="mock-seg mono">08</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ProductShowcase({
  presets,
  hasActiveSession,
  onStartDesigning,
  onReturnWorkbench,
  onTryPreset,
  onOpenPresets,
}: {
  presets: PresetProject[];
  hasActiveSession: boolean;
  onStartDesigning: () => void;
  onReturnWorkbench: () => void;
  onTryPreset: (preset: PresetProject) => void;
  onOpenPresets: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const ctaRef = useRef<HTMLDivElement>(null);
  const [showTopbar, setShowTopbar] = useState(false);
  const featuredPreset = presets.find((p) => p.id === 'traffic-light') ?? presets[0];

  useEffect(() => {
    const scrollEl = scrollRef.current;
    const ctaEl = ctaRef.current;
    if (!scrollEl || !ctaEl) return;

    const updateVisibility = () => {
      const overflowY = window.getComputedStyle(scrollEl).overflowY;
      const usesInnerScroll = overflowY === 'auto' || overflowY === 'scroll';
      const containerTop = usesInnerScroll ? scrollEl.getBoundingClientRect().top : 0;
      const ctaBottom = ctaEl.getBoundingClientRect().bottom;
      setShowTopbar(ctaBottom <= containerTop);
    };

    updateVisibility();
    scrollEl.addEventListener('scroll', updateVisibility, { passive: true });
    window.addEventListener('scroll', updateVisibility, { passive: true });
    window.addEventListener('resize', updateVisibility);

    return () => {
      scrollEl.removeEventListener('scroll', updateVisibility);
      window.removeEventListener('scroll', updateVisibility);
      window.removeEventListener('resize', updateVisibility);
    };
  }, []);

  return (
    <main className="showcase-stage" aria-label="FPGAgent 产品介绍">
      <header
        className="showcase-topbar"
        data-visible={showTopbar ? 'true' : 'false'}
        aria-hidden={!showTopbar}
      >
        <div className="showcase-topbar-left">
          <button
            type="button"
            className="showcase-topbar-brand"
            onClick={() => {
              scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
            title="回到顶部"
            aria-label="FPGAgent 回到顶部"
          >
            <BrandWordmark className="showcase-topbar-logo" />
          </button>
          <span className="showcase-topbar-sep" aria-hidden="true" />
          <span className="showcase-topbar-subtitle">专注于 FPGA 的 AI Agent</span>
        </div>

        <div className="showcase-topbar-actions">
          <a
            className="showcase-ghost-link"
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            <GitHubGlyph size={14} />
            <span>GitHub</span>
            <ExternalLink size={12} />
          </a>

          <button
            type="button"
            className="primary-button compact-btn"
            onClick={hasActiveSession ? onReturnWorkbench : onStartDesigning}
          >
            {hasActiveSession ? '返回工作台' : '进入工作台'}
            <ArrowRight size={14} />
          </button>
        </div>
      </header>

      <div className="showcase-scroll" ref={scrollRef}>
        {/* 1. Centerpiece Hero with BrandWordmark */}
        <section className="showcase-hero">
          <HeroCircuitBackdrop />
          <div className="showcase-hero-inner">
            <div className="showcase-award-kicker mono">
              2026 Qoder 高校创造力大赛 · StudyHack 赛道
            </div>

            <div className="showcase-logo-stage">
              <BrandWordmark className="showcase-hero-logo" />
            </div>

            <h1 className="showcase-hero-title">专注于 FPGA 的 AI Agent</h1>

            <p className="showcase-hero-lead">
              输入自然语言硬件需求，自动规划状态机蓝图、流式生成可综合 Verilog，并在浏览器内完成周期精确自测、门级仿真与虚拟开发板验证。
            </p>

            <div className="showcase-hero-cta" ref={ctaRef}>
              <button
                type="button"
                className="primary-button showcase-cta-primary"
                onClick={hasActiveSession ? onReturnWorkbench : onStartDesigning}
              >
                {hasActiveSession ? '返回当前工作台' : '立即开始设计电路'}
                <ArrowRight size={15} />
              </button>

              {featuredPreset && (
                <button
                  type="button"
                  className="outline-button showcase-cta-secondary"
                  onClick={() => onTryPreset(featuredPreset)}
                >
                  <Play size={14} />
                  试跑「{featuredPreset.name}」
                </button>
              )}

              <a
                className="showcase-cta-repo"
                href={REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                <GitHubGlyph size={15} />
                <span>开源仓库</span>
                <ExternalLink size={12} />
              </a>
            </div>

            <ol className="showcase-pipeline" aria-label="FPGAgent 硬件闭环流程">
              {PIPELINE_STEPS.map((item) => (
                <li key={item.step} className="showcase-pipe-node">
                  <span className="showcase-pipe-num mono">{item.step}</span>
                  <strong>{item.title}</strong>
                  <span>{item.detail}</span>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* 2. Asymmetric Capabilities Showcase */}
        <section className="showcase-section" aria-labelledby="showcase-capabilities-title">
          <div className="showcase-section-head">
            <h2 id="showcase-capabilities-title">以硬件验证为中心的工作台</h2>
            <p>
              从状态机规划、可综合代码校验到门级实时仿真，全部在浏览器本地执行，无需配置本地 EDA 工具链。
            </p>
          </div>

          <div className="showcase-bento">
            <article className="showcase-bento-lead">
              <div className="showcase-bento-copy">
                <span className="showcase-feature-kicker mono">01 · 硬件主视图</span>
                <h3>对话退居侧栏，原理图、波形与板卡占据中央</h3>
                <p>
                  将 Agent 的推理轨迹与自测清单收纳于可折叠侧栏；主视区留给高电平实时高亮的门级原理图、多通道逻辑波形与虚拟开发板，支持实时、0.2× 慢放与单步时钟推进。
                </p>
                <div className="showcase-spec-line mono">
                  高电平实时追踪 · 实时 / 0.2× / 单步时钟 · 一键导出 .v 与 tb_top.v
                </div>
              </div>
              <WorkbenchPreviewArtwork />
            </article>

            <article className="showcase-bento-card">
              <span className="showcase-feature-kicker mono">02 · 浏览器 RTL 内核</span>
              <h3>写完即编译，在上板前拦截 RTL 常见缺陷</h3>
              <p>
                纯前端 Verilog 解析器、可综合静态 Linter 与周期精确仿真器随流式代码同步运行：自动检出阻塞赋值混用、隐含锁存器与位宽截断，向量失配直接定位拍数与源码行号并触发自修复。
              </p>
              <div className="showcase-code-preview" aria-hidden="true">
                <div className="showcase-code-lines mono">
                  <div>
                    <span className="sc-kw">always</span> @(<span className="sc-kw">posedge</span> clk{' '}
                    <span className="sc-kw">or negedge</span> rst_n) <span className="sc-kw">begin</span>
                  </div>
                  <div>
                    {'  '}
                    <span className="sc-kw">if</span> (!rst_n) state &lt;= <span className="sc-num">2&apos;d0</span>;
                  </div>
                  <div>
                    {'  '}
                    <span className="sc-kw">else if</span> (key[<span className="sc-num">0</span>]) state &lt;={' '}
                    <span className="sc-num">2&apos;d3</span>;
                  </div>
                  <div>
                    <span className="sc-kw">end</span>
                  </div>
                </div>
                <div className="showcase-verify-strip mono">
                  <span>
                    <CheckCircle2 size={13} /> LINT 0 ERROR
                  </span>
                  <span>SELF-TEST 20/20 PASS</span>
                </div>
              </div>
            </article>

            <article className="showcase-bento-card">
              <span className="showcase-feature-kicker mono">03 · 预置案例库</span>
              <h3>内置五大经典案例，零消耗实时上板验证</h3>
              <p>
                内置 5 套零 Token 消耗的数字逻辑工程案例，涵盖状态机、安全逻辑、串行检测与计数器。一键上板即可实时观察门级信号跳变、多通道波形与虚拟外设联动。
              </p>
              <div className="showcase-preset-launcher">
                <div className="showcase-launcher-head">
                  <span>点击任意内置案例直接上板运行</span>
                  <button type="button" className="text-link" onClick={onOpenPresets}>
                    <LayoutGrid size={12} /> 案例库
                  </button>
                </div>
                <div className="showcase-preset-pills">
                  {presets.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className="showcase-preset-pill"
                      onClick={() => onTryPreset(preset)}
                    >
                      <Play size={11} />
                      <span>{preset.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            </article>
          </div>
        </section>

        {/* 3. Open Source & Engineering Team */}
        <section className="showcase-section" aria-labelledby="showcase-team-title">
          <div className="showcase-section-head">
            <h2 id="showcase-team-title">开源仓库与开发团队</h2>
            <p>
              三人小队全链路开源，覆盖浏览器 RTL 仿真内核、多阶段硬件 Agent 闭环与交互工作台。
            </p>
          </div>

          <a
            className="showcase-repo-banner"
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            <div className="showcase-repo-main">
              <div className="showcase-repo-icon">
                <GitHubGlyph size={22} />
              </div>
              <div className="showcase-repo-copy">
                <div className="showcase-repo-title-row">
                  <strong>CyberWei922 / FPGAgent</strong>
                  <span className="showcase-repo-badge mono">
                    <GitBranch size={11} /> main
                  </span>
                </div>
                <span className="showcase-repo-url mono">{REPO_URL}</span>
              </div>
            </div>
            <span className="showcase-repo-cta">
              前往 GitHub 查看源码 <ExternalLink size={14} />
            </span>
          </a>

          <div className="showcase-authors-grid">
            {DEVELOPERS.map((dev) => (
              <a
                key={dev.handle}
                className="showcase-author-card"
                href={dev.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <div className="showcase-author-top">
                  <span className="showcase-author-index mono">
                    {dev.index} · {dev.badge}
                  </span>
                  <ExternalLink size={14} className="showcase-author-ext" />
                </div>

                <div className="showcase-author-identity">
                  <strong className="showcase-author-handle">@{dev.handle}</strong>
                  <span className="showcase-author-focus">{dev.focus}</span>
                </div>

                <p className="showcase-author-summary">{dev.summary}</p>

                <div className="showcase-author-foot mono">
                  <GitHubGlyph size={13} />
                  <span>{dev.displayUrl}</span>
                </div>
              </a>
            ))}
          </div>
        </section>

        {/* 4. Closing CTA Footer */}
        <footer className="showcase-closing">
          <div className="showcase-closing-card">
            <div className="showcase-closing-copy">
              <h2>开始构建你的第一块数字电路</h2>
              <p>
                提供免费云端体验额度与零消耗本地案例，也可在设置中接入 DeepSeek、GLM、通义千问等 OpenAI 兼容模型。
              </p>
            </div>
            <div className="showcase-closing-actions">
              <button
                type="button"
                className="primary-button showcase-cta-primary"
                onClick={hasActiveSession ? onReturnWorkbench : onStartDesigning}
              >
                {hasActiveSession ? '返回当前工作台' : '立即开始设计'}
                <ArrowRight size={15} />
              </button>
              <button
                type="button"
                className="outline-button showcase-cta-secondary"
                onClick={onOpenPresets}
              >
                <LayoutGrid size={14} /> 浏览全部 {presets.length} 个案例
              </button>
            </div>
          </div>

          <div className="showcase-footnote">
            <span>FPGAgent · 2026 Qoder 高校创造力大赛 StudyHack 赛道作品</span>
            <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
              GitHub · CyberWei922/FPGAgent
            </a>
          </div>
        </footer>
      </div>
    </main>
  );
}
