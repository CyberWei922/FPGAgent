import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createAgentRuntime } from './agent';
import { AgentPanel } from './components/AgentPanel';
import { GateCanvas } from './components/GateCanvas';
import { SPEED_INTERVAL_MS, TopBar, type ClockSpeed } from './components/TopBar';
import { VirtualBoard } from './components/VirtualBoard';
import { Waveform } from './components/Waveform';
import { createRtlEngine } from './engine';
import { createBrowserLLMClient, fetchRemainingQuota } from './services/llmClient';
import {
  isLLMError,
  type AgentBlueprint,
  type BoardInputs,
  type HarnessTraceEvent,
  type LintIssue,
  type NetlistGraph,
  type PresetProject,
  type SelfTestResult,
  type SignalSample,
  type TestVectorStep,
} from './types/contracts';

const HISTORY_LEN = 24;
const IDLE_INPUTS: BoardInputs = { rst_n: 1, key: 0, sw: 0 };

const LLM_ERROR_TEXT: Record<string, string> = {
  QUOTA_EXCEEDED: '今日免费次数已用完，可先体验预置案例，或在设置中填入自己的 API Key',
  NOT_CONFIGURED: 'AI 服务尚未配置，可先体验预置案例',
  FORBIDDEN: '请求来源校验失败',
  TIMEOUT: 'AI 响应超时，请稍后再试',
  NETWORK: '网络连接失败，请检查网络',
  UPSTREAM: 'AI 服务暂时不可用，请稍后再试',
  BAD_RESPONSE: 'AI 返回内容格式异常，请重试',
};

export default function App() {
  const boardEngine = useMemo(() => createRtlEngine(), []);
  const runtime = useMemo(() => createAgentRuntime({ llm: createBrowserLLMClient(), engine: createRtlEngine() }), []);

  const [activePresetId, setActivePresetId] = useState<string>();
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
  const [generating, setGenerating] = useState(false);
  const [remainingQuota, setRemainingQuota] = useState<number>();
  const [compiled, setCompiled] = useState(false);

  const inputsRef = useRef(inputs);
  const pendingPresses = useRef({ keys: 0, reset: false });
  const abortRef = useRef<AbortController | null>(null);

  function changeInputs(next: BoardInputs) {
    // A click can begin and end between two clock edges.
    pendingPresses.current.keys |= next.key & ~inputsRef.current.key;
    pendingPresses.current.reset ||= next.rst_n === 0;
    inputsRef.current = next;
    setInputs(next);
  }

  const loadCircuit = useCallback(
    (source: string, testVectors: TestVectorStep[]) => {
      const result = boardEngine.compile(source);
      pendingPresses.current = { keys: 0, reset: false };
      setIssues(result.issues);
      setNetlist(result.netlist);
      setHistory([]);
      setCompiled(result.ok);
      setSelfTest(result.ok && testVectors.length ? boardEngine.runSelfTest(source, testVectors) : undefined);
    },
    [boardEngine],
  );

  const tick = useCallback(() => {
    const current = inputsRef.current;
    const pending = pendingPresses.current;
    pendingPresses.current = { keys: 0, reset: false };
    const { sample, netlist: next } = boardEngine.step({
      ...current,
      key: current.key | pending.keys,
      rst_n: pending.reset ? 0 : current.rst_n,
    });
    setNetlist(next);
    setHistory((h) => [...h.slice(-(HISTORY_LEN - 1)), sample]);
  }, [boardEngine]);

  useEffect(() => {
    if (!compiled || !running || speed === 'step') return;
    const id = setInterval(tick, SPEED_INTERVAL_MS[speed]);
    return () => clearInterval(id);
  }, [compiled, running, speed, tick]);

  useEffect(() => {
    fetchRemainingQuota().then(setRemainingQuota);
  }, []);

  const loadPreset = useCallback(
    (preset: PresetProject) => {
      abortRef.current?.abort();
      setActivePresetId(preset.id);
      setBlueprint(preset.blueprint);
      setCode(preset.verilogCode);
      setVectors(preset.testVectors);
      setTraces([]);
      loadCircuit(preset.verilogCode, preset.testVectors);
    },
    [loadCircuit],
  );

  useEffect(() => {
    if (runtime.presets[0]) loadPreset(runtime.presets[0]);
  }, [runtime, loadPreset]);

  const generate = async (prompt: string) => {
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setGenerating(true);
    setActivePresetId(undefined);
    setTraces([]);
    try {
      const result = await runtime.runHarness(prompt, {
        signal: controller.signal,
        onTrace: (e) => setTraces((t) => [...t, e]),
      });
      setBlueprint(result.blueprint);
      setCode(result.verilogCode);
      setVectors(result.testVectors);
      loadCircuit(result.verilogCode, result.testVectors);
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = isLLMError(error) ? LLM_ERROR_TEXT[error.code] ?? error.message : '生成失败，请重试';
      setTraces((t) => [...t, { stage: 'failed', status: 'fail', title: '生成失败', detail: message, timestamp: Date.now() }]);
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setGenerating(false);
      }
      fetchRemainingQuota().then(setRemainingQuota);
    }
  };

  const latest = history.at(-1);

  return (
    <div className="flex h-full flex-col">
      <TopBar
        presets={runtime.presets}
        activePresetId={activePresetId}
        generating={generating}
        running={running}
        speed={speed}
        remainingQuota={remainingQuota}
        onGenerate={generate}
        onCancel={() => abortRef.current?.abort()}
        onLoadPreset={loadPreset}
        onSpeedChange={setSpeed}
        onToggleRun={() => setRunning((r) => !r)}
        onStep={() => compiled && tick()}
      />
      <main className="grid min-h-0 flex-1 grid-cols-[minmax(280px,1fr)_minmax(0,2fr)_minmax(300px,1fr)]">
        <AgentPanel
          blueprint={blueprint}
          traces={traces}
          issues={issues}
          selfTest={selfTest}
          code={code}
          onCodeChange={setCode}
          onCompile={() => loadCircuit(code, vectors)}
        />
        <section className="flex min-h-0 flex-col">
          <GateCanvas netlist={netlist} />
        </section>
        <aside className="flex min-h-0 flex-col overflow-auto border-l border-slate-800">
          <VirtualBoard inputs={inputs} outputs={latest?.outputs} onInputsChange={changeInputs} />
          <Waveform title="实时波形" samples={history} />
          {selfTest && (
            <Waveform
              title={selfTest.passed ? '自测波形（全部通过）' : '自测波形（红框为首个出错周期）'}
              samples={selfTest.waveform}
              failureCycle={selfTest.firstFailure?.cycle}
            />
          )}
        </aside>
      </main>
    </div>
  );
}
