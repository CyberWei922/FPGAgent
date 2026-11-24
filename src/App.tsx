import { ChevronRight, FileText, LockKeyhole, Radio, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createAgentRuntime } from './agent';
import { AgentPanel } from './components/AgentPanel';
import { ApiSettings } from './components/ApiSettings';
import { GateCanvas } from './components/GateCanvas';
import { ClockControls, PromptComposer, SPEED_INTERVAL_MS, TopBar, type ClockSpeed } from './components/TopBar';
import { VirtualBoard } from './components/VirtualBoard';
import { Waveform } from './components/Waveform';
import { createRtlEngine } from './engine';
import { createBrowserLLMClient, loadByokConfig } from './services/llmClient';
import {
  isLLMError,
  type AgentBlueprint,
  type BoardInputs,
  type HarnessTraceEvent,
  type LintIssue,
  type NetlistGraph,
  type PresetProject,
  type RtlEngine,
  type SelfTestResult,
  type SignalSample,
  type TestVectorStep,
} from './types/contracts';

const IDLE_INPUTS: BoardInputs = { rst_n: 1, key: 0, sw: 0 };
const HISTORY_LIMIT = 48;
const LLM_ERROR_TEXT = {
  QUOTA_EXCEEDED: '今日免费次数已用完。可体验预设演示，或在 API 设置中使用自己的 Key。',
  NOT_CONFIGURED: '模型服务未配置或凭据不可用，请检查 API 设置。',
  FORBIDDEN: '模型服务拒绝了请求。',
  TIMEOUT: '模型响应超时，请重试。',
  NETWORK: '连接失败，请检查网络及接口是否支持浏览器访问。',
  UPSTREAM: '模型服务暂时不可用，请稍后重试。',
  BAD_RESPONSE: '模型服务返回了无法解析的内容。',
  ABORTED: '已停止生成。',
};

const QUICK_PROMPTS = [
  { id: 'traffic-light', prompt: '做一个智能交通灯', Icon: Radio },
  { id: 'password-lock', prompt: '做一个四位密码锁', Icon: LockKeyhole },
];

type Outcome = 'busy' | 'ready' | 'cancelled' | 'failed';

export default function App() {
  const runtime = useMemo(() => createAgentRuntime({ llm: createBrowserLLMClient(), engine: createRtlEngine() }), []);
  const [api, setApi] = useState(loadByokConfig);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [request, setRequest] = useState('');
  const [outcome, setOutcome] = useState<Outcome>('ready');
  const [statusText, setStatusText] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [activePresetId, setActivePresetId] = useState<string>();
  const [rehearsal, setRehearsal] = useState(false);
  const [blueprint, setBlueprint] = useState<AgentBlueprint>();
  const [code, setCode] = useState('');
  const [vectors, setVectors] = useState<TestVectorStep[]>([]);
  const [issues, setIssues] = useState<LintIssue[]>([]);
  const [selfTest, setSelfTest] = useState<SelfTestResult>();
  const [traces, setTraces] = useState<HarnessTraceEvent[]>([]);
  const [netlist, setNetlist] = useState<NetlistGraph>();
  const [history, setHistory] = useState<SignalSample[]>([]);
  const [inputs, setInputs] = useState<BoardInputs>(IDLE_INPUTS);
  const [speed, setSpeed] = useState<ClockSpeed>('realtime');
  const [running, setRunning] = useState(true);
  const [compiled, setCompiled] = useState(false);

  const simulation = useRef<RtlEngine['step'] | null>(null);
  const inputsRef = useRef(IDLE_INPUTS);
  const pendingKeys = useRef<{ pressed: number; inputs: BoardInputs }[]>([]);
  const pendingReset = useRef(false);
  const sampledKeys = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const applied = useRef<{ source: string; title?: string } | undefined>(undefined);

  function changeInputs(next: BoardInputs) {
    if (next.rst_n === 0 && inputsRef.current.rst_n === 1) {
      pendingKeys.current = [];
      pendingReset.current = true;
    }
    const pressed = next.key & ~inputsRef.current.key;
    if (pressed) pendingKeys.current.push({ pressed, inputs: next });
    inputsRef.current = next;
    setInputs(next);
  }

  function resetInputs() {
    pendingKeys.current = [];
    pendingReset.current = false;
    sampledKeys.current = 0;
    inputsRef.current = IDLE_INPUTS;
    setInputs(IDLE_INPUTS);
  }

  function clearCircuit() {
    simulation.current = null;
    applied.current = undefined;
    setCompiled(false);
    setBlueprint(undefined);
    setCode('');
    setVectors([]);
    setIssues([]);
    setSelfTest(undefined);
    setNetlist(undefined);
    setHistory([]);
    resetInputs();
  }

  function loadCircuit(source: string, checks: TestVectorStep[], title?: string, presetId?: string, verified?: SelfTestResult) {
    const engine = createRtlEngine();
    const result = engine.compile(source);
    setIssues(result.issues);
    const verification = result.ok && checks.length ? verified ?? engine.runSelfTest(source, checks) : undefined;
    setSelfTest(verification);
    if (!result.ok || verification?.passed === false) return false;

    engine.reset();
    const initial = engine.step({ ...IDLE_INPUTS, rst_n: 0 });
    simulation.current = (current) => engine.step(current);
    applied.current = { source, title };
    setActivePresetId(presetId);
    resetInputs();
    setHistory([initial.sample]);
    setNetlist(initial.netlist);
    setCompiled(true);
    return true;
  }

  const tick = useCallback(() => {
    if (!simulation.current) return;
    const current = inputsRef.current;
    const pending = pendingKeys.current[0];
    let sampled = current;
    if (pendingReset.current || current.rst_n === 0) {
      sampled = { ...current, key: 0, rst_n: 0 };
      pendingReset.current = false;
    } else if (pending) {
      // Repeated clicks need a sampled release so sequential circuits can detect each rising edge.
      if (sampledKeys.current & pending.pressed) {
        sampled = { ...pending.inputs, key: pending.inputs.key & ~pending.pressed, rst_n: 1 };
      } else {
        sampled = { ...pending.inputs, rst_n: 1 };
        pendingKeys.current.shift();
      }
    }
    sampledKeys.current = sampled.key;
    const next = simulation.current(sampled);
    setNetlist(next.netlist);
    setHistory((samples) => [...samples.slice(-(HISTORY_LIMIT - 1)), next.sample]);
  }, []);

  useEffect(() => {
    if (!compiled || !running || speed === 'step') return;
    const id = window.setInterval(tick, SPEED_INTERVAL_MS[speed]);
    return () => window.clearInterval(id);
  }, [compiled, running, speed, tick]);

  useEffect(() => () => abortRef.current?.abort(), []);

  function newChat() {
    abortRef.current?.abort();
    abortRef.current = null;
    setRequest('');
    setOutcome('ready');
    setStatusText('');
    setTraces([]);
    setActivePresetId(undefined);
    setRehearsal(false);
    setDetailsOpen(false);
    setSpeed('realtime');
    setRunning(true);
    clearCircuit();
  }

  function reportVerificationFailure() {
    setOutcome('failed');
    setStatusText(applied.current ? '验证未通过，板卡仍运行上一个电路。' : '验证未通过，可在蓝图侧栏查看详情。');
    setDetailsOpen(true);
  }

  function compileEditedCode() {
    if (loadCircuit(code, vectors, blueprint?.title, activePresetId)) setOutcome('ready');
    else reportVerificationFailure();
  }

  async function run(prompt: string, preset?: PresetProject) {
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    const previous = applied.current;
    setRequest(prompt);
    setOutcome('busy');
    setStatusText('正在规划电路');
    setTraces([]);
    setDetailsOpen(false);
    setRehearsal(Boolean(preset));
    const active = () => abortRef.current === controller && !controller.signal.aborted;

    function trace(event: HarnessTraceEvent) {
      if (!active()) return;
      setStatusText(event.title);
      setTraces((events) => [...events, event]);
    }

    try {
      if (preset) {
        for (const [stage, title] of [['planning', '正在规划电路'], ['coding', '正在生成 Verilog'], ['simulating', '正在准备仿真']] as const) {
          trace({ stage, status: 'running', title, detail: '预设演示', timestamp: Date.now() });
          await new Promise<void>((resolve) => window.setTimeout(resolve, 320));
          if (!active()) return;
        }
        setBlueprint(preset.blueprint);
        setCode(preset.verilogCode);
        setVectors(preset.testVectors);
        if (!loadCircuit(preset.verilogCode, preset.testVectors, preset.blueprint.title, preset.id)) {
          reportVerificationFailure();
          return;
        }
        trace({ stage: 'done', status: 'pass', title: '演示电路已就绪', detail: '可操作板卡并查看波形。', timestamp: Date.now() });
      } else {
        const context = previous
          ? `请基于当前电路完成这次修改。当前电路：${previous.title ?? '未命名'}\n\`\`\`verilog\n${previous.source}\n\`\`\`\n修改需求：\n${prompt}`
          : prompt;
        const result = await runtime.runHarness(context, { signal: controller.signal, onTrace: trace });
        if (!active()) return;
        setBlueprint(result.blueprint);
        setCode(result.verilogCode);
        setVectors(result.testVectors);
        if (!result.ok) {
          setIssues(result.issues);
          setSelfTest(result.selfTest);
          reportVerificationFailure();
          return;
        }
        if (!loadCircuit(result.verilogCode, result.testVectors, result.blueprint.title, undefined, result.selfTest)) {
          reportVerificationFailure();
          return;
        }
      }
      setOutcome('ready');
      setStatusText(preset ? '演示已就绪' : '电路已就绪');
    } catch (error) {
      if (!active()) return;
      const detail = isLLMError(error) ? LLM_ERROR_TEXT[error.code] : '生成未完成，请重试。';
      setOutcome('failed');
      setStatusText(detail);
      setTraces((events) => [...events, { stage: 'failed', status: 'fail', title: '生成未完成', detail, timestamp: Date.now() }]);
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  function cancel() {
    abortRef.current?.abort();
    abortRef.current = null;
    setOutcome('cancelled');
    setStatusText('已停止生成，可重新发送需求。');
  }

  function stepOnce() {
    setSpeed('step');
    setRunning(false);
    tick();
  }

  function toggleRun() {
    if (speed === 'step') {
      setSpeed('realtime');
      setRunning(true);
    } else {
      setRunning((value) => !value);
    }
  }

  const busy = outcome === 'busy';
  const latest = history.at(-1);
  const lockActive = activePresetId === 'password-lock';
  const status = busy || outcome !== 'ready' ? statusText : compiled && !running ? '仿真已暂停' : compiled ? '仿真运行中' : statusText;

  return (
    <div className="app-shell">
      <TopBar onSettings={() => setSettingsOpen(true)} onNewChat={request ? newChat : undefined} hasCustomApi={Boolean(api)} />
      {settingsOpen && <ApiSettings config={api} onSave={setApi} onClose={() => setSettingsOpen(false)} />}
      {!request ? (
        <main className="home-view">
          <div className="home-content">
            <h1>你想做什么电路？</h1>
            <PromptComposer onSend={(prompt) => void run(prompt)} />
            <section className="quick-prompts" aria-labelledby="quick-prompts-label">
              <h2 id="quick-prompts-label">试试预设演示</h2>
              <div className="quick-grid">
                {QUICK_PROMPTS.map(({ id, prompt, Icon }) => {
                  const preset = runtime.presets.find((item) => item.id === id);
                  return <button key={id} disabled={!preset} onClick={() => void run(prompt, preset)}>
                    <Icon size={17} /><span>{prompt}</span><ChevronRight size={15} />
                  </button>;
                })}
              </div>
            </section>
          </div>
        </main>
      ) : (
        <main className="workbench">
          <div className="request-bar">
            <div className="request-copy"><span>当前需求</span><strong title={request}>{request}</strong>{rehearsal && <span className="demo-label">预设演示</span>}</div>
            <p className={`run-status run-${outcome}`} role="status">{status}</p>
          </div>
          <div className="experiment" data-details={detailsOpen}>
            <nav className="detail-rail" aria-label="电路资料">
              <button aria-expanded={detailsOpen} aria-controls="circuit-details" onClick={() => setDetailsOpen((open) => !open)}>
                <FileText size={18} /><span>蓝图</span><ChevronRight className={detailsOpen ? 'rotate-180' : undefined} size={13} />
              </button>
            </nav>
            {detailsOpen && <aside className="details-pane" id="circuit-details">
              <div className="section-heading"><h2>电路资料</h2><button className="icon-button" aria-label="关闭蓝图" onClick={() => setDetailsOpen(false)}><X size={17} /></button></div>
              <AgentPanel blueprint={blueprint} traces={traces} issues={issues} selfTest={selfTest} code={code} onCodeChange={setCode}
                onCompile={compileEditedCode} canCompile={!busy} />
            </aside>}
            <section className="canvas-pane" aria-label="门级仿真">
              <div className="section-heading canvas-heading">
                <h2>门级仿真</h2>
                <ClockControls speed={speed} running={running} disabled={!compiled} onSpeed={(mode) => { setSpeed(mode); setRunning(true); }} onToggle={toggleRun} onStep={stepOnce} />
              </div>
              <GateCanvas netlist={netlist} pending={busy} />
              <div className="followup"><PromptComposer compact busy={busy} onCancel={cancel} onSend={(prompt) => void run(prompt)} /></div>
            </section>
            <aside className="instruments" aria-label="波形和虚拟板卡">
              <Waveform title="实时波形" samples={history.slice(-10)} ledFocus={lockActive} />
              <section className="instrument-section">
                <div className="section-heading"><h2>虚拟板卡</h2>{latest && <span className="instrument-meta">CLK ↑ {latest.cycle}</span>}</div>
                {lockActive && <p className="field-help mb-2">用 SW3–SW0 依次输入 1、2、3、4，每位按 KEY0 提交。KEY1 重新上锁。</p>}
                <VirtualBoard inputs={inputs} outputs={latest?.outputs} onInputsChange={changeInputs} disabled={!compiled} lockDemo={lockActive} />
              </section>
              {selfTest && <details className="self-test-wave"><summary>自测波形 <span>{selfTest.passedChecks}/{selfTest.totalChecks}</span></summary>
                <Waveform title="自测采样" samples={selfTest.waveform} failureCycle={selfTest.firstUnstableCycle ?? selfTest.firstFailure?.cycle} ledFocus={selfTest.firstFailure?.signal === 'led' || lockActive} />
              </details>}
            </aside>
          </div>
        </main>
      )}
    </div>
  );
}
