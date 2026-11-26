import { callOpenAICompatible, UpstreamError } from '../../functions/openaiCompat.ts';
import {
  LLMError,
  type LLMCallOptions,
  type LLMClient,
  type LLMErrorCode,
  type LLMModelOption,
  type LLMProviderId,
  type LLMProviderPreset,
} from '../types/contracts';

export interface ByokConfig {
  providerId?: Exclude<LLMProviderId, 'site-default'>;
  baseUrl: string;
  apiKey: string;
  model: string;
  cachedModels?: LLMModelOption[];
  useLocalProxy?: boolean;
}

export interface AppPreferences {
  enableWebResearch: boolean;
  defaultClockSpeed: 'realtime' | 'slow';
}

type FetchImpl = typeof fetch;

export type LLMClientConfig =
  | { mode: 'proxy'; endpoint?: string; fetchImpl?: FetchImpl }
  | ({ mode: 'byok'; fetchImpl?: FetchImpl } & ByokConfig)
  | { mode: 'node'; env?: Record<string, string | undefined>; fetchImpl?: FetchImpl };

export const PROXY_ENDPOINT = '/functions/v1/app/agent';
export const QUOTA_ENDPOINT = '/functions/v1/app/quota';
export const MODELS_ENDPOINT = '/functions/v1/app/models';
export const LOCAL_GATEWAY_PROXY_ENDPOINT = '/__local_gateway_proxy';
const BYOK_STORAGE_KEY = 'vibefpga.byok';
const PREFS_STORAGE_KEY = 'fpgagent.prefs';
const SITE_MODEL_STORAGE_KEY = 'fpgagent.siteModel';
const BROWSER_ID_STORAGE_KEY = 'fpgagent.browserId';
const BROWSER_QUOTA_STORAGE_KEY = 'fpgagent.browserQuota';
const DEFAULT_SITE_DAILY_LIMIT = 8;
const DEFAULT_NODE_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_NODE_MODEL = 'qwen3.8-flash';

export const SITE_DEFAULT_MODELS: LLMModelOption[] = [
  { id: 'qwen3.8-flash', label: 'Qwen 3.8 Flash', ownedBy: '站点默认 · 推荐' },
  { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', ownedBy: '站点默认' },
];

export interface QuotaStatus {
  remainingQuota: number;
  dailyLimit: number;
}

function shanghaiDay(now = Date.now()): string {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
}

function getSafeLocalStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
      ? window.localStorage
      : null;
  } catch {
    return null;
  }
}

export function getBrowserId(): string | undefined {
  const storage = getSafeLocalStorage();
  if (!storage) return undefined;
  try {
    const existing = storage.getItem(BROWSER_ID_STORAGE_KEY)?.trim();
    if (existing && /^[a-zA-Z0-9_-]{8,64}$/.test(existing)) return existing;
    const generated =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `bid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    storage.setItem(BROWSER_ID_STORAGE_KEY, generated);
    return generated;
  } catch {
    return undefined;
  }
}

interface LocalBrowserQuotaState {
  day: string;
  used: number;
  limit?: number;
}

function readLocalBrowserQuota(now = Date.now()): LocalBrowserQuotaState | null {
  const storage = getSafeLocalStorage();
  if (!storage) return null;
  const today = shanghaiDay(now);
  try {
    const raw = storage.getItem(BROWSER_QUOTA_STORAGE_KEY);
    if (!raw) return { day: today, used: 0 };
    const parsed = JSON.parse(raw) as Partial<LocalBrowserQuotaState>;
    if (parsed.day !== today) {
      return {
        day: today,
        used: 0,
        ...(typeof parsed.limit === 'number' && parsed.limit > 0 ? { limit: parsed.limit } : {}),
      };
    }
    return {
      day: today,
      used: typeof parsed.used === 'number' && parsed.used >= 0 ? Math.floor(parsed.used) : 0,
      ...(typeof parsed.limit === 'number' && parsed.limit > 0 ? { limit: Math.floor(parsed.limit) } : {}),
    };
  } catch {
    return { day: today, used: 0 };
  }
}

function writeLocalBrowserQuota(state: LocalBrowserQuotaState): void {
  const storage = getSafeLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(BROWSER_QUOTA_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage failures.
  }
}

function reconcileQuotaStatus(serverRemaining: number, serverLimit?: number): QuotaStatus {
  const local = readLocalBrowserQuota();
  const dailyLimit =
    typeof serverLimit === 'number' && serverLimit > 0
      ? Math.floor(serverLimit)
      : local?.limit ?? DEFAULT_SITE_DAILY_LIMIT;
  if (!local) {
    return { remainingQuota: Math.max(0, serverRemaining), dailyLimit };
  }
  const effectiveRemaining = Math.min(Math.max(0, serverRemaining), Math.max(0, dailyLimit - local.used));
  writeLocalBrowserQuota({ day: local.day, used: local.used, limit: dailyLimit });
  return { remainingQuota: effectiveRemaining, dailyLimit };
}

function recordLocalBrowserUsage(serverRemaining?: number): number | undefined {
  const local = readLocalBrowserQuota();
  if (!local) return serverRemaining;
  const nextUsed = local.used + 1;
  writeLocalBrowserQuota({
    day: local.day,
    used: nextUsed,
    ...(local.limit ? { limit: local.limit } : {}),
  });
  if (typeof serverRemaining !== 'number') return undefined;
  if (local.limit) {
    return Math.min(Math.max(0, serverRemaining), Math.max(0, local.limit - nextUsed));
  }
  return Math.max(0, serverRemaining);
}

function markLocalQuotaExhausted(serverLimit?: number): void {
  const local = readLocalBrowserQuota();
  if (!local) return;
  const limit =
    typeof serverLimit === 'number' && serverLimit > 0
      ? Math.floor(serverLimit)
      : local.limit ?? DEFAULT_SITE_DAILY_LIMIT;
  writeLocalBrowserQuota({ day: local.day, used: Math.max(local.used, limit), limit });
}

function browserQuotaHeaders(): Record<string, string> {
  const id = getBrowserId();
  return id ? { 'X-Browser-Id': id } : {};
}

export const PROVIDER_PRESETS: LLMProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    suggestedModels: ['deepseek-chat', 'deepseek-reasoner'],
    docsUrl: 'https://platform.deepseek.com/api_keys',
    supportsJsonMode: true,
  },
  {
    id: 'zhipu-glm',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4.5-air',
    suggestedModels: ['glm-4.5-air', 'glm-4-plus', 'glm-4-flash'],
    docsUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    supportsJsonMode: true,
  },
  {
    id: 'dashscope-qwen',
    name: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen3.8-flash',
    suggestedModels: ['qwen3.8-flash', 'qwen3.7-flash', 'qwen4-max', 'deepseek-v4.1-flash'],
    docsUrl: 'https://bailian.console.aliyun.com/',
    supportsJsonMode: true,
  },
  {
    id: 'amd-radeon',
    name: 'AMD Radeon Cloud',
    baseUrl: 'https://developer.amd.com.cn/radeon/api/v1',
    defaultModel: 'Qwen3.8-Flash-Next',
    suggestedModels: ['Qwen3.8-Flash-Next', 'DeepSeek-V4.1-Flash-1017', 'DeepSeek-V4-Flash-0731'],
    docsUrl: 'https://developer.amd.com.cn/radeon/tokenfactory',
    supportsJsonMode: true,
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    suggestedModels: [
      'deepseek-ai/DeepSeek-V3',
      'Qwen/Qwen2.5-Coder-32B-Instruct',
      'Qwen/Qwen2.5-72B-Instruct',
    ],
    docsUrl: 'https://cloud.siliconflow.cn/account/ak',
    supportsJsonMode: true,
  },
  {
    id: 'moonshot-kimi',
    name: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    suggestedModels: ['moonshot-v1-8k', 'moonshot-v1-32k', 'kimi-k2-0711-preview'],
    docsUrl: 'https://platform.moonshot.cn/console/api-keys',
    supportsJsonMode: true,
  },
  {
    id: 'local-gateway',
    name: '本地 / 内网网关',
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: '',
    suggestedModels: ['qwen2.5-coder:7b', 'deepseek-r1:8b', 'llama3.1:8b'],
    supportsJsonMode: true,
    apiKeyOptional: true,
  },
  {
    id: 'custom',
    name: '自定义兼容',
    baseUrl: '',
    defaultModel: '',
    suggestedModels: [],
    supportsJsonMode: true,
  },
];

export function getProviderPreset(id?: LLMProviderId): LLMProviderPreset | undefined {
  if (!id || id === 'site-default') return undefined;
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}

export function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  const rfc172 = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (rfc172) {
    const second = Number(rfc172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  const cgnat = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (cgnat) {
    const second = Number(cgnat[1]);
    if (second >= 64 && second <= 127) return true;
  }
  if (/\.(local|lan|internal|home|intranet|corp|arpa)$/i.test(host)) return true;
  if (!host.includes('.') && /^[a-z0-9-]+$/i.test(host)) return true;
  return false;
}

export function isLocalOrPrivateBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && isPrivateOrLocalHost(url.hostname);
  } catch {
    return false;
  }
}

export function isApiKeyOptional(baseUrl: string, providerId?: LLMProviderId): boolean {
  return providerId === 'local-gateway' || isLocalOrPrivateBaseUrl(baseUrl);
}

export function isLocalDevOrigin(): boolean {
  if (typeof window === 'undefined') return false;
  return ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
}

export function inferProviderId(baseUrl: string): Exclude<LLMProviderId, 'site-default'> {
  const normalized = normalizeBaseUrl(baseUrl);
  const matched = PROVIDER_PRESETS.find(
    (preset) =>
      preset.id !== 'custom' &&
      preset.id !== 'local-gateway' &&
      normalizeBaseUrl(preset.baseUrl) === normalized,
  );
  if (matched) return matched.id;
  if (isLocalOrPrivateBaseUrl(normalized)) return 'local-gateway';
  return 'custom';
}

export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '').replace(/\/models$/, '');
}

const SERVER_ERROR_MAP: Record<string, LLMErrorCode> = {
  quota_exceeded: 'QUOTA_EXCEEDED',
  service_not_configured: 'NOT_CONFIGURED',
  forbidden_origin: 'FORBIDDEN',
  upstream_timeout: 'TIMEOUT',
};

const UPSTREAM_ERROR_MAP: Record<UpstreamError['kind'], LLMErrorCode> = {
  timeout: 'TIMEOUT',
  aborted: 'ABORTED',
  network: 'NETWORK',
  upstream: 'UPSTREAM',
  bad_response: 'BAD_RESPONSE',
};

function toLLMError(error: unknown): LLMError {
  if (error instanceof LLMError) return error;
  if (error instanceof UpstreamError) {
    const code: LLMErrorCode =
      error.kind === 'upstream' && (error.status === 401 || error.status === 403)
        ? 'NOT_CONFIGURED'
        : error.kind === 'upstream' && error.status === 429
          ? 'QUOTA_EXCEEDED'
          : UPSTREAM_ERROR_MAP[error.kind];
    return new LLMError(code, error.message, error.status);
  }
  return new LLMError('NETWORK', error instanceof Error ? error.message : '未知网络错误');
}

export function isAllowedBaseUrl(value: string, providerId?: LLMProviderId): boolean {
  try {
    const url = new URL(value);
    const allowHttp = url.protocol === 'http:' && (isPrivateOrLocalHost(url.hostname) || providerId === 'local-gateway');
    return (allowHttp || url.protocol === 'https:') && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

function resolveDirectFetch(
  baseUrl: string,
  providerId: LLMProviderId | undefined,
  useLocalProxy: boolean | undefined,
  customFetch?: FetchImpl,
): FetchImpl {
  if (customFetch) return customFetch;
  const shouldProxy =
    isLocalDevOrigin() &&
    (useLocalProxy ?? (providerId === 'local-gateway' || isLocalOrPrivateBaseUrl(baseUrl)));
  if (!shouldProxy) return fetch;
  return (input, init) => {
    const targetUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    headers.set('x-gateway-target', targetUrl);
    return fetch(LOCAL_GATEWAY_PROXY_ENDPOINT, {
      ...init,
      headers,
      credentials: 'same-origin',
    });
  };
}

export async function fetchOpenAIModels(
  baseUrl: string,
  apiKey: string,
  options: {
    signal?: AbortSignal;
    fetchImpl?: FetchImpl;
    providerId?: LLMProviderId;
    useLocalProxy?: boolean;
  } = {},
): Promise<LLMModelOption[]> {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!isAllowedBaseUrl(normalized, options.providerId)) {
    throw new LLMError('NOT_CONFIGURED', 'Base URL 格式无效（公网需使用 https，本地或内网网关支持 http）');
  }
  const keyOptional = isApiKeyOptional(normalized, options.providerId);
  if (!keyOptional && !apiKey.trim()) throw new LLMError('NOT_CONFIGURED', '请先填写 API Key');

  const fetchImpl = resolveDirectFetch(normalized, options.providerId, options.useLocalProxy, options.fetchImpl);
  const headers: Record<string, string> = {};
  if (apiKey.trim()) headers.Authorization = `Bearer ${apiKey.trim()}`;

  let res: Response;
  try {
    res = await fetchImpl(`${normalized}/models`, {
      method: 'GET',
      headers,
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw new LLMError('ABORTED', '已取消拉取模型列表');
    throw new LLMError('NETWORK', error instanceof Error ? error.message : '无法连接模型列表接口');
  }

  if (res.status === 401 || res.status === 403) {
    throw new LLMError('NOT_CONFIGURED', 'API Key 鉴权失败，请检查密钥是否正确', res.status);
  }
  if (!res.ok) {
    let detail = '';
    try {
      const errJson = (await res.json()) as { error?: { message?: unknown } | string };
      const msg = typeof errJson?.error === 'string' ? errJson.error : errJson?.error?.message;
      if (typeof msg === 'string' && msg.trim()) detail = `：${msg.trim().slice(0, 140)}`;
    } catch {
      // Ignore non-JSON error body.
    }
    throw new LLMError('UPSTREAM', `获取模型列表失败（HTTP ${res.status}）${detail}`, res.status);
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new LLMError('BAD_RESPONSE', '模型列表接口返回了非 JSON 内容', res.status);
  }

  const rawList = Array.isArray((payload as { data?: unknown[] })?.data)
    ? (payload as { data: unknown[] }).data
    : Array.isArray((payload as { models?: unknown[] })?.models)
      ? (payload as { models: unknown[] }).models
      : null;

  if (!rawList) {
    throw new LLMError('BAD_RESPONSE', '模型列表响应缺少 data 数组', res.status);
  }

  const seen = new Set<string>();
  const models: LLMModelOption[] = [];
  for (const entry of rawList) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as { id?: unknown; name?: unknown; owned_by?: unknown; context_length?: unknown };
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      label: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : undefined,
      ownedBy: typeof item.owned_by === 'string' ? item.owned_by : undefined,
      contextWindow: typeof item.context_length === 'number' ? item.context_length : undefined,
    });
  }

  models.sort((a, b) => a.id.localeCompare(b.id));
  return models;
}

export function getSuggestedModelOptions(providerId?: LLMProviderId, activeModel?: string): LLMModelOption[] {
  const preset = getProviderPreset(providerId);
  const ids = new Set<string>();
  const list: LLMModelOption[] = [];
  if (activeModel?.trim()) {
    ids.add(activeModel.trim());
    list.push({ id: activeModel.trim() });
  }
  for (const id of preset?.suggestedModels ?? []) {
    if (!ids.has(id)) {
      ids.add(id);
      list.push({ id });
    }
  }
  return list;
}

function createDirectClient(cfg: ByokConfig, fetchImpl?: FetchImpl): LLMClient {
  const normalizedBaseUrl = normalizeBaseUrl(cfg.baseUrl);
  const directFetch = resolveDirectFetch(normalizedBaseUrl, cfg.providerId, cfg.useLocalProxy, fetchImpl);
  return {
    async chat(options: LLMCallOptions) {
      if (!isAllowedBaseUrl(normalizedBaseUrl, cfg.providerId)) {
        throw new LLMError('NOT_CONFIGURED', 'Base URL 格式无效（公网需使用 https，本地或内网网关支持 http）');
      }
      if (!isApiKeyOptional(normalizedBaseUrl, cfg.providerId) && !cfg.apiKey.trim()) {
        throw new LLMError('NOT_CONFIGURED', '未配置大模型 API Key');
      }
      const resolvedModel = options.model?.trim() || cfg.model;
      const wantsStream = Boolean(options.onDelta || options.onReasoningDelta);
      try {
        const text = await callOpenAICompatible({
          baseUrl: normalizedBaseUrl,
          apiKey: cfg.apiKey,
          model: resolvedModel,
          messages: options.messages,
          temperature: options.temperature,
          jsonMode: options.jsonMode,
          stream: wantsStream,
          onDelta: options.onDelta,
          onReasoningDelta: options.onReasoningDelta,
          signal: options.signal,
          fetchImpl: directFetch,
        });
        return { text, ...(options.model ? { model: resolvedModel } : {}) };
      } catch (error) {
        throw toLLMError(error);
      }
    },

    async listModels(options) {
      return fetchOpenAIModels(normalizedBaseUrl, cfg.apiKey, {
        signal: options?.signal,
        fetchImpl,
        providerId: cfg.providerId,
        useLocalProxy: cfg.useLocalProxy,
      });
    },

    async testConnection(options) {
      const start = Date.now();
      const targetModel = options?.model?.trim() || cfg.model;
      if (!isAllowedBaseUrl(normalizedBaseUrl, cfg.providerId)) {
        return {
          ok: false,
          latencyMs: Math.max(1, Date.now() - start),
          model: targetModel,
          message: 'Base URL 格式无效',
        };
      }
      try {
        await callOpenAICompatible({
          baseUrl: normalizedBaseUrl,
          apiKey: cfg.apiKey,
          model: targetModel,
          messages: [{ role: 'user', content: 'ping' }],
          temperature: 0,
          jsonMode: false,
          signal: options?.signal,
          fetchImpl: directFetch,
        });
        return { ok: true, latencyMs: Math.max(1, Date.now() - start), model: targetModel };
      } catch (error) {
        const mapped = toLLMError(error);
        return {
          ok: false,
          latencyMs: Math.max(1, Date.now() - start),
          model: targetModel,
          message: mapped.message,
        };
      }
    },
  };
}

function createProxyClient(endpoint: string, fetchImpl: FetchImpl = fetch): LLMClient {
  return {
    async chat(options: LLMCallOptions) {
      const localQuota = readLocalBrowserQuota();
      if (localQuota?.limit !== undefined && localQuota.used >= localQuota.limit) {
        throw new LLMError('QUOTA_EXCEEDED', '今日浏览器免费额度已用完，请明天再试或切换为自备 API Key', 429);
      }

      const wantsStream = Boolean(options.onDelta || options.onReasoningDelta);
      let res: Response;
      try {
        const payloadBody: Record<string, unknown> = {
          action: options.action,
          messages: options.messages,
          temperature: options.temperature,
          jsonMode: options.jsonMode,
        };
        const trimmedModel = options.model?.trim();
        if (trimmedModel && trimmedModel !== 'site-default') payloadBody.model = trimmedModel;
        if (wantsStream) payloadBody.stream = true;
        res = await fetchImpl(endpoint, {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            ...browserQuotaHeaders(),
            ...(wantsStream ? { Accept: 'text/event-stream, application/json' } : {}),
          },
          body: JSON.stringify(payloadBody),
          signal: options.signal,
        });
      } catch (error) {
        if (options.signal?.aborted) throw new LLMError('ABORTED', '请求已取消');
        throw toLLMError(error);
      }

      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
      if (res.ok && wantsStream && contentType.includes('text/event-stream') && res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let accumulated = '';
        let finalText: string | undefined;
        let remainingQuota: number | undefined;
        let model: string | undefined;
        let streamError: LLMError | null = null;

        const handleLine = (rawLine: string) => {
          const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
          if (!line.startsWith('data:')) return;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') return;
          let evt: {
            type?: unknown;
            delta?: unknown;
            text?: unknown;
            error?: unknown;
            remainingQuota?: unknown;
            model?: unknown;
          };
          try {
            evt = JSON.parse(payload);
          } catch {
            return;
          }
          if (typeof evt.remainingQuota === 'number') remainingQuota = evt.remainingQuota;
          if (typeof evt.model === 'string') model = evt.model;
          if (evt.type === 'delta' && typeof evt.delta === 'string') {
            accumulated += evt.delta;
            options.onDelta?.(evt.delta);
          } else if (evt.type === 'reasoning' && typeof evt.delta === 'string') {
            options.onReasoningDelta?.(evt.delta);
          } else if (evt.type === 'done' && typeof evt.text === 'string') {
            finalText = evt.text;
          } else if (evt.type === 'error') {
            const code = (typeof evt.error === 'string' && SERVER_ERROR_MAP[evt.error]) || 'UPSTREAM';
            streamError = new LLMError(code, `云函数流式调用失败：${String(evt.error ?? 'upstream_error')}`, 502);
          }
        };

        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl = buffer.indexOf('\n');
            while (nl !== -1) {
              handleLine(buffer.slice(0, nl));
              buffer = buffer.slice(nl + 1);
              nl = buffer.indexOf('\n');
            }
          }
          buffer += decoder.decode();
          if (buffer.trim()) handleLine(buffer);
        } catch (error) {
          if (options.signal?.aborted) throw new LLMError('ABORTED', '请求已取消');
          throw toLLMError(error);
        } finally {
          reader.releaseLock();
        }

        if (streamError) throw streamError;
        const text = finalText ?? accumulated;
        if (!text) {
          throw new LLMError('BAD_RESPONSE', '云函数流式响应缺少文本内容', res.status);
        }
        return {
          text,
          remainingQuota: recordLocalBrowserUsage(remainingQuota),
          ...(model ? { model } : {}),
        };
      }

      let data: {
        ok?: boolean;
        text?: unknown;
        error?: unknown;
        remainingQuota?: unknown;
        dailyLimit?: unknown;
        model?: unknown;
      };
      try {
        const payload: unknown = await res.json();
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          throw new TypeError('云函数响应必须为 JSON 对象');
        }
        data = payload;
      } catch {
        throw new LLMError(
          res.status === 401 || res.status === 403 ? 'FORBIDDEN' : 'BAD_RESPONSE',
          '云函数返回了非 JSON 内容',
          res.status,
        );
      }

      if (!res.ok || data.ok !== true) {
        const code = (typeof data.error === 'string' && SERVER_ERROR_MAP[data.error]) || 'UPSTREAM';
        if (code === 'QUOTA_EXCEEDED') {
          markLocalQuotaExhausted(typeof data.dailyLimit === 'number' ? data.dailyLimit : undefined);
        }
        throw new LLMError(code, `云函数调用失败：${String(data.error ?? res.status)}`, res.status);
      }
      if (typeof data.text !== 'string') {
        throw new LLMError('BAD_RESPONSE', '云函数返回缺少 text 字段', res.status);
      }
      if (data.text) options.onDelta?.(data.text);
      const reconciledRemaining = recordLocalBrowserUsage(
        typeof data.remainingQuota === 'number' ? data.remainingQuota : undefined,
      );
      return {
        text: data.text,
        remainingQuota: reconciledRemaining,
        ...(typeof data.model === 'string' ? { model: data.model } : {}),
      };
    },

    async listModels(options) {
      try {
        const res = await fetchImpl(MODELS_ENDPOINT, {
          method: 'GET',
          credentials: 'same-origin',
          signal: options?.signal,
        });
        if (!res.ok) return SITE_DEFAULT_MODELS;
        const data = (await res.json()) as { ok?: boolean; models?: LLMModelOption[] };
        if (data.ok && Array.isArray(data.models) && data.models.length > 0) return data.models;
      } catch {
        // Local dev without edge proxy falls back gracefully.
      }
      return SITE_DEFAULT_MODELS;
    },

    async testConnection(options) {
      const start = Date.now();
      try {
        const res = await fetchImpl(QUOTA_ENDPOINT, {
          credentials: 'same-origin',
          headers: browserQuotaHeaders(),
          signal: options?.signal,
        });
        const data = (await res.json()) as { ok?: boolean; remainingQuota?: unknown; dailyLimit?: unknown };
        if (res.ok && data.ok) {
          const status =
            typeof data.remainingQuota === 'number'
              ? reconcileQuotaStatus(
                  data.remainingQuota,
                  typeof data.dailyLimit === 'number' ? data.dailyLimit : undefined,
                )
              : undefined;
          return {
            ok: true,
            latencyMs: Math.max(1, Date.now() - start),
            model: 'site-default',
            message: status
              ? `今日剩余免费额度 ${status.remainingQuota} / ${status.dailyLimit} 次`
              : '站点默认服务可用',
          };
        }
        return { ok: false, latencyMs: Math.max(1, Date.now() - start), message: '站点默认代理暂不可用，可切换自备 API Key' };
      } catch {
        return { ok: false, latencyMs: Math.max(1, Date.now() - start), message: '未连接到站点默认代理，请在上方选择服务商并填写 Key' };
      }
    },
  };
}

export function createLLMClient(config: LLMClientConfig): LLMClient {
  switch (config.mode) {
    case 'proxy':
      return createProxyClient(config.endpoint ?? PROXY_ENDPOINT, config.fetchImpl);
    case 'byok':
      return createDirectClient(config, config.fetchImpl);
    case 'node': {
      const env =
        config.env ??
        (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ??
        {};
      return createDirectClient(
        {
          apiKey: env.LLM_API_KEY ?? '',
          baseUrl: env.LLM_BASE_URL || DEFAULT_NODE_BASE_URL,
          model: env.LLM_MODEL || DEFAULT_NODE_MODEL,
        },
        config.fetchImpl,
      );
    }
  }
}

export function loadByokConfig(): ByokConfig | null {
  try {
    const raw = localStorage.getItem(BYOK_STORAGE_KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw) as Partial<ByokConfig>;
    if (typeof cfg.baseUrl !== 'string' || !cfg.baseUrl || typeof cfg.model !== 'string' || !cfg.model) return null;
    const providerId = cfg.providerId && PROVIDER_PRESETS.some((p) => p.id === cfg.providerId)
      ? cfg.providerId
      : inferProviderId(cfg.baseUrl);
    const apiKey = typeof cfg.apiKey === 'string' ? cfg.apiKey : '';
    if (!isApiKeyOptional(cfg.baseUrl, providerId) && !apiKey) return null;
    const cachedModels = Array.isArray(cfg.cachedModels)
      ? cfg.cachedModels.filter((m): m is LLMModelOption => Boolean(m && typeof m.id === 'string'))
      : undefined;
    return {
      providerId,
      apiKey,
      baseUrl: cfg.baseUrl,
      model: cfg.model,
      cachedModels,
      ...(typeof cfg.useLocalProxy === 'boolean' ? { useLocalProxy: cfg.useLocalProxy } : {}),
    };
  } catch {
    return null;
  }
}

export function saveByokConfig(cfg: ByokConfig | null): void {
  if (cfg) localStorage.setItem(BYOK_STORAGE_KEY, JSON.stringify(cfg));
  else localStorage.removeItem(BYOK_STORAGE_KEY);
}

export function loadAppPreferences(): AppPreferences {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return { enableWebResearch: true, defaultClockSpeed: 'realtime' };
    const parsed = JSON.parse(raw) as Partial<AppPreferences>;
    return {
      enableWebResearch: typeof parsed.enableWebResearch === 'boolean' ? parsed.enableWebResearch : true,
      defaultClockSpeed: parsed.defaultClockSpeed === 'slow' ? 'slow' : 'realtime',
    };
  } catch {
    return { enableWebResearch: true, defaultClockSpeed: 'realtime' };
  }
}

export function saveAppPreferences(prefs: AppPreferences): void {
  try {
    localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage failures.
  }
}

// Re-reads BYOK settings on every call so the settings dialog and inline model switch take effect immediately.
export function createBrowserLLMClient(): LLMClient {
  const proxy = createProxyClient(PROXY_ENDPOINT);
  return {
    chat(options) {
      const byok = loadByokConfig();
      return byok ? createDirectClient(byok).chat(options) : proxy.chat(options);
    },
    listModels(options) {
      const byok = loadByokConfig();
      return byok ? createDirectClient(byok).listModels!(options) : proxy.listModels!(options);
    },
    testConnection(options) {
      const byok = loadByokConfig();
      return byok ? createDirectClient(byok).testConnection!(options) : proxy.testConnection!(options);
    },
  };
}

export function loadSiteModel(): string {
  const storage = getSafeLocalStorage();
  const saved = storage?.getItem(SITE_MODEL_STORAGE_KEY)?.trim();
  return saved || SITE_DEFAULT_MODELS[0].id;
}

export function saveSiteModel(modelId: string): void {
  const storage = getSafeLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(SITE_MODEL_STORAGE_KEY, modelId);
  } catch {
    // Ignore storage failures.
  }
}

export async function fetchSiteModels(fetchImpl: FetchImpl = fetch): Promise<LLMModelOption[]> {
  try {
    const res = await fetchImpl(MODELS_ENDPOINT, { method: 'GET', credentials: 'same-origin' });
    if (!res.ok) return SITE_DEFAULT_MODELS;
    const data = (await res.json()) as { ok?: boolean; models?: LLMModelOption[] };
    if (data.ok && Array.isArray(data.models) && data.models.length > 0) return data.models;
  } catch {
    // Fall back to curated site-default models when running without edge function.
  }
  return SITE_DEFAULT_MODELS;
}

export async function fetchQuotaStatus(fetchImpl: FetchImpl = fetch): Promise<QuotaStatus | undefined> {
  try {
    const res = await fetchImpl(QUOTA_ENDPOINT, {
      credentials: 'same-origin',
      headers: browserQuotaHeaders(),
    });
    const data = (await res.json()) as { ok?: boolean; remainingQuota?: unknown; dailyLimit?: unknown };
    if (!data.ok || typeof data.remainingQuota !== 'number') return undefined;
    return reconcileQuotaStatus(
      data.remainingQuota,
      typeof data.dailyLimit === 'number' ? data.dailyLimit : undefined,
    );
  } catch {
    return undefined;
  }
}

export async function fetchRemainingQuota(): Promise<number | undefined> {
  const status = await fetchQuotaStatus();
  return status?.remainingQuota;
}
