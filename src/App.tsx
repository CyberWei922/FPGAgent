import {
  Check,
  ChevronRight,
  Copy,
  Download,
  LayoutGrid,
  LockKeyhole,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Radio,
  SlidersHorizontal,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createAgentRuntime } from './agent';
import { ApiSettings } from './components/ApiSettings';
import { ChatPane, type ChatTurn } from './components/ChatPane';
import { GateCanvas } from './components/GateCanvas';
import { NavRail, type RailTab } from './components/NavRail';
import { BugClinicPanel, HistoryPanel, PresetsPanel } from './components/SidePanels';
import { ClockControls, PromptComposer, SPEED_INTERVAL_MS, type ClockSpeed } from './components/TopBar';
import { VirtualBoard } from './components/VirtualBoard';
import { Waveform } from './components/Waveform';
import { BlueprintView, VerifyView, VerilogView } from './components/WorkbenchViews';
import { createRtlEngine } from './engine';
import {
  buildFallbackTestbench,
  deriveVerilogFilename,
  downloadTextFile,
} from './services/exportVerilog';
import {
  createBrowserLLMClient,
  fetchRemainingQuota,
  getProviderPreset,
  getSuggestedModelOptions,
  loadAppPreferences,
  loadByokConfig,
  saveAppPreferences,
  saveByokConfig,
  type AppPreferences,
  type ByokConfig,
} from './services/llmClient';
import {
  clearHistoryEntries,
  deleteHistoryEntry,
  loadHistoryEntries,
  saveHistoryEntry,
  type HistoryEntry,
} from './services/sessionHistory';
import {
  applyThemePreferences,
  loadThemePreferences,
  saveThemePreferences,
  subscribeSystemTheme,
  type ThemePreferences,
} from './services/theme';
import {
  isLLMError,
  type AgentBlueprint,
  type BoardInputs,
  type BugClinicCase,
  type HarnessTraceEvent,
  type LintIssue,
  type LLMErrorCode,
  type LLMModelOption,
  type NetlistGraph,
  type PresetProject,
  type RtlEngine,
  type SelfTestResult,
  type SignalSample,
  type TestVectorStep,
} from './types/contracts';

const IDLE_INPUTS: BoardInputs = { rst_n: 1, key: 0, sw: 0 };
const HISTORY_LIMIT = 48;

const LLM_ERROR_TEXT: Record<LLMErrorCode, string> = {
  QUOTA_EXCEEDED: '今日免费次数已用完。可体验预置案例，或在设置中切换 DeepSeek / GLM / 通义千问等自有 Key。',
  NOT_CONFIGURED: '模型服务尚未配置或 Key 鉴权失败，请点击下方打开设置检查 API 配置。',
  FORBIDDEN: '模型服务拒绝了请求，请检查站点权限或切换自定义 API。',
  TIMEOUT: '模型响应超时，请稍后重试或切换更快的模型。',
  NETWORK: '连接失败，请检查网络或确认所选接口支持浏览器跨域访问。',
  UPSTREAM: '模型服务暂时不可用，请稍后重试。',
  BAD_RESPONSE: '模型返回了无法解析的内容，建议重试或切换模型。',
  ABORTED: '已停止本轮生成。',
};

const QUICK_PROMPTS = [
  { id: 'traffic-light', prompt: '做一个智能交通灯', desc: '红绿黄倒计时 + KEY0 紧急全红', Icon: Radio },
  { id: 'password-lock', prompt: '做一个四位密码锁', desc: 'SW 拨码输入 + KEY0 提交开锁', Icon: LockKeyhole },
];

type WorkbenchTab = 'canvas' | 'blueprint' | 'verilog' | 'verify';
type Outcome = 'busy' | 'ready' | 'cancelled' | 'failed';

function nextId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export default function App() {
  const engineFactory = useMemo(() => createRtlEngine, []);
  const runtime = useMemo(
    () => createAgentRuntime({ llm: createBrowserLLMClient(), engine: engineFactory() }),
    [engineFactory],
  );

  // Settings, Theme & Preferences
  const [api, setApi] = useState<ByokConfig | null>(loadByokConfig);
  const [prefs, setPrefs] = useState<AppPreferences>(loadAppPreferences);
  const [theme, setTheme] = useState<ThemePreferences>(loadThemePreferences);
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>(() =>
    applyThemePreferences(loadThemePreferences()),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<'api' | 'appearance'>('api');
  const [remainingQuota, setRemainingQuota] = useState<number | undefined>();

  // Navigation & Layout
  const [railTab, setRailTab] = useState<RailTab>('chat');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [wbTab, setWbTab] = useState<WorkbenchTab>('canvas');

  // Chat & Session State
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [outcome, setOutcome] = useState<Outcome>('ready');
  const [version, setVersion] = useState(0);
  const [activePresetId, setActivePresetId] = useState<string>();
  const [blueprint, setBlueprint] = useState<AgentBlueprint>();
  const [code, setCode] = useState('');
  const [vectors, setVectors] = useState<TestVectorStep[]>([]);
  const [issues, setIssues] = useState<LintIssue[]>([]);
  const [selfTest, setSelfTest] = useState<SelfTestResult>();
  const [traces, setTraces] = useState<HarnessTraceEvent[]>([]);
  const [highlightLine, setHighlightLine] = useState<number>();
  const [copiedHeader, setCopiedHeader] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>(loadHistoryEntries);

  // Bug Clinic State
  const [activeBug, setActiveBug] = useState<BugClinicCase | null>(null);
  const [hintLevel, setHintLevel] = useState<0 | 1 | 2 | 3>(0);
  const [injectingBug, setInjectingBug] = useState(false);
  const cleanBeforeBug = useRef<{ code: string; vectors: TestVectorStep[]; blueprint?: AgentBlueprint; presetId?: string } | null>(null);

  // Simulation State
  const [netlist, setNetlist] = useState<NetlistGraph>();
  const [history, setHistory] = useState<SignalSample[]>([]);
  const [inputs, setInputs] = useState<BoardInputs>(IDLE_INPUTS);
  const [speed, setSpeed] = useState<ClockSpeed>(() => loadAppPreferences().defaultClockSpeed);
  const [running, setRunning] = useState(true);
  const [compiled, setCompiled] = useState(false);

  const simulation = useRef<RtlEngine['step'] | null>(null);
  const inputsRef = useRef(IDLE_INPUTS);
  const pendingKeys = useRef<{ pressed: number; inputs: BoardInputs }[]>([]);
  const pendingReset = useRef(false);
  const sampledKeys = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const applied = useRef<{ source: string; title?: string; version: number } | undefined>(undefined);

  // Apply & persist theme
  const handleThemeChange = useCallback((next: ThemePreferences) => {
    setTheme(next);
    saveThemePreferences(next);
    setResolvedTheme(applyThemePreferences(next));
  }, []);

  useEffect(() => {
    if (theme.mode !== 'system') return;
    return subscribeSystemTheme(() => {
      setResolvedTheme(applyThemePreferences(theme));
    });
  }, [theme]);

  useEffect(() => {
    if (api) return;
    let active = true;
    void fetchRemainingQuota().then((quota) => {
      if (active && quota !== undefined) setRemainingQuota(quota);
    });
    return () => { active = false; };
  }, [api]);

  const toggleLightDark = useCallback(() => {
    const nextMode = resolvedTheme === 'dark' ? 'light' : 'dark';
    handleThemeChange({ ...theme, mode: nextMode });
  }, [resolvedTheme, theme, handleThemeChange]);

  function openSettings(section: 'api' | 'appearance' = 'api') {
    setSettingsSection(section);
    setSettingsOpen(true);
  }

  // Model selector state derived from BYOK config
  const availableModels: LLMModelOption[] = useMemo(() => {
    if (!api) return [{ id: 'site-default', label: '站点默认' }];
    const base = api.cachedModels?.length
      ? api.cachedModels
      : getSuggestedModelOptions(api.providerId, api.model);
    if (!base.some((m) => m.id === api.model)) {
      return [{ id: api.model }, ...base];
    }
    return base;
  }, [api]);

  const selectedModel = api ? api.model : 'site-default';
  const providerLabel = api
    ? getProviderPreset(api.providerId)?.name ?? '自定义 API'
    : '站点默认';

  function handleSelectModel(modelId: string) {
    if (!api || modelId === api.model) return;
    const next: ByokConfig = { ...api, model: modelId };
    setApi(next);
    try {
      saveByokConfig(next);
    } catch {
      // Ignore storage errors.
    }
  }

  function handleToggleWebResearch() {
    const next = { ...prefs, enableWebResearch: !prefs.enableWebResearch };
    setPrefs(next);
    saveAppPreferences(next);
  }

  // Board inputs & simulation loop
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
    cleanBeforeBug.current = null;
    setCompiled(false);
    setBlueprint(undefined);
    setCode('');
    setVectors([]);
    setIssues([]);
    setSelfTest(undefined);
    setNetlist(undefined);
    setHistory([]);
    setActiveBug(null);
    setHintLevel(0);
    setHighlightLine(undefined);
    resetInputs();
  }

  function loadCircuit(
    source: string,
    checks: TestVectorStep[],
    title?: string,
    presetId?: string,
    verified?: SelfTestResult,
    options: { allowFailedSelfTest?: boolean; nextVersion?: number } = {},
  ) {
    const engine = engineFactory();
    const result = engine.compile(source);
    setIssues(result.issues);
    const verification = result.ok && checks.length ? verified ?? engine.runSelfTest(source, checks) : undefined;
    setSelfTest(verification);

    if (!result.ok) return { ok: false, verification };
    if (verification?.passed === false && !options.allowFailedSelfTest) {
      return { ok: false, verification };
    }

    engine.reset();
    const initial = engine.step({ ...IDLE_INPUTS, rst_n: 0 });
    simulation.current = (current) => engine.step(current);
    const ver = options.nextVersion ?? Math.max(1, version);
    applied.current = { source, title, version: ver };
    setActivePresetId(presetId);
    resetInputs();
    setHistory([initial.sample]);
    setNetlist(initial.netlist);
    setCompiled(true);
    return { ok: true, verification };
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
    setTurns([]);
    setOutcome('ready');
    setTraces([]);
    setVersion(0);
    setActivePresetId(undefined);
    setRailTab('chat');
    setWbTab('canvas');
    setSidebarCollapsed(false);
    setSpeed(prefs.defaultClockSpeed);
    setRunning(true);
    clearCircuit();
  }

  function updateAssistantTurn(turnId: string, updater: (prev: ChatTurn) => ChatTurn) {
    setTurns((prev) => prev.map((t) => (t.id === turnId ? updater(t) : t)));
  }

  function compileEditedCode() {
    const { ok, verification } = loadCircuit(code, vectors, blueprint?.title, activePresetId, undefined, {
      allowFailedSelfTest: Boolean(activeBug),
      nextVersion: Math.max(1, version),
    });
    if (ok) {
      setOutcome('ready');
      if (activeBug && verification?.passed) {
        setHighlightLine(undefined);
      }
    } else {
      setOutcome('failed');
      setWbTab('verify');
    }
  }

  async function run(prompt: string, preset?: PresetProject) {
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;

    const previous = applied.current;
    const nextVer = (previous?.version ?? 0) + 1;
    const userTurnId = nextId('user');
    const aiTurnId = nextId('ai');

    setRailTab('chat');
    setSidebarCollapsed(false);
    setActiveBug(null);
    setHintLevel(0);
    setHighlightLine(undefined);
    setOutcome('busy');
    setTraces([]);

    setTurns((prev) => [
      ...prev,
      { id: userTurnId, role: 'user', text: prompt },
      {
        id: aiTurnId,
        role: 'assistant',
        text: preset ? `正在载入并验证「${preset.name}」…` : '正在规划电路蓝图并生成可综合 Verilog…',
        status: 'running',
        traces: [],
        version: nextVer,
        isPreset: Boolean(preset),
      },
    ]);

    const active = () => abortRef.current === controller && !controller.signal.aborted;

    function pushTrace(event: HarnessTraceEvent) {
      if (!active()) return;
      setTraces((events) => [...events, event]);
      updateAssistantTurn(aiTurnId, (t) => ({
        ...t,
        traces: [...(t.traces ?? []), event],
      }));
    }

    try {
      if (preset) {
        const demoSteps: Array<[HarnessTraceEvent['stage'], string, string, string[]?]> = [
          ['planning', '蓝图已规划', preset.blueprint.summary],
          ['coding', 'Verilog 源码已生成', `顶层模块与虚拟板卡端口已对齐`],
          ['linting', 'Lint 静态体检通过', '0 错误 · 0 锁存器警告'],
          [
            'simulating',
            '浏览器确定性自测中',
            `执行 ${preset.testVectors.length} 拍测试向量`,
            preset.testVectors
              .filter((v) => v.note)
              .slice(0, 3)
              .map((v) => `第 ${v.cycle} 拍 · ${v.note}`),
          ],
        ];

        for (const [stage, title, detail, checkpoints] of demoSteps) {
          pushTrace({
            stage,
            status: 'running',
            title,
            detail,
            timestamp: Date.now(),
            meta: checkpoints ? { checkpoints } : undefined,
          });
          await new Promise<void>((resolve) => window.setTimeout(resolve, 260));
          if (!active()) return;
        }

        setBlueprint(preset.blueprint);
        setCode(preset.verilogCode);
        setVectors(preset.testVectors);

        const { ok, verification } = loadCircuit(
          preset.verilogCode,
          preset.testVectors,
          preset.blueprint.title,
          preset.id,
          undefined,
          { nextVersion: nextVer },
        );

        if (!ok) {
          setOutcome('failed');
          updateAssistantTurn(aiTurnId, (t) => ({
            ...t,
            status: 'failed',
            text: '预设案例验证未通过，可在右侧「自测」页签查看详情。',
          }));
          setWbTab('verify');
          return;
        }

        const filename = deriveVerilogFilename(preset.verilogCode, preset.id);
        setVersion(nextVer);
        setOutcome('ready');
        setWbTab('canvas');
        pushTrace({
          stage: 'done',
          status: 'pass',
          title: '电路已上板仿真',
          detail: `全部 ${verification?.totalChecks ?? preset.testVectors.length} 项断言通过`,
          timestamp: Date.now(),
        });

        updateAssistantTurn(aiTurnId, (t) => ({
          ...t,
          status: 'done',
          text: `${preset.blueprint.summary} 右侧已载入 V${nextVer} 门级原理图与虚拟板卡，可直接点击按键或拨码体验。`,
          filename,
          code: preset.verilogCode,
          passedChecks: verification?.passedChecks,
          totalChecks: verification?.totalChecks,
        }));

        const saved = saveHistoryEntry({
          id: nextId('hist'),
          title: preset.blueprint.title,
          prompt,
          filename,
          version: nextVer,
          code: preset.verilogCode,
          vectors: preset.testVectors,
          blueprint: preset.blueprint,
          presetId: preset.id,
          passedChecks: verification?.passedChecks,
          totalChecks: verification?.totalChecks,
          timestamp: Date.now(),
        });
        setHistoryEntries(saved);
      } else {
        const contextPrompt = previous
          ? `请基于当前电路完成这次修改。当前电路：${previous.title ?? '未命名'}\n\`\`\`verilog\n${previous.source}\n\`\`\`\n修改需求：\n${prompt}`
          : prompt;

        const result = await runtime.runHarness(contextPrompt, {
          signal: controller.signal,
          onTrace: pushTrace,
          model: api ? selectedModel : undefined,
          enableWebResearch: prefs.enableWebResearch,
          previousContext: previous
            ? {
                blueprint,
                verilogCode: previous.source,
                testVectors: vectors,
              }
            : undefined,
        });

        if (!active()) return;
        if (result.remainingQuota !== undefined) setRemainingQuota(result.remainingQuota);

        setBlueprint(result.blueprint);
        setCode(result.verilogCode);
        setVectors(result.testVectors);

        if (!result.ok) {
          setIssues(result.issues);
          setSelfTest(result.selfTest);
          setOutcome('failed');
          updateAssistantTurn(aiTurnId, (t) => ({
            ...t,
            status: 'failed',
            text: previous
              ? '新候选验证未通过，右侧板卡仍保持上一版本运行。可在「自测」或「Verilog」页签排查。'
              : '生成的候选代码未通过编译或自测，可在右侧「自测」页签查看具体失配拍与 Lint 提示。',
            passedChecks: result.selfTest?.passedChecks,
            totalChecks: result.selfTest?.totalChecks,
            modelUsed: result.modelUsed ?? (api ? selectedModel : undefined),
            references: result.references,
          }));
          setWbTab('verify');
          return;
        }

        const { ok, verification } = loadCircuit(
          result.verilogCode,
          result.testVectors,
          result.blueprint.title,
          undefined,
          result.selfTest,
          { nextVersion: nextVer },
        );

        if (!ok) {
          setOutcome('failed');
          updateAssistantTurn(aiTurnId, (t) => ({
            ...t,
            status: 'failed',
            text: '上板验证未通过，请在右侧「自测」页签查看原因。',
          }));
          setWbTab('verify');
          return;
        }

        const filename = deriveVerilogFilename(
          result.verilogCode,
          result.blueprint.title,
          result.suggestedFilename,
        );
        const usedModel = result.modelUsed ?? (api ? selectedModel : undefined);
        setVersion(nextVer);
        setOutcome('ready');
        setWbTab('canvas');

        updateAssistantTurn(aiTurnId, (t) => ({
          ...t,
          status: 'done',
          text:
            result.assistantSummary ??
            `已完成「${result.blueprint.title}」并全部通过自测，右侧已刷新为 V${nextVer} 仿真视图。`,
          filename,
          code: result.verilogCode,
          passedChecks: verification?.passedChecks,
          totalChecks: verification?.totalChecks,
          modelUsed: usedModel,
          references: result.references,
        }));

        const saved = saveHistoryEntry({
          id: nextId('hist'),
          title: result.blueprint.title,
          prompt,
          filename,
          version: nextVer,
          code: result.verilogCode,
          vectors: result.testVectors,
          blueprint: result.blueprint,
          passedChecks: verification?.passedChecks,
          totalChecks: verification?.totalChecks,
          modelUsed: usedModel,
          timestamp: Date.now(),
        });
        setHistoryEntries(saved);
      }
    } catch (error) {
      if (!active()) return;
      const errCode = isLLMError(error) ? error.code : undefined;
      const detail = errCode ? LLM_ERROR_TEXT[errCode] : '生成未完成，请重试。';
      setOutcome('failed');
      pushTrace({ stage: 'failed', status: 'fail', title: '执行失败', detail, timestamp: Date.now() });
      updateAssistantTurn(aiTurnId, (t) => ({
        ...t,
        status: 'failed',
        text: detail,
        errorCode: errCode,
      }));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  function cancel() {
    abortRef.current?.abort();
    abortRef.current = null;
    setOutcome('cancelled');
    setTurns((prev) =>
      prev.map((t) =>
        t.status === 'running' ? { ...t, status: 'cancelled', text: '已停止本轮生成，可继续输入新需求。' } : t,
      ),
    );
  }

  // Bug Clinic Actions
  function injectPresetBug(bug: BugClinicCase, sourcePreset?: PresetProject) {
    const targetVectors = sourcePreset?.testVectors ?? vectors;
    const targetBlueprint = sourcePreset?.blueprint ?? blueprint;
    const targetCleanCode = sourcePreset?.verilogCode ?? code;
    const targetPresetId = sourcePreset?.id ?? activePresetId;

    if (!cleanBeforeBug.current && targetCleanCode) {
      cleanBeforeBug.current = {
        code: targetCleanCode,
        vectors: targetVectors,
        blueprint: targetBlueprint,
        presetId: targetPresetId,
      };
    }

    setBlueprint(targetBlueprint);
    setVectors(targetVectors);
    setCode(bug.buggyCode);
    setActiveBug(bug);
    setHintLevel(0);
    setHighlightLine(bug.diagnosis.highlightLine);
    setRailTab('clinic');
    setSidebarCollapsed(false);

    const { ok } = loadCircuit(bug.buggyCode, targetVectors, targetBlueprint?.title, targetPresetId, undefined, {
      allowFailedSelfTest: true,
      nextVersion: Math.max(1, version),
    });
    if (!ok) setWbTab('verify');
    else setWbTab('canvas');
  }

  async function injectAiBug() {
    if (!code || injectingBug) return;
    setInjectingBug(true);
    try {
      const bug = await runtime.injectBug(code, { model: api ? selectedModel : undefined });
      injectPresetBug(bug);
    } catch (error) {
      const detail = isLLMError(error) ? LLM_ERROR_TEXT[error.code] : 'AI 故障注入失败，可先尝试下方的内置故障关卡。';
      setTurns((prev) => [
        ...prev,
        {
          id: nextId('ai'),
          role: 'assistant',
          status: 'failed',
          text: detail,
          errorCode: isLLMError(error) ? error.code : undefined,
        },
      ]);
      setRailTab('chat');
    } finally {
      setInjectingBug(false);
    }
  }

  function applyBugFix() {
    if (!activeBug) return;
    const fixedCode = activeBug.diagnosis.level3PatchCode || cleanBeforeBug.current?.code || code;
    setCode(fixedCode);
    setHighlightLine(undefined);
    const { ok } = loadCircuit(fixedCode, vectors, blueprint?.title, activePresetId, undefined, {
      allowFailedSelfTest: true,
      nextVersion: Math.max(1, version),
    });
    if (ok) setOutcome('ready');
  }

  function exitBugClinic() {
    const backup = cleanBeforeBug.current;
    setActiveBug(null);
    setHintLevel(0);
    setHighlightLine(undefined);
    if (backup) {
      setBlueprint(backup.blueprint);
      setCode(backup.code);
      setVectors(backup.vectors);
      loadCircuit(backup.code, backup.vectors, backup.blueprint?.title, backup.presetId, undefined, {
        nextVersion: Math.max(1, version),
      });
    }
    cleanBeforeBug.current = null;
  }

  function restoreHistoryEntry(entry: HistoryEntry) {
    setActiveBug(null);
    setHintLevel(0);
    setHighlightLine(undefined);
    setBlueprint(entry.blueprint);
    setCode(entry.code);
    setVectors(entry.vectors);
    setVersion(entry.version);
    loadCircuit(entry.code, entry.vectors, entry.blueprint.title, entry.presetId, undefined, {
      nextVersion: entry.version,
    });
    setTurns([
      { id: nextId('user'), role: 'user', text: entry.prompt },
      {
        id: nextId('ai'),
        role: 'assistant',
        status: 'done',
        text: `已从本地历史恢复「${entry.title}」（V${entry.version}），右侧板卡与门级图已同步上板。`,
        version: entry.version,
        filename: entry.filename,
        code: entry.code,
        passedChecks: entry.passedChecks,
        totalChecks: entry.totalChecks,
        modelUsed: entry.modelUsed,
      },
    ]);
    setRailTab('chat');
    setWbTab('canvas');
  }

  // Export & Copy helpers
  const activeFilename = deriveVerilogFilename(code, activePresetId ?? blueprint?.title);

  async function copyHeaderCode() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopiedHeader(true);
      window.setTimeout(() => setCopiedHeader(false), 1600);
    } catch {
      // Ignore clipboard failures.
    }
  }

  function handleExportVerilog(filename = activeFilename, source = code) {
    if (!source) return;
    downloadTextFile(filename, source);
  }

  function handleExportTestbench() {
    if (!code) return;
    const engine = engineFactory();
    const tb = engine.exportTestbench
      ? engine.exportTestbench(code, vectors)
      : buildFallbackTestbench(code, vectors);
    downloadTextFile('tb_top.v', tb);
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

  function jumpToVerilogLine(line?: number) {
    setHighlightLine(line);
    setWbTab('verilog');
  }

  const busy = outcome === 'busy';
  const latest = history.at(-1);
  const lockActive = activePresetId === 'password-lock';
  const activePreset = runtime.presets.find((item) => item.id === activePresetId);
  const hasSession = turns.length > 0 || compiled || railTab !== 'chat';

  const statusBadge = useMemo(() => {
    if (!latest) return undefined;
    if (lockActive) return latest.outputs.led & 1 ? '已开锁' : '已锁定';
    const traffic = latest.outputs.traffic;
    if (traffic & 4) return '红灯亮';
    if (traffic & 2) return '黄灯亮';
    if (traffic & 1) return '绿灯亮';
    if (latest.outputs.led) return `LED 0x${latest.outputs.led.toString(16).toUpperCase().padStart(2, '0')}`;
    return running ? '仿真中' : '已暂停';
  }, [latest, lockActive, running]);

  const leftHeaderTitle =
    railTab === 'presets'
      ? '预置电路案例'
      : railTab === 'clinic'
        ? 'RTL 故障诊所'
        : railTab === 'history'
          ? '本地版本历史'
          : blueprint?.title ?? '新电路对话';

  const quotaOrModelPill = api
    ? `${providerLabel} · ${api.model}`
    : remainingQuota !== undefined
      ? `默认额度 ${remainingQuota}/20`
      : '站点默认';

  const wbTitleVersion = applied.current?.version ?? version;

  return (
    <div className="app-frame" data-has-session={hasSession} data-sidebar-collapsed={sidebarCollapsed}>
      <NavRail
        activeTab={railTab}
        onSelectTab={(tab) => {
          setRailTab(tab);
          setSidebarCollapsed(false);
        }}
        onNewChat={newChat}
        onOpenSettings={() => openSettings('api')}
        resolvedTheme={resolvedTheme}
        onToggleTheme={toggleLightDark}
        hasCustomApi={Boolean(api)}
        hasActiveBug={Boolean(activeBug)}
      />

      {settingsOpen && (
        <ApiSettings
          config={api}
          theme={theme}
          prefs={prefs}
          remainingQuota={remainingQuota}
          initialSection={settingsSection}
          onSaveApi={setApi}
          onThemeChange={handleThemeChange}
          onPrefsChange={(next) => {
            setPrefs(next);
            if (!compiled) setSpeed(next.defaultClockSpeed);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {!hasSession ? (
        <main className="home-stage">
          <header className="home-topbar">
            <div className="home-brand">
              <strong>FPGAgent</strong>
              <span>可验证浏览器虚拟 FPGA 实验室</span>
            </div>
            <div className="home-topbar-actions">
              <button
                type="button"
                className="status-pill-btn"
                onClick={() => openSettings('api')}
                title="管理模型与 API 配置"
              >
                <span className="status-dot" />
                <span>{quotaOrModelPill}</span>
              </button>
              <button
                type="button"
                className="outline-button compact-btn"
                onClick={() => openSettings('appearance')}
                title="切换浅色/深色与主题色"
              >
                <Palette size={14} /> 外观主题
              </button>
              <button
                type="button"
                className="outline-button compact-btn"
                onClick={() => openSettings('api')}
              >
                <SlidersHorizontal size={14} /> 设置
              </button>
            </div>
          </header>

          <div className="home-center">
            <div className="home-hero">
              <h1>你想做什么电路？</h1>
              <p className="home-subtitle">
                输入自然语言需求，自动规划蓝图、生成可综合 Verilog、在浏览器里自测验证并点亮门级仿真与虚拟板卡。
              </p>

              <PromptComposer
                onSend={(prompt) => void run(prompt)}
                models={availableModels}
                selectedModel={selectedModel}
                providerLabel={providerLabel}
                onSelectModel={handleSelectModel}
                onOpenSettings={() => openSettings('api')}
                enableWebResearch={prefs.enableWebResearch}
                onToggleWebResearch={handleToggleWebResearch}
              />

              <section className="quick-prompts" aria-labelledby="quick-prompts-label">
                <div className="quick-prompts-head">
                  <h2 id="quick-prompts-label">试试预设演示（零 Token 即点即跑）</h2>
                  <button
                    type="button"
                    className="text-link"
                    onClick={() => {
                      setRailTab('presets');
                      setSidebarCollapsed(false);
                    }}
                  >
                    <LayoutGrid size={13} /> 全部 {runtime.presets.length} 个案例
                  </button>
                </div>

                <div className="quick-grid">
                  {QUICK_PROMPTS.map(({ id, prompt, desc, Icon }) => {
                    const preset = runtime.presets.find((item) => item.id === id);
                    return (
                      <button
                        key={id}
                        type="button"
                        className="quick-card"
                        disabled={!preset}
                        onClick={() => void run(prompt, preset)}
                      >
                        <span className="quick-card-icon">
                          <Icon size={17} />
                        </span>
                        <span className="quick-card-text">
                          <strong>{prompt}</strong>
                          <small>{desc}</small>
                        </span>
                        <ChevronRight size={15} className="quick-card-arrow" />
                      </button>
                    );
                  })}
                </div>
              </section>
            </div>
          </div>
        </main>
      ) : (
        <>
          {!sidebarCollapsed && (
            <section className="left-pane" aria-label={leftHeaderTitle}>
              <header className="pane-header">
                <div className="pane-title-wrap">
                  <h1 className="pane-title" title={leftHeaderTitle}>
                    {leftHeaderTitle}
                  </h1>
                </div>
                <div className="pane-header-right">
                  <button
                    type="button"
                    className="status-pill-btn"
                    title="点击切换模型或 API 服务商"
                    onClick={() => openSettings('api')}
                  >
                    <span className="status-dot" />
                    <span className="status-pill-text">{quotaOrModelPill}</span>
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    title="收起左侧栏"
                    aria-label="收起左侧栏"
                    onClick={() => setSidebarCollapsed(true)}
                  >
                    <PanelLeftClose size={16} />
                  </button>
                </div>
              </header>

              {railTab === 'chat' && (
                <>
                  <ChatPane
                    turns={turns}
                    onOpenCode={(src) => {
                      if (src) setCode(src);
                      setWbTab('verilog');
                    }}
                    onDownloadCode={(filename, src) => handleExportVerilog(filename, src)}
                    onOpenVerify={() => setWbTab('verify')}
                    onOpenSettings={() => openSettings('api')}
                  />
                  <div className="composer-dock">
                    <PromptComposer
                      compact
                      busy={busy}
                      onCancel={cancel}
                      onSend={(prompt) => void run(prompt)}
                      models={availableModels}
                      selectedModel={selectedModel}
                      providerLabel={providerLabel}
                      onSelectModel={handleSelectModel}
                      onOpenSettings={() => openSettings('api')}
                      enableWebResearch={prefs.enableWebResearch}
                      onToggleWebResearch={handleToggleWebResearch}
                      onInjectBug={compiled ? () => setRailTab('clinic') : undefined}
                      liveHint={busy && compiled ? `V${wbTitleVersion} 仿真可继续操作` : undefined}
                    />
                  </div>
                </>
              )}

              {railTab === 'presets' && (
                <PresetsPanel
                  presets={runtime.presets}
                  activePresetId={activePresetId}
                  busy={busy}
                  onSelectPreset={(preset) => void run(preset.prompt, preset)}
                />
              )}

              {railTab === 'clinic' && (
                <BugClinicPanel
                  presets={runtime.presets}
                  activePreset={activePreset}
                  hasCircuit={compiled}
                  activeBug={activeBug}
                  hintLevel={hintLevel}
                  selfTest={selfTest}
                  injecting={injectingBug}
                  onInjectPresetBug={injectPresetBug}
                  onInjectAiBug={() => void injectAiBug()}
                  onRevealHint={(level) => setHintLevel(level)}
                  onApplyFix={applyBugFix}
                  onExitBug={exitBugClinic}
                  onLoadPreset={(preset) => void run(preset.prompt, preset)}
                  onJumpToLine={jumpToVerilogLine}
                />
              )}

              {railTab === 'history' && (
                <HistoryPanel
                  entries={historyEntries}
                  onRestore={restoreHistoryEntry}
                  onDownload={(entry) => handleExportVerilog(entry.filename, entry.code)}
                  onDelete={(id) => setHistoryEntries(deleteHistoryEntry(id))}
                  onClear={() => {
                    clearHistoryEntries();
                    setHistoryEntries([]);
                  }}
                />
              )}
            </section>
          )}

          <main className="workbench-pane" aria-label="FPGA 可视化工作台">
            <header className="wb-header">
              <div className="wb-header-left">
                {sidebarCollapsed && (
                  <button
                    type="button"
                    className="icon-button"
                    title="展开左侧栏"
                    aria-label="展开左侧栏"
                    onClick={() => setSidebarCollapsed(false)}
                  >
                    <PanelLeftOpen size={16} />
                  </button>
                )}

                <div className="wb-tabs" role="tablist" aria-label="工作台视图">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={wbTab === 'canvas'}
                    className={wbTab === 'canvas' ? 'active' : undefined}
                    onClick={() => setWbTab('canvas')}
                  >
                    仿真画布
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={wbTab === 'blueprint'}
                    className={wbTab === 'blueprint' ? 'active' : undefined}
                    onClick={() => setWbTab('blueprint')}
                  >
                    蓝图
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={wbTab === 'verilog'}
                    className={wbTab === 'verilog' ? 'active' : undefined}
                    onClick={() => setWbTab('verilog')}
                  >
                    Verilog
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={wbTab === 'verify'}
                    className={wbTab === 'verify' ? 'active' : undefined}
                    onClick={() => setWbTab('verify')}
                  >
                    自测
                    {selfTest && (
                      <span className={`tab-count ${selfTest.passed ? 'ok' : 'fail'}`}>
                        {selfTest.passedChecks}/{selfTest.totalChecks}
                      </span>
                    )}
                  </button>
                </div>

                <div className="wb-status-pills">
                  {compiled && wbTitleVersion > 0 && (
                    <span className={`version-pill ${activeBug ? 'warn' : 'live'}`}>
                      <i />
                      {activeBug
                        ? '故障排错中'
                        : running
                          ? `V${wbTitleVersion} 运行中`
                          : `V${wbTitleVersion} 已暂停`}
                    </span>
                  )}
                  {busy && (
                    <span className="version-pill testing">
                      <i />
                      V{wbTitleVersion + 1} 自测中
                    </span>
                  )}
                </div>
              </div>

              <div className="wb-header-right">
                <button
                  type="button"
                  className="outline-button icon-only-btn"
                  disabled={!code}
                  title="复制 Verilog 代码"
                  aria-label="复制 Verilog 代码"
                  onClick={() => void copyHeaderCode()}
                >
                  {copiedHeader ? <Check size={14} /> : <Copy size={14} />}
                </button>
                <button
                  type="button"
                  className="outline-button compact-btn"
                  disabled={!code}
                  onClick={() => handleExportVerilog()}
                >
                  <Download size={14} /> 导出 .v
                </button>
              </div>
            </header>

            {wbTab === 'canvas' && (
              <div className="wb-canvas-layout">
                <section className="schematic-column" aria-label="门级原理图">
                  <div className="schematic-subheader">
                    <div className="schematic-title">
                      <h2>门级原理图</h2>
                      {code && <span className="file-chip mono">{activeFilename}</span>}
                    </div>
                    <ClockControls
                      speed={speed}
                      running={running}
                      disabled={!compiled}
                      onSpeed={(mode) => {
                        setSpeed(mode);
                        setRunning(true);
                      }}
                      onToggle={toggleRun}
                      onStep={stepOnce}
                    />
                  </div>
                  <GateCanvas netlist={netlist} pending={busy} statusBadge={statusBadge} />
                </section>

                <aside className="instruments-column" aria-label="实时波形与虚拟板卡">
                  <Waveform title="实时波形" samples={history.slice(-10)} ledFocus={lockActive} />

                  <section className="instrument-section">
                    <div className="section-heading">
                      <h2>虚拟板卡</h2>
                      {latest && <span className="instrument-meta mono">CLK ↑ {latest.cycle}</span>}
                    </div>
                    {lockActive && (
                      <p className="board-hint">
                        用 SW3–SW0 依次拨入 1、2、3、4，每位按 KEY0 提交；KEY1 重新上锁。
                      </p>
                    )}
                    <VirtualBoard
                      inputs={inputs}
                      outputs={latest?.outputs}
                      onInputsChange={changeInputs}
                      disabled={!compiled}
                      lockDemo={lockActive}
                    />
                  </section>

                  {selfTest && (
                    <details className="self-test-wave" open={!selfTest.passed}>
                      <summary>
                        <span>自测波形</span>
                        <span className={`mono ${selfTest.passed ? '' : 'fail-text'}`}>
                          {wbTitleVersion > 0 ? `V${wbTitleVersion} · ` : ''}
                          {selfTest.passedChecks}/{selfTest.totalChecks}
                        </span>
                      </summary>
                      <Waveform
                        title="自测采样"
                        samples={selfTest.waveform}
                        failureCycle={selfTest.firstUnstableCycle ?? selfTest.firstFailure?.cycle}
                        ledFocus={selfTest.firstFailure?.signal === 'led' || lockActive}
                      />
                    </details>
                  )}
                </aside>
              </div>
            )}

            {wbTab === 'blueprint' && <BlueprintView blueprint={blueprint} />}

            {wbTab === 'verilog' && (
              <VerilogView
                code={code}
                filename={activeFilename}
                canCompile={!busy}
                highlightLine={highlightLine}
                issues={issues}
                onCodeChange={setCode}
                onCompile={compileEditedCode}
                onExportVerilog={() => handleExportVerilog()}
                onExportTestbench={handleExportTestbench}
              />
            )}

            {wbTab === 'verify' && (
              <VerifyView
                selfTest={selfTest}
                issues={issues}
                traces={traces}
                ledFocus={lockActive}
                onJumpToLine={jumpToVerilogLine}
              />
            )}
          </main>
        </>
      )}
    </div>
  );
}
