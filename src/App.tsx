import {
  Check,
  ChevronRight,
  CircuitBoard,
  ClipboardCheck,
  Copy,
  Download,
  FileCode2,
  FileText,
  LayoutGrid,
  LockKeyhole,
  PanelLeftClose,
  PanelLeftOpen,
  Radio,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createAgentRuntime } from './agent';
import { ApiSettings } from './components/ApiSettings';
import { BrandWordmark } from './components/BrandWordmark';
import { ChatPane, stepKeyForTrace, type ChatTurn } from './components/ChatPane';
import { GateCanvas } from './components/GateCanvas';
import { NavRail, type RailTab } from './components/NavRail';
import { ProductShowcase } from './components/ProductShowcase';
import { HistoryPanel, PresetsPanel } from './components/SidePanels';
import { ClockControls, PromptComposer, SPEED_INTERVAL_MS, type ClockSpeed } from './components/TopBar';
import { VirtualBoard } from './components/VirtualBoard';
import { Waveform } from './components/Waveform';
import { BlueprintView, VerifyView, VerilogView, type CodeStreamState } from './components/WorkbenchViews';
import { createRtlEngine } from './engine';
import {
  buildFallbackTestbench,
  deriveVerilogFilename,
  downloadTextFile,
} from './services/exportVerilog';
import {
  createLiveCodeStreamer,
  sleepAbortable,
  startSpatialTransition,
  streamTextSmoothly,
  streamVerilogTokens,
  type LiveCodeStreamer,
} from './services/streamPlayback';
import {
  createBrowserLLMClient,
  fetchQuotaStatus,
  fetchSiteModels,
  getProviderPreset,
  getSuggestedModelOptions,
  loadAppPreferences,
  loadByokConfig,
  loadSiteModel,
  saveAppPreferences,
  saveByokConfig,
  saveSiteModel,
  SITE_DEFAULT_MODELS,
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
const LEFT_PANE_STORAGE_KEY = 'fpgagent.leftPaneWidth';
const LEFT_PANE_MIN = 260;
const LEFT_PANE_MAX = 640;
const WORKBENCH_MIN = 420;

function defaultLeftPaneWidth(): number {
  if (typeof window === 'undefined') return 384;
  return window.innerWidth <= 1240 ? 320 : 384;
}

function clampLeftPaneWidth(
  width: number,
  viewportWidth = typeof window === 'undefined' ? 1440 : window.innerWidth,
): number {
  const rail = viewportWidth <= 1240 ? 52 : 56;
  const maxAllowed = Math.max(LEFT_PANE_MIN, Math.min(LEFT_PANE_MAX, viewportWidth - rail - WORKBENCH_MIN));
  return Math.round(Math.max(LEFT_PANE_MIN, Math.min(maxAllowed, width)));
}

function loadLeftPaneWidth(): number {
  if (typeof window === 'undefined') return 384;
  try {
    const raw = window.localStorage.getItem(LEFT_PANE_STORAGE_KEY);
    const parsed = raw ? Number(raw) : NaN;
    if (Number.isFinite(parsed) && parsed > 0) return clampLeftPaneWidth(parsed);
  } catch {
    // Ignore storage read failures in restricted environments.
  }
  return clampLeftPaneWidth(defaultLeftPaneWidth());
}

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

type AppView = 'home' | 'workbench' | 'showcase';
type WorkbenchTab = 'canvas' | 'blueprint' | 'verilog' | 'verify';
type Outcome = 'busy' | 'ready' | 'cancelled' | 'failed';

interface RouteState {
  view: AppView;
  railTab: RailTab;
  wbTab: WorkbenchTab;
}

function parseRouteFromHash(hash: string): RouteState {
  const clean = hash.replace(/^#\/?/, '').trim();
  if (!clean) return { view: 'home', railTab: 'chat', wbTab: 'canvas' };
  const [pathPart, queryPart] = clean.split('?');
  const params = new URLSearchParams(queryPart ?? '');
  const segs = pathPart.split('/').filter(Boolean);
  if (segs[0] === 'intro' || segs[0] === 'showcase' || segs[0] === 'about') {
    return { view: 'showcase', railTab: 'chat', wbTab: 'canvas' };
  }
  if (segs[0] === 'presets' || segs[0] === 'history') {
    const wb = params.get('tab');
    const wbTab: WorkbenchTab =
      wb === 'blueprint' || wb === 'verilog' || wb === 'verify' ? wb : 'canvas';
    return { view: 'workbench', railTab: segs[0], wbTab };
  }
  if (segs[0] === 'workbench') {
    const wb = segs[1];
    const wbTab: WorkbenchTab =
      wb === 'blueprint' || wb === 'verilog' || wb === 'verify' ? wb : 'canvas';
    const panel = params.get('panel');
    const railTab: RailTab =
      panel === 'presets' || panel === 'history' ? panel : 'chat';
    return { view: 'workbench', railTab, wbTab };
  }
  return { view: 'home', railTab: 'chat', wbTab: 'canvas' };
}

function formatHashFromRoute(route: RouteState): string {
  if (route.view === 'showcase') return '#/intro';
  if (route.view === 'home') return '#/';
  if (route.railTab !== 'chat') {
    return route.wbTab !== 'canvas' ? `#/${route.railTab}?tab=${route.wbTab}` : `#/${route.railTab}`;
  }
  return `#/workbench/${route.wbTab}`;
}

function isSameRoute(a: RouteState, b: RouteState): boolean {
  return a.view === b.view && a.railTab === b.railTab && a.wbTab === b.wbTab;
}

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
  const [siteModels, setSiteModels] = useState<LLMModelOption[]>(SITE_DEFAULT_MODELS);
  const [siteModel, setSiteModel] = useState<string>(loadSiteModel);
  const [remainingQuota, setRemainingQuota] = useState<number | undefined>();
  const [dailyQuotaLimit, setDailyQuotaLimit] = useState<number | undefined>();

  // Navigation & Browser History State
  const initialRoute = useMemo<RouteState>(() => {
    const parsed = parseRouteFromHash(window.location.hash);
    if (parsed.view === 'workbench' && parsed.railTab === 'chat') {
      return { view: 'home', railTab: 'chat', wbTab: 'canvas' };
    }
    return parsed;
  }, []);
  const [view, setView] = useState<AppView>(initialRoute.view);
  const [railTab, setRailTab] = useState<RailTab>(initialRoute.railTab);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [wbTab, setWbTab] = useState<WorkbenchTab>(initialRoute.wbTab);
  const routeRef = useRef<RouteState>(initialRoute);

  const navigateTo = useCallback(
    (patch: Partial<RouteState>, options: { replace?: boolean; skipTransition?: boolean } = {}) => {
      const prev = routeRef.current;
      const next: RouteState = { ...prev, ...patch };
      if (isSameRoute(prev, next)) return;

      const crossingHomeAndWorkbench =
        (prev.view === 'home' && next.view === 'workbench') ||
        (prev.view === 'workbench' && next.view === 'home');

      const commit = () => {
        routeRef.current = next;
        setView(next.view);
        setRailTab(next.railTab);
        setWbTab(next.wbTab);
        const hash = formatHashFromRoute(next);
        if (options.replace) {
          window.history.replaceState(next, '', hash);
        } else {
          window.history.pushState(next, '', hash);
        }
      };

      if (!options.skipTransition && crossingHomeAndWorkbench) {
        startSpatialTransition(commit, next.view === 'workbench' ? 'enter-workbench' : 'return-home');
      } else {
        commit();
      }
    },
    [],
  );

  useEffect(() => {
    window.history.replaceState(routeRef.current, '', formatHashFromRoute(routeRef.current));
    const onPopState = (event: PopStateEvent) => {
      const candidate = event.state as Partial<RouteState> | null;
      const next: RouteState =
        candidate &&
        (candidate.view === 'home' || candidate.view === 'workbench' || candidate.view === 'showcase') &&
        (candidate.railTab === 'chat' ||
          candidate.railTab === 'presets' ||
          candidate.railTab === 'history') &&
        (candidate.wbTab === 'canvas' ||
          candidate.wbTab === 'blueprint' ||
          candidate.wbTab === 'verilog' ||
          candidate.wbTab === 'verify')
          ? { view: candidate.view, railTab: candidate.railTab, wbTab: candidate.wbTab }
          : parseRouteFromHash(window.location.hash);
      routeRef.current = next;
      setView(next.view);
      setRailTab(next.railTab);
      setWbTab(next.wbTab);
      setSidebarCollapsed(false);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

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
  const [leftPaneWidth, setLeftPaneWidth] = useState<number>(loadLeftPaneWidth);
  const [resizingPane, setResizingPane] = useState(false);
  const leftPaneWidthRef = useRef(leftPaneWidth);
  leftPaneWidthRef.current = leftPaneWidth;
  const resizeDragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  // Streaming, Auto-follow & Home Prefill State
  const [homeDraft, setHomeDraft] = useState('');
  const [autoSubmittingPreset, setAutoSubmittingPreset] = useState(false);
  const [planningBlueprint, setPlanningBlueprint] = useState(false);
  const [codeStreamState, setCodeStreamState] = useState<CodeStreamState | undefined>();
  const [recommendedTab, setRecommendedTab] = useState<WorkbenchTab | null>(null);
  const userOverrodeTabRef = useRef(false);
  const liveCodeStreamerRef = useRef<LiveCodeStreamer | null>(null);
  const prefillAbortRef = useRef<AbortController | null>(null);

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
  const clockTimerRef = useRef<number | null>(null);
  const clockStateRef = useRef({ compiled: false, running: true, speed: 'realtime' as ClockSpeed });
  clockStateRef.current = { compiled, running, speed };
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
    void fetchQuotaStatus().then((status) => {
      if (!active || !status) return;
      setRemainingQuota(status.remainingQuota);
      setDailyQuotaLimit(status.dailyLimit);
    });
    void fetchSiteModels().then((models) => {
      if (!active || models.length === 0) return;
      setSiteModels(models);
    });
    return () => { active = false; };
  }, [api]);

  useEffect(() => {
    function handleWindowResize() {
      setLeftPaneWidth((prev) => clampLeftPaneWidth(prev));
    }
    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, []);

  const persistLeftPaneWidth = useCallback((width: number) => {
    try {
      window.localStorage.setItem(LEFT_PANE_STORAGE_KEY, String(width));
    } catch {
      // Ignore storage write failures.
    }
  }, []);

  function beginPaneResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer events in tests may not have an active browser pointer.
    }
    resizeDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: leftPaneWidthRef.current,
    };
    setResizingPane(true);
  }

  function movePaneResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = resizeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = clampLeftPaneWidth(drag.startWidth + (event.clientX - drag.startX));
    leftPaneWidthRef.current = next;
    setLeftPaneWidth(next);
  }

  function endPaneResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = resizeDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    resizeDragRef.current = null;
    setResizingPane(false);
    persistLeftPaneWidth(leftPaneWidthRef.current);
  }

  function resetLeftPaneWidth() {
    const next = clampLeftPaneWidth(defaultLeftPaneWidth());
    leftPaneWidthRef.current = next;
    setLeftPaneWidth(next);
    persistLeftPaneWidth(next);
  }

  function keyboardPaneResize(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Home') {
      event.preventDefault();
      resetLeftPaneWidth();
      return;
    }
    const step = event.shiftKey ? 40 : 16;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const delta = event.key === 'ArrowRight' ? step : -step;
      const next = clampLeftPaneWidth(leftPaneWidthRef.current + delta);
      leftPaneWidthRef.current = next;
      setLeftPaneWidth(next);
      persistLeftPaneWidth(next);
    }
  }

  const toggleLightDark = useCallback(() => {
    const nextMode = resolvedTheme === 'dark' ? 'light' : 'dark';
    handleThemeChange({ ...theme, mode: nextMode });
  }, [resolvedTheme, theme, handleThemeChange]);

  function openSettings(section: 'api' | 'appearance' = 'api') {
    setSettingsSection(section);
    setSettingsOpen(true);
  }

  // Model selector state derived from BYOK config or site-default model list
  const availableModels: LLMModelOption[] = useMemo(() => {
    if (!api) return siteModels;
    const base = api.cachedModels?.length
      ? api.cachedModels
      : getSuggestedModelOptions(api.providerId, api.model);
    if (!base.some((m) => m.id === api.model)) {
      return [{ id: api.model }, ...base];
    }
    return base;
  }, [api, siteModels]);

  const selectedModel = api
    ? api.model
    : siteModels.some((m) => m.id === siteModel)
      ? siteModel
      : siteModels[0]?.id ?? 'qwen3.8-flash';
  const providerLabel = api
    ? getProviderPreset(api.providerId)?.name ?? '自定义 API'
    : '站点默认';
  const siteQuotaNotice = !api ? { remaining: remainingQuota, limit: dailyQuotaLimit } : undefined;

  function handleSelectModel(modelId: string) {
    if (!api) {
      if (modelId === selectedModel) return;
      setSiteModel(modelId);
      saveSiteModel(modelId);
      return;
    }
    if (modelId === api.model) return;
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

  const restartClockTimer = useCallback(() => {
    if (clockTimerRef.current !== null) {
      window.clearInterval(clockTimerRef.current);
      clockTimerRef.current = null;
    }
    const { compiled: isCompiled, running: isRunning, speed: currentSpeed } = clockStateRef.current;
    if (!isCompiled || !isRunning || currentSpeed === 'step') return;
    clockTimerRef.current = window.setInterval(tick, SPEED_INTERVAL_MS[currentSpeed]);
  }, [tick]);

  // Board inputs & simulation loop
  function changeInputs(next: BoardInputs) {
    const resetPressed = next.rst_n === 0 && inputsRef.current.rst_n === 1;
    if (resetPressed) {
      pendingKeys.current = [];
      pendingReset.current = true;
    }
    const pressed = next.key & ~inputsRef.current.key;
    if (pressed) pendingKeys.current.push({ pressed, inputs: next });
    inputsRef.current = next;
    setInputs(next);

    const { compiled: isCompiled, running: isRunning, speed: currentSpeed } = clockStateRef.current;
    if (isCompiled && isRunning && currentSpeed !== 'step' && (resetPressed || pressed !== 0)) {
      if (pressed !== 0 && (sampledKeys.current & pressed)) {
        tick();
      }
      tick();
      restartClockTimer();
    }
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

  useEffect(() => {
    restartClockTimer();
    return () => {
      if (clockTimerRef.current !== null) {
        window.clearInterval(clockTimerRef.current);
        clockTimerRef.current = null;
      }
    };
  }, [compiled, running, speed, restartClockTimer]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      prefillAbortRef.current?.abort();
      liveCodeStreamerRef.current?.stop();
    },
    [],
  );

  function newChat() {
    abortRef.current?.abort();
    abortRef.current = null;
    prefillAbortRef.current?.abort();
    prefillAbortRef.current = null;
    liveCodeStreamerRef.current?.stop();
    liveCodeStreamerRef.current = null;
    setAutoSubmittingPreset(false);
    setHomeDraft('');
    setPlanningBlueprint(false);
    setCodeStreamState(undefined);
    setRecommendedTab(null);
    userOverrodeTabRef.current = false;
    setTurns([]);
    setOutcome('ready');
    setTraces([]);
    setVersion(0);
    setActivePresetId(undefined);
    setSidebarCollapsed(false);
    setSpeed(prefs.defaultClockSpeed);
    setRunning(true);
    clearCircuit();
    navigateTo({ view: 'home', railTab: 'chat', wbTab: 'canvas' });
  }

  function openShowcase() {
    setSidebarCollapsed(false);
    navigateTo({ view: 'showcase', railTab: 'chat' });
  }

  function updateAssistantTurn(turnId: string, updater: (prev: ChatTurn) => ChatTurn) {
    setTurns((prev) => prev.map((t) => (t.id === turnId ? updater(t) : t)));
  }

  function autoSwitchTab(target: WorkbenchTab) {
    setRecommendedTab(target);
    if (!userOverrodeTabRef.current) {
      navigateTo({ view: 'workbench', wbTab: target }, { replace: true, skipTransition: true });
    }
  }

  function handleManualTabClick(tab: WorkbenchTab) {
    if (outcome === 'busy') {
      userOverrodeTabRef.current = true;
    }
    navigateTo({ view: 'workbench', wbTab: tab });
  }

  async function triggerHomeQuickPrompt(promptText: string, preset: PresetProject) {
    if (autoSubmittingPreset || outcome === 'busy') return;
    prefillAbortRef.current?.abort();
    const ctrl = new AbortController();
    prefillAbortRef.current = ctrl;

    setAutoSubmittingPreset(true);
    setHomeDraft('');

    const filled = await streamTextSmoothly(
      promptText,
      Math.min(280, Math.max(160, promptText.length * 26)),
      (partial) => setHomeDraft(partial),
      ctrl.signal,
    );
    if (!filled || ctrl.signal.aborted) {
      setAutoSubmittingPreset(false);
      return;
    }

    const waited = await sleepAbortable(200, ctrl.signal);
    if (!waited || ctrl.signal.aborted) {
      setAutoSubmittingPreset(false);
      return;
    }

    setHomeDraft('');
    setAutoSubmittingPreset(false);
    void run(promptText, preset);
  }

  function compileEditedCode() {
    const { ok } = loadCircuit(code, vectors, blueprint?.title, activePresetId, undefined, {
      nextVersion: Math.max(1, version),
    });
    if (ok) {
      setOutcome('ready');
      setHighlightLine(undefined);
    } else {
      setOutcome('failed');
      navigateTo({ view: 'workbench', wbTab: 'verify' });
    }
  }

  async function run(prompt: string, preset?: PresetProject) {
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    liveCodeStreamerRef.current?.stop();
    liveCodeStreamerRef.current = null;

    const previous = applied.current;
    const nextVer = (previous?.version ?? 0) + 1;
    const userTurnId = nextId('user');
    const aiTurnId = nextId('ai');
    const startedAt = Date.now();
    const crossingFromHome = routeRef.current.view === 'home' && routeRef.current.railTab === 'chat';

    userOverrodeTabRef.current = false;

    const enterRunState = () => {
      navigateTo({ view: 'workbench', railTab: 'chat', wbTab: 'blueprint' }, { skipTransition: true });
      setRecommendedTab('blueprint');
      setSidebarCollapsed(false);
      setHighlightLine(undefined);
      setOutcome('busy');
      setTraces([]);
      setPlanningBlueprint(true);
      setCodeStreamState(undefined);
      if (!previous) setBlueprint(undefined);

      setTurns((prev) => [
        ...prev,
        { id: userTurnId, role: 'user', text: prompt },
        {
          id: aiTurnId,
          role: 'assistant',
          text: '',
          status: 'running',
          traces: [],
          liveReasoning: {},
          startedAt,
          version: nextVer,
        },
      ]);
    };

    if (crossingFromHome) {
      await startSpatialTransition(enterRunState, 'enter-workbench');
      if (abortRef.current !== controller || controller.signal.aborted) return;
    } else {
      enterRunState();
    }

    const active = () => abortRef.current === controller && !controller.signal.aborted;

    function pushTrace(event: HarnessTraceEvent) {
      if (!active()) return;
      setTraces((events) => [...events, event]);
      updateAssistantTurn(aiTurnId, (t) => ({
        ...t,
        traces: [...(t.traces ?? []), event],
      }));
    }

    function updateStepReasoning(stage: HarnessTraceEvent['stage'], reasoning: string, round?: number) {
      if (!active()) return;
      const key = stepKeyForTrace(stage, round);
      updateAssistantTurn(aiTurnId, (t) => ({
        ...t,
        liveReasoning: { ...(t.liveReasoning ?? {}), [key]: reasoning },
      }));
    }

    function updateCodingLines(lines: number) {
      if (!active() || lines <= 0) return;
      updateAssistantTurn(aiTurnId, (t) => {
        const list = t.traces ?? [];
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].stage === 'coding' || list[i].stage === 'repairing') {
            const next = [...list];
            next[i] = {
              ...next[i],
              meta: { ...(next[i].meta ?? {}), codeLines: lines },
            };
            return { ...t, traces: next };
          }
        }
        return t;
      });
    }

    try {
      if (preset) {
        const planReasoning = [
          `拆解目标：${preset.blueprint.summary}`,
          `对齐顶层接口：${preset.blueprint.pinMappings.map((p) => p.port).join('、')}`,
          `设计 ${preset.testVectors.length} 拍确定性验证序列，覆盖低电平复位与关键交互分支。`,
        ].join('\n');

        pushTrace({
          stage: 'planning',
          status: 'running',
          title: '规划电路蓝图',
          detail: `分析需求「${prompt}」并拆解端口、状态机与自测向量`,
          timestamp: Date.now(),
        });

        const reasoned = await streamTextSmoothly(
          planReasoning,
          560,
          (partial) => updateStepReasoning('planning', partial),
          controller.signal,
        );
        if (!reasoned || !active()) return;
        if (!(await sleepAbortable(160, controller.signal)) || !active()) return;

        setBlueprint(preset.blueprint);
        setPlanningBlueprint(false);
        const planCheckpoints = [
          ...preset.blueprint.behaviors.slice(0, 4).map((b, i) => `${i + 1}. ${b}`),
          `端口映射：${preset.blueprint.pinMappings.map((p) => p.port).slice(0, 5).join(' / ')}`,
        ];
        pushTrace({
          stage: 'planning',
          status: 'pass',
          title: '规划电路蓝图',
          detail: `${preset.blueprint.behaviors.length} 条行为要点 · ${preset.blueprint.pinMappings.length} 个引脚映射 · ${preset.testVectors.length} 拍自测向量`,
          timestamp: Date.now(),
          meta: { checkpoints: planCheckpoints, reasoning: planReasoning },
        });

        if (!(await sleepAbortable(280, controller.signal)) || !active()) return;

        // Stage 2: Coding — auto switch to Verilog view and stream by complete lexical tokens.
        autoSwitchTab('verilog');
        setCode('');
        setCodeStreamState({
          active: true,
          stage: 'coding',
          statusText: '正在编写可综合 Verilog 源码…',
        });
        pushTrace({
          stage: 'coding',
          status: 'running',
          title: '编写 Verilog 源码',
          detail: '按蓝图规格与端口约束生成可综合 top 模块',
          timestamp: Date.now(),
        });

        const totalLines = preset.verilogCode.split('\n').length;
        const codingDurationMs = Math.min(2550, Math.max(2050, totalLines * 26));
        let lastReportedLine = 0;
        const streamed = await streamVerilogTokens(
          preset.verilogCode,
          codingDurationMs,
          (partial, lines) => {
            if (!active()) return;
            setCode(partial);
            if (lines - lastReportedLine >= 4 || lines === totalLines) {
              lastReportedLine = lines;
              updateCodingLines(lines);
            }
          },
          controller.signal,
        );
        if (!streamed || !active()) return;

        setCode(preset.verilogCode);
        setVectors(preset.testVectors);
        pushTrace({
          stage: 'coding',
          status: 'pass',
          title: '编写 Verilog 源码',
          detail: `${totalLines} 行可综合 Verilog · 顶层端口与时序逻辑已生成`,
          timestamp: Date.now(),
          meta: {
            codeLines: totalLines,
            checkpoints: [`模块 top 已对齐 clk / rst_n / key / sw / led / traffic / seg 端口规范`],
          },
        });

        // Stage 3: Lint — stay on Verilog view, run real engine lint.
        setCodeStreamState({
          active: true,
          stage: 'linting',
          statusText: 'Lint 静态语法与可综合规则体检中…',
        });
        pushTrace({
          stage: 'linting',
          status: 'running',
          title: 'Lint 静态体检',
          detail: `检查第 1 版代码（${totalLines} 行）的语法与可综合规则`,
          timestamp: Date.now(),
          meta: { round: 0 },
        });

        if (!(await sleepAbortable(340, controller.signal)) || !active()) return;
        const lintEngine = engineFactory();
        const compiledCheck = lintEngine.compile(preset.verilogCode);
        const errorCount = compiledCheck.issues.filter((i) => i.severity === 'error').length;
        pushTrace({
          stage: 'linting',
          status: compiledCheck.ok ? 'pass' : 'fail',
          title: 'Lint 静态体检',
          detail:
            compiledCheck.issues.length === 0
              ? '0 错误 · 0 告警'
              : `${compiledCheck.issues.length} 条告警（${errorCount} 条 error）`,
          timestamp: Date.now(),
          meta: {
            round: 0,
            checkpoints:
              compiledCheck.issues.length === 0
                ? ['端口声明与位宽对齐通过', '0 阻塞/非阻塞混用错误 · 0 推断锁存器告警']
                : compiledCheck.issues.slice(0, 4).map((i) => `第 ${i.line} 行 [${i.code}] ${i.message}`),
          },
        });

        // Stage 4: Deterministic simulation — stay on Verilog view, run real self-test.
        setCodeStreamState({
          active: true,
          stage: 'simulating',
          statusText: `正在执行 ${preset.testVectors.length} 拍确定性仿真向量…`,
        });
        pushTrace({
          stage: 'simulating',
          status: 'running',
          title: '确定性仿真自测',
          detail: `运行 ${preset.testVectors.length} 拍测试向量并校验板卡输出`,
          timestamp: Date.now(),
          meta: { round: 0 },
        });

        if (!(await sleepAbortable(480, controller.signal)) || !active()) return;

        const { ok, verification } = loadCircuit(
          preset.verilogCode,
          preset.testVectors,
          preset.blueprint.title,
          preset.id,
          undefined,
          { nextVersion: nextVer },
        );

        if (!ok) {
          setCodeStreamState(undefined);
          setRecommendedTab(null);
          setOutcome('failed');
          pushTrace({
            stage: 'simulating',
            status: 'fail',
            title: '确定性仿真自测',
            detail: '部分测试向量未通过，请查看自测详情',
            timestamp: Date.now(),
            meta: { round: 0 },
          });
          updateAssistantTurn(aiTurnId, (t) => ({
            ...t,
            status: 'failed',
            finishedAt: Date.now(),
            text: '生成的电路验证未通过，可在右侧「自测」页签查看失配周期与波形细节。',
          }));
          autoSwitchTab('verify');
          return;
        }

        const simCheckpoints = preset.testVectors
          .filter((v) => v.note)
          .slice(0, 4)
          .map((v) => `✓ 第 ${v.cycle} 拍 · ${v.note}`);
        pushTrace({
          stage: 'simulating',
          status: 'pass',
          title: '确定性仿真自测',
          detail: `${verification?.passedChecks ?? preset.testVectors.length}/${verification?.totalChecks ?? preset.testVectors.length} 项断言全部通过`,
          timestamp: Date.now(),
          meta: { round: 0, checkpoints: simCheckpoints },
        });

        // Stage 5: Verified feedback pause (~450ms) then smoothly switch to Canvas!
        setCodeStreamState({
          active: true,
          stage: 'verified',
          statusText: `全部 ${verification?.passedChecks ?? preset.testVectors.length}/${verification?.totalChecks ?? preset.testVectors.length} 项断言通过 · 正在上板加载仿真画布…`,
        });
        if (!(await sleepAbortable(450, controller.signal)) || !active()) return;

        const filename = deriveVerilogFilename(preset.verilogCode, preset.id);
        setCodeStreamState(undefined);
        setVersion(nextVer);
        setRecommendedTab(null);
        autoSwitchTab('canvas');
        pushTrace({
          stage: 'done',
          status: 'pass',
          title: '验证通过，已上板仿真',
          detail: `全部 ${verification?.totalChecks ?? preset.testVectors.length} 项断言通过`,
          timestamp: Date.now(),
        });

        const finalSummary = `已完成「${preset.blueprint.title}」的蓝图规划、Verilog 编码与 ${verification?.totalChecks ?? preset.testVectors.length} 拍自测验证。${preset.blueprint.summary} 右侧已加载 V${nextVer} 门级原理图与虚拟开发板，可直接操作按键或拨码观察实时信号变化。`;
        const finishedAt = Date.now();
        updateAssistantTurn(aiTurnId, (t) => ({
          ...t,
          finishedAt,
          filename,
          code: preset.verilogCode,
          passedChecks: verification?.passedChecks,
          totalChecks: verification?.totalChecks,
        }));

        await streamTextSmoothly(
          finalSummary,
          420,
          (partial) => {
            if (!active()) return;
            updateAssistantTurn(aiTurnId, (t) => ({ ...t, text: partial }));
          },
          controller.signal,
        );
        if (!active()) return;

        setOutcome('ready');
        updateAssistantTurn(aiTurnId, (t) => ({
          ...t,
          status: 'done',
          text: finalSummary,
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
        const recentHistory = turns
          .filter((t) => t.text.trim())
          .slice(-6)
          .map((t) => ({ role: t.role, content: t.text }));

        let lastLiveLines = 0;
        const codeStreamer = createLiveCodeStreamer((partial, lines) => {
          if (!active()) return;
          setCode(partial);
          if (lines - lastLiveLines >= 3) {
            lastLiveLines = lines;
            updateCodingLines(lines);
          }
        });
        liveCodeStreamerRef.current = codeStreamer;

        let lastReasoningUpdate = 0;
        const handleHarnessTrace = (event: HarnessTraceEvent) => {
          pushTrace(event);
          if (!active()) return;

          if (event.stage === 'planning' && event.status === 'running') {
            setPlanningBlueprint(true);
            autoSwitchTab('blueprint');
          } else if (event.stage === 'planning' && event.status === 'pass') {
            setPlanningBlueprint(false);
          } else if (event.stage === 'coding' && event.status === 'running') {
            setPlanningBlueprint(false);
            lastLiveLines = 0;
            codeStreamer.reset();
            setCode('');
            autoSwitchTab('verilog');
            setCodeStreamState({
              active: true,
              stage: 'coding',
              statusText: '正在实时编写可综合 Verilog 源码…',
            });
          } else if (event.stage === 'linting' && event.status === 'running') {
            setCodeStreamState({
              active: true,
              stage: 'linting',
              statusText: event.detail || 'Lint 静态体检中…',
            });
          } else if (event.stage === 'simulating' && event.status === 'running') {
            setCodeStreamState({
              active: true,
              stage: 'simulating',
              statusText: event.detail || '确定性仿真自测中…',
            });
          } else if (event.stage === 'repairing' && event.status === 'running') {
            lastLiveLines = 0;
            codeStreamer.reset();
            if (event.meta?.highlightLine) setHighlightLine(event.meta.highlightLine);
            autoSwitchTab('verilog');
            setCodeStreamState({
              active: true,
              stage: 'repairing',
              statusText: `${event.title} · ${event.detail}`,
            });
          }
        };

        const result = await runtime.runHarness(prompt, {
          signal: controller.signal,
          onTrace: handleHarnessTrace,
          onBlueprint: (bp) => {
            if (!active()) return;
            setBlueprint(bp);
            setPlanningBlueprint(false);
          },
          onCodeDelta: (partialCode, meta) => {
            if (!active()) return;
            codeStreamer.push(partialCode, Boolean(meta?.final));
          },
          onReasoningDelta: (stage, reasoning, round) => {
            if (!active()) return;
            const nowTs = performance.now();
            if (nowTs - lastReasoningUpdate < 75) return;
            lastReasoningUpdate = nowTs;
            updateStepReasoning(stage, reasoning, round);
          },
          model: selectedModel,
          enableWebResearch: prefs.enableWebResearch,
          previousContext: previous
            ? {
                blueprint,
                verilogCode: previous.source,
                testVectors: vectors,
                history: recentHistory,
              }
            : undefined,
        });

        codeStreamer.flush(result.verilogCode);
        if (liveCodeStreamerRef.current === codeStreamer) liveCodeStreamerRef.current = null;
        if (!active()) return;
        if (result.remainingQuota !== undefined) setRemainingQuota(result.remainingQuota);

        setPlanningBlueprint(false);
        setBlueprint(result.blueprint);
        setCode(result.verilogCode);
        setVectors(result.testVectors);

        if (!result.ok) {
          setCodeStreamState(undefined);
          setRecommendedTab(null);
          setIssues(result.issues);
          setSelfTest(result.selfTest);
          setOutcome('failed');
          updateAssistantTurn(aiTurnId, (t) => ({
            ...t,
            status: 'failed',
            finishedAt: Date.now(),
            text:
              result.assistantSummary ??
              (previous
                ? '新候选验证未通过，右侧板卡仍保持上一版本运行。可在「自测」或「Verilog」页签排查。'
                : '生成的候选代码未通过编译或自测，可在右侧「自测」页签查看具体失配拍与 Lint 提示。'),
            passedChecks: result.selfTest?.passedChecks,
            totalChecks: result.selfTest?.totalChecks,
            modelUsed: result.modelUsed ?? (api ? selectedModel : undefined),
            references: result.references,
          }));
          autoSwitchTab('verify');
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
          setCodeStreamState(undefined);
          setRecommendedTab(null);
          setOutcome('failed');
          updateAssistantTurn(aiTurnId, (t) => ({
            ...t,
            status: 'failed',
            finishedAt: Date.now(),
            text: '上板验证未通过，请在右侧「自测」页签查看原因。',
          }));
          autoSwitchTab('verify');
          return;
        }

        setCodeStreamState({
          active: true,
          stage: 'verified',
          statusText: `全部 ${verification?.passedChecks ?? 0}/${verification?.totalChecks ?? 0} 项断言通过 · 正在上板加载仿真画布…`,
        });
        if (!(await sleepAbortable(450, controller.signal)) || !active()) return;

        const filename = deriveVerilogFilename(
          result.verilogCode,
          result.blueprint.title,
          result.suggestedFilename,
        );
        const usedModel = result.modelUsed ?? (api ? selectedModel : undefined);
        const finalSummary =
          result.assistantSummary ??
          `已完成「${result.blueprint.title}」并全部通过自测，右侧已刷新为 V${nextVer} 仿真视图。`;

        setCodeStreamState(undefined);
        setVersion(nextVer);
        setRecommendedTab(null);
        autoSwitchTab('canvas');

        updateAssistantTurn(aiTurnId, (t) => ({
          ...t,
          finishedAt: Date.now(),
          filename,
          code: result.verilogCode,
          passedChecks: verification?.passedChecks,
          totalChecks: verification?.totalChecks,
          modelUsed: usedModel,
          references: result.references,
        }));

        await streamTextSmoothly(
          finalSummary,
          420,
          (partial) => {
            if (!active()) return;
            updateAssistantTurn(aiTurnId, (t) => ({ ...t, text: partial }));
          },
          controller.signal,
        );
        if (!active()) return;

        setOutcome('ready');
        updateAssistantTurn(aiTurnId, (t) => ({
          ...t,
          status: 'done',
          text: finalSummary,
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
      liveCodeStreamerRef.current?.stop();
      liveCodeStreamerRef.current = null;
      if (!active()) return;
      setPlanningBlueprint(false);
      setCodeStreamState(undefined);
      setRecommendedTab(null);
      const errCode = isLLMError(error) ? error.code : undefined;
      if (errCode === 'QUOTA_EXCEEDED' && !api) {
        setRemainingQuota(0);
      }
      const rawMessage = isLLMError(error) ? error.message.trim() : '';
      const baseText = errCode ? LLM_ERROR_TEXT[errCode] : '生成未完成，请重试。';
      const detail =
        rawMessage && errCode !== 'ABORTED' && !baseText.includes(rawMessage)
          ? `${baseText}（${rawMessage}）`
          : baseText;
      setOutcome('failed');
      pushTrace({ stage: 'failed', status: 'fail', title: '执行失败', detail, timestamp: Date.now() });
      updateAssistantTurn(aiTurnId, (t) => ({
        ...t,
        status: 'failed',
        finishedAt: Date.now(),
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
    liveCodeStreamerRef.current?.stop();
    liveCodeStreamerRef.current = null;
    setPlanningBlueprint(false);
    setCodeStreamState(undefined);
    setRecommendedTab(null);
    setOutcome('cancelled');
    setTurns((prev) =>
      prev.map((t) =>
        t.status === 'running'
          ? { ...t, status: 'cancelled', finishedAt: Date.now(), text: '已停止本轮生成，可继续输入新需求。' }
          : t,
      ),
    );
  }

  function restoreHistoryEntry(entry: HistoryEntry) {
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
    navigateTo({ view: 'workbench', railTab: 'chat', wbTab: 'canvas' });
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
    navigateTo({ view: 'workbench', wbTab: 'verilog' });
  }

  const busy = outcome === 'busy';
  const latest = history.at(-1);
  const lockActive = activePresetId === 'password-lock';
  const hasSession = view === 'workbench';

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
      : railTab === 'history'
        ? '本地版本历史'
        : blueprint?.title ?? '新电路对话';

  const homeQuotaText = api
    ? `自定义 API · ${providerLabel}`
    : remainingQuota !== undefined && dailyQuotaLimit !== undefined
      ? `站点免费额度 · ${remainingQuota}/${dailyQuotaLimit}`
      : remainingQuota !== undefined
        ? `站点免费额度 · 剩 ${remainingQuota} 次`
        : '站点免费额度';

  const wbTitleVersion = applied.current?.version ?? version;

  return (
    <div
      className="app-frame"
      data-has-session={hasSession}
      data-sidebar-collapsed={sidebarCollapsed}
      data-resizing={resizingPane}
      style={{ '--left-pane-width': `${leftPaneWidth}px` } as CSSProperties}
    >
      <NavRail
        activeTab={railTab}
        isShowcase={view === 'showcase'}
        onSelectTab={(tab) => {
          setSidebarCollapsed(false);
          if (tab === 'chat') {
            if (turns.length > 0 || compiled) {
              navigateTo({ view: 'workbench', railTab: 'chat' });
            } else {
              navigateTo({ view: 'home', railTab: 'chat' });
            }
          } else {
            navigateTo({ view: 'workbench', railTab: tab });
          }
        }}
        onOpenShowcase={openShowcase}
        onNewChat={newChat}
        onOpenSettings={() => openSettings('api')}
        resolvedTheme={resolvedTheme}
        onToggleTheme={toggleLightDark}
        hasCustomApi={Boolean(api)}
      />

      {settingsOpen && (
        <ApiSettings
          config={api}
          theme={theme}
          prefs={prefs}
          remainingQuota={remainingQuota}
          dailyQuotaLimit={dailyQuotaLimit}
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

      {view === 'showcase' ? (
        <ProductShowcase
          presets={runtime.presets}
          hasActiveSession={turns.length > 0 || compiled}
          onStartDesigning={() => {
            setSidebarCollapsed(false);
            navigateTo({ view: 'home', railTab: 'chat' });
          }}
          onReturnWorkbench={() => {
            setSidebarCollapsed(false);
            navigateTo({ view: 'workbench', railTab: 'chat' });
          }}
          onTryPreset={(preset) => void run(preset.prompt, preset)}
          onOpenPresets={() => {
            setSidebarCollapsed(false);
            navigateTo({ view: 'workbench', railTab: 'presets' });
          }}
        />
      ) : !hasSession ? (
        <main className="home-stage">
          <header className="home-topbar">
            <div className="home-brand">
              <BrandWordmark className="home-brand-wordmark" />
              <span>专注于 FPGA 的 AI Agent</span>
            </div>
            <div className="home-topbar-actions">
              <button
                type="button"
                className="home-quota-link mono"
                onClick={() => openSettings('api')}
                title={`${homeQuotaText} · 点击管理模型与 API 配置`}
              >
                <span className="status-dot" />
                <span>{homeQuotaText}</span>
              </button>
            </div>
          </header>

          <div className="home-center">
            <div className="home-hero">
              <h1 className="home-hero-heading">用自然语言编写并仿真数字电路</h1>

              <PromptComposer
                onSend={(prompt) => void run(prompt)}
                models={availableModels}
                selectedModel={selectedModel}
                providerLabel={providerLabel}
                quotaNotice={siteQuotaNotice}
                onSelectModel={handleSelectModel}
                onOpenSettings={() => openSettings('api')}
                enableWebResearch={prefs.enableWebResearch}
                onToggleWebResearch={handleToggleWebResearch}
                draftValue={homeDraft}
                onDraftChange={setHomeDraft}
                autoSubmitting={autoSubmittingPreset}
                viewTransitionName="main-composer"
              />

              <section className="quick-prompts" aria-labelledby="quick-prompts-label">
                <div className="quick-prompts-head">
                  <h2 id="quick-prompts-label">试试快捷示例</h2>
                  <button
                    type="button"
                    className="text-link"
                    onClick={() => {
                      setSidebarCollapsed(false);
                      navigateTo({ view: 'workbench', railTab: 'presets' });
                    }}
                  >
                    <LayoutGrid size={13} /> 全部 {runtime.presets.length} 个示例
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
                        disabled={!preset || autoSubmittingPreset}
                        onClick={() => preset && void triggerHomeQuickPrompt(prompt, preset)}
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
          <section
            className="left-pane"
            aria-label={leftHeaderTitle}
            aria-hidden={sidebarCollapsed || undefined}
          >
              <header className="pane-header">
                <div className="pane-title-wrap">
                  <h1 className="pane-title" title={leftHeaderTitle}>
                    {leftHeaderTitle}
                  </h1>
                </div>
                <div className="pane-header-right">
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
                      handleManualTabClick('verilog');
                    }}
                    onDownloadCode={(filename, src) => handleExportVerilog(filename, src)}
                    onOpenVerify={() => handleManualTabClick('verify')}
                    onOpenSettings={() => openSettings('api')}
                    onJumpToLine={jumpToVerilogLine}
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
                      quotaNotice={siteQuotaNotice}
                      onSelectModel={handleSelectModel}
                      onOpenSettings={() => openSettings('api')}
                      enableWebResearch={prefs.enableWebResearch}
                      onToggleWebResearch={handleToggleWebResearch}
                      liveHint={busy && compiled ? `V${wbTitleVersion} 仿真可继续操作` : undefined}
                      viewTransitionName={sidebarCollapsed ? undefined : 'main-composer'}
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

          <div
            className="pane-resizer"
            role="separator"
            aria-orientation="vertical"
            aria-hidden={sidebarCollapsed || undefined}
            aria-label="拖动调整左右面板宽度"
            aria-valuemin={LEFT_PANE_MIN}
            aria-valuemax={clampLeftPaneWidth(LEFT_PANE_MAX)}
            aria-valuenow={leftPaneWidth}
            title="左右拖动调整面板宽度（双击恢复默认）"
            tabIndex={sidebarCollapsed ? -1 : 0}
            onPointerDown={beginPaneResize}
            onPointerMove={movePaneResize}
            onPointerUp={endPaneResize}
            onPointerCancel={endPaneResize}
            onLostPointerCapture={endPaneResize}
            onDoubleClick={resetLeftPaneWidth}
            onKeyDown={keyboardPaneResize}
          />

          <main className="workbench-pane" aria-label="FPGA 可视化工作台">
            <header className="wb-header">
              <div className="wb-header-left">
                {sidebarCollapsed && (
                  <button
                    type="button"
                    className="icon-button wb-expand-btn"
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
                    onClick={() => handleManualTabClick('canvas')}
                  >
                    <CircuitBoard size={13.5} className="wb-tab-icon" aria-hidden="true" />
                    <span>仿真画布</span>
                    {busy && recommendedTab === 'canvas' && wbTab !== 'canvas' && (
                      <span className="tab-activity-dot" aria-label="后台就绪" />
                    )}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={wbTab === 'blueprint'}
                    className={wbTab === 'blueprint' ? 'active' : undefined}
                    onClick={() => handleManualTabClick('blueprint')}
                  >
                    <FileText size={13.5} className="wb-tab-icon" aria-hidden="true" />
                    <span>蓝图</span>
                    {busy && recommendedTab === 'blueprint' && wbTab !== 'blueprint' && (
                      <span className="tab-activity-dot" aria-label="规划中" />
                    )}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={wbTab === 'verilog'}
                    className={wbTab === 'verilog' ? 'active' : undefined}
                    onClick={() => handleManualTabClick('verilog')}
                  >
                    <FileCode2 size={13.5} className="wb-tab-icon" aria-hidden="true" />
                    <span>Verilog</span>
                    {busy && recommendedTab === 'verilog' && wbTab !== 'verilog' && (
                      <span className="tab-activity-dot" aria-label="编码与验证中" />
                    )}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={wbTab === 'verify'}
                    className={wbTab === 'verify' ? 'active' : undefined}
                    onClick={() => handleManualTabClick('verify')}
                  >
                    <ClipboardCheck size={13.5} className="wb-tab-icon" aria-hidden="true" />
                    <span>自测</span>
                    {selfTest && (
                      <span className={`tab-count ${selfTest.passed ? 'ok' : 'fail'}`}>
                        {selfTest.passedChecks}/{selfTest.totalChecks}
                      </span>
                    )}
                    {busy && recommendedTab === 'verify' && wbTab !== 'verify' && (
                      <span className="tab-activity-dot" aria-label="后台更新中" />
                    )}
                  </button>
                </div>

                <div className="wb-status-pills">
                  {compiled && wbTitleVersion > 0 && (
                    <span className="version-pill live">
                      <i />
                      {running ? `V${wbTitleVersion} 运行中` : `V${wbTitleVersion} 已暂停`}
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

            <div key={wbTab} className="wb-tab-panel">
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
                    <Waveform title="实时波形" samples={history} ledFocus={lockActive} autoFollow showCycleMeta={false} />

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

              {wbTab === 'blueprint' && (
                <BlueprintView blueprint={blueprint} planning={planningBlueprint} />
              )}

              {wbTab === 'verilog' && (
                <VerilogView
                  code={code}
                  filename={activeFilename}
                  canCompile={!busy}
                  highlightLine={highlightLine}
                  issues={issues}
                  streamState={codeStreamState}
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
            </div>
          </main>
        </>
      )}
    </div>
  );
}
