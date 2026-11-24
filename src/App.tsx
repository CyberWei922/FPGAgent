import { ChevronRight, FileText, LockKeyhole, Radio, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createAgentRuntime } from './agent';
import { AgentPanel } from './components/AgentPanel';
import { ApiSettings } from './components/ApiSettings';
import { GateCanvas } from './components/GateCanvas';
import { LOCK_BLUEPRINT, QUICK_PROMPTS, stepLockPreview } from './components/presetPreview';
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

type DemoKind = typeof QUICK_PROMPTS[number]['kind'];
type Outcome = 'busy' | 'ready' | 'cancelled' | 'failed';

export default function App() {
  const boardEngine = useMemo(() => createRtlEngine(), []);
  const runtime = useMemo(() => createAgentRuntime({ llm: createBrowserLLMClient(), engine: createRtlEngine() }), []);
  const [api, setApi] = useState(loadByokConfig);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [request, setRequest] = useState('');
  const [outcome, setOutcome] = useState<Outcome>('ready');
  const [statusText, setStatusText] = useState('');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [demo, setDemo] = useState<DemoKind>();
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
  const pendingPresses = useRef({ keys: 0, reset: false });
  const abortRef = useRef<AbortController | null>(null);
  const appliedCode = useRef('');

  function changeInputs(next: BoardInputs) {
    // Retain momentary pulses between sampled clock edges.
    pendingPresses.current.keys |= next.key & ~inputsRef.current.key;
    pendingPresses.current.reset ||= next.rst_n === 0;
    inputsRef.current = next;
    setInputs(next);
  }

  function clearCircuit() {
    simulation.current = null;
    appliedCode.current = '';
    setCompiled(false);
    setBlueprint(undefined);
    setCode('');
    setVectors([]);
    setIssues([]);
    setSelfTest(undefined);
    setNetlist(undefined);
    setHistory([]);
    changeInputs(IDLE_INPUTS);
    pendingPresses.current = { keys: 0, reset: false };
  }

  function startSimulation(step: RtlEngine['step']) {
    const initial = step({ ...IDLE_INPUTS, rst_n: 0 });
    simulation.current = step;
    pendingPresses.current = { keys: 0, reset: false };
    inputsRef.current = IDLE_INPUTS;
    setInputs(IDLE_INPUTS);
    setHistory([initial.sample]);
    setNetlist(initial.netlist);
    setCompiled(true);
  }

  function loadCircuit(source: string, checks: TestVectorStep[]) {
    const result = boardEngine.compile(source);
    setIssues(result.issues);
    if (result.ok) {
      boardEngine.reset();
      startSimulation((current) => boardEngine.step(current));
      setSelfTest(checks.length ? boardEngine.runSelfTest(source, checks) : undefined);
      appliedCode.current = source;
    } else {
      simulation.current = null;
      setCompiled(false);
      setHistory([]);
      setNetlist(result.netlist);
      setSelfTest(undefined);
      appliedCode.current = '';
    }
    return result.ok;
  }

  const tick = useCallback(() => {
    if (!simulation.current) return;
    const current = inputsRef.current;
    const pending = pendingPresses.current;
    pendingPresses.current = { keys: 0, reset: false };
    const next = simulation.current({ ...current, key: current.key | pending.keys, rst_n: pending.reset ? 0 : current.rst_n });
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
    setDemo(undefined);
    setRehearsal(false);
    setDetailsOpen(false);
    setSpeed('realtime');
    setRunning(true);
    clearCircuit();
  }

  async function run(prompt: string, preset?: DemoKind) {
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    const priorCode = appliedCode.current;
    const priorTitle = blueprint?.title;
    setRequest(prompt);
    setOutcome('busy');
    setStatusText('正在规划电路');
    setTraces([]);
    setDetailsOpen(false);
    let isRehearsal = Boolean(preset);
    setRehearsal(isRehearsal);
    if (preset) setDemo(preset);
    const active = () => abortRef.current === controller && !controller.signal.aborted;

    function trace(event: HarnessTraceEvent) {
      if (!active()) return;
      isRehearsal ||= event.detail.startsWith('Mock：');
      if (isRehearsal) setRehearsal(true);
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
        const match = runtime.presets.find((item) => preset === 'traffic'
          ? /traffic|交通灯/i.test(`${item.id} ${item.name}`)
          : /lock|密码锁/i.test(`${item.id} ${item.name}`));
        if (match) {
          setBlueprint(match.blueprint);
          setCode(match.verilogCode);
          setVectors(match.testVectors);
          if (!loadCircuit(match.verilogCode, match.testVectors)) throw new Error('preset compilation failed');
        } else if (preset === 'lock') {
          let previous: SignalSample | undefined;
          clearCircuit();
          setBlueprint(LOCK_BLUEPRINT);
          startSimulation((current) => {
            const result = stepLockPreview(current, previous);
            previous = result.sample;
            return result;
          });
        } else {
          throw new Error('traffic preset unavailable');
        }
        trace({ stage: 'done', status: 'pass', title: '演示电路已就绪', detail: '可操作板卡并查看波形。', timestamp: Date.now() });
      } else {
        const context = priorCode
          ? `请基于当前电路完成这次修改。当前电路：${priorTitle ?? '未命名'}\n\`\`\`verilog\n${priorCode}\n\`\`\`\n修改需求：\n${prompt}`
          : priorTitle ? `请基于当前演示电路「${priorTitle}」完成修改：\n${prompt}` : prompt;
        const result = await runtime.runHarness(context, { signal: controller.signal, onTrace: trace });
        if (!active()) return;
        setDemo(undefined);
        setBlueprint(result.blueprint);
        setCode(result.verilogCode);
        setVectors(result.testVectors);
        const ok = loadCircuit(result.verilogCode, result.testVectors);
        if (result.issues.length) setIssues(result.issues);
        if (result.selfTest) setSelfTest(result.selfTest);
        if (!result.ok || !ok) {
          setOutcome('failed');
          setStatusText('验证未通过，可在蓝图侧栏查看详情。');
          return;
        }
      }
      setOutcome('ready');
      setStatusText(isRehearsal ? '演示已就绪' : '电路已就绪');
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
  const lockPreview = demo === 'lock' && !code;
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
                {QUICK_PROMPTS.map(({ kind, prompt }) => (
                  <button key={kind} onClick={() => void run(prompt, kind)}>
                    {kind === 'traffic' ? <Radio size={17} /> : <LockKeyhole size={17} />}
                    <span>{prompt}</span><ChevronRight size={15} />
                  </button>
                ))}
              </div>
            </section>
          </div>
        </main>
      ) : (
        <main className="workbench">
          <div className="request-bar">
            <div className="request-copy"><span>当前需求</span><strong title={request}>{request}</strong>{rehearsal && <span className="demo-label">{demo ? '预设演示' : '模拟生成'}</span>}</div>
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
                onCompile={() => loadCircuit(code, vectors)} canCompile={!busy && !lockPreview} />
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
              <Waveform title="实时波形" samples={history.slice(-10)} ledFocus={demo === 'lock'} />
              <section className="instrument-section">
                <div className="section-heading"><h2>虚拟板卡</h2>{latest && <span className="instrument-meta">CLK ↑ {latest.cycle}</span>}</div>
                <VirtualBoard inputs={inputs} outputs={latest?.outputs} onInputsChange={changeInputs} disabled={!compiled} lockDemo={demo === 'lock'} />
              </section>
              {selfTest && <details className="self-test-wave"><summary>自测波形 <span>{selfTest.passedChecks}/{selfTest.totalChecks}</span></summary>
                <Waveform title="自测采样" samples={selfTest.waveform} failureCycle={selfTest.firstFailure?.cycle} ledFocus={demo === 'lock'} />
              </details>}
            </aside>
          </div>
        </main>
      )}
    </div>
  );
}
