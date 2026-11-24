import { callOpenAICompatible, UpstreamError } from '../../functions/openaiCompat.ts';
import {
  LLMError,
  type LLMCallOptions,
  type LLMClient,
  type LLMErrorCode,
} from '../types/contracts';

export interface ByokConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

type FetchImpl = typeof fetch;

export type LLMClientConfig =
  | { mode: 'proxy'; endpoint?: string; fetchImpl?: FetchImpl }
  | ({ mode: 'byok'; fetchImpl?: FetchImpl } & ByokConfig)
  | { mode: 'node'; env?: Record<string, string | undefined>; fetchImpl?: FetchImpl };

export const PROXY_ENDPOINT = '/functions/v1/app/agent';
export const QUOTA_ENDPOINT = '/functions/v1/app/quota';
const BYOK_STORAGE_KEY = 'vibefpga.byok';
const DEFAULT_NODE_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_NODE_MODEL = 'qwen-plus';

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

function isAllowedBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(url.hostname);
  } catch {
    return false;
  }
}

function createDirectClient(cfg: ByokConfig, fetchImpl?: FetchImpl): LLMClient {
  return {
    async chat(options: LLMCallOptions) {
      if (!cfg.apiKey) throw new LLMError('NOT_CONFIGURED', '未配置大模型 API Key');
      if (!isAllowedBaseUrl(cfg.baseUrl)) {
        throw new LLMError('NOT_CONFIGURED', 'Base URL 必须是 https 地址');
      }
      try {
        const text = await callOpenAICompatible({
          ...cfg,
          messages: options.messages,
          temperature: options.temperature,
          jsonMode: options.jsonMode,
          signal: options.signal,
          fetchImpl,
        });
        return { text };
      } catch (error) {
        throw toLLMError(error);
      }
    },
  };
}

function createProxyClient(endpoint: string, fetchImpl: FetchImpl = fetch): LLMClient {
  return {
    async chat(options: LLMCallOptions) {
      let res: Response;
      try {
        res = await fetchImpl(endpoint, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: options.action,
            messages: options.messages,
            temperature: options.temperature,
            jsonMode: options.jsonMode,
          }),
          signal: options.signal,
        });
      } catch (error) {
        if (options.signal?.aborted) throw new LLMError('ABORTED', '请求已取消');
        throw toLLMError(error);
      }

      let data: { ok?: boolean; text?: unknown; error?: unknown; remainingQuota?: unknown };
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
        throw new LLMError(code, `云函数调用失败：${String(data.error ?? res.status)}`, res.status);
      }
      if (typeof data.text !== 'string') {
        throw new LLMError('BAD_RESPONSE', '云函数返回缺少 text 字段', res.status);
      }
      return {
        text: data.text,
        remainingQuota: typeof data.remainingQuota === 'number' ? data.remainingQuota : undefined,
      };
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
    if (typeof cfg.apiKey !== 'string' || !cfg.apiKey) return null;
    if (typeof cfg.baseUrl !== 'string' || typeof cfg.model !== 'string') return null;
    return { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: cfg.model };
  } catch {
    return null;
  }
}

export function saveByokConfig(cfg: ByokConfig | null): void {
  if (cfg) localStorage.setItem(BYOK_STORAGE_KEY, JSON.stringify(cfg));
  else localStorage.removeItem(BYOK_STORAGE_KEY);
}

// Re-reads BYOK settings on every call so the settings dialog takes effect immediately.
export function createBrowserLLMClient(): LLMClient {
  const proxy = createProxyClient(PROXY_ENDPOINT);
  return {
    chat(options) {
      const byok = loadByokConfig();
      return byok ? createDirectClient(byok).chat(options) : proxy.chat(options);
    },
  };
}

export async function fetchRemainingQuota(): Promise<number | undefined> {
  try {
    const res = await fetch(QUOTA_ENDPOINT, { credentials: 'same-origin' });
    const data = (await res.json()) as { ok?: boolean; remainingQuota?: unknown };
    return data.ok && typeof data.remainingQuota === 'number' ? data.remainingQuota : undefined;
  } catch {
    return undefined;
  }
}
