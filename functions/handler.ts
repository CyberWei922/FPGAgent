import { callOpenAICompatible, UpstreamError, type CompatMessage } from './openaiCompat.ts';
import { DailyLimiter } from './rateLimit.ts';

export interface HandlerDeps {
  getEnv: (name: string) => string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const ACTIONS = new Set(['plan', 'generate', 'repair', 'diagnose', 'inject_bug']);
const ROLES = new Set(['system', 'user', 'assistant']);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGES = 20;
const MAX_TOTAL_CHARS = 48_000;
const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_MODEL = 'qwen3.8-flash';
const DEFAULT_SITE_MODELS = ['qwen3.8-flash', 'deepseek-v4.1-flash'];
const DEFAULT_FALLBACK_BASE_URL = 'https://developer.amd.com.cn/radeon/api/v1';
const DEFAULT_FALLBACK_MODEL = 'Qwen3.8-Flash-Next';
const DEFAULT_DAILY_LIMIT = 8;
const BROWSER_COOKIE_NAME = 'fpgagent_bid';
const BROWSER_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;

const MODEL_LABELS: Record<string, { label: string; ownedBy: string }> = {
  'qwen3.8-flash': { label: 'Qwen 3.8 Flash', ownedBy: '站点默认 · 推荐' },
  'qwen3.7-flash': { label: 'Qwen 3.7 Flash', ownedBy: '站点默认' },
  'deepseek-v4.1-flash': { label: 'DeepSeek V4.1 Flash', ownedBy: '站点默认' },
  'deepseek-v4-flash': { label: 'DeepSeek V4 Flash', ownedBy: '站点默认' },
};

const FALLBACK_MODEL_MAP: Record<string, string> = {
  'qwen3.8-flash': 'Qwen3.8-Flash-Next',
  'qwen3.7-flash': 'Qwen3.8-Flash-Next',
  'deepseek-v4.1-flash': 'DeepSeek-V4.1-Flash-1017',
  'deepseek-v4-flash': 'DeepSeek-V4.1-Flash-1017',
  'deepseek-chat': 'DeepSeek-V4.1-Flash-1017',
};

type ErrorCode =
  | 'not_found'
  | 'method_not_allowed'
  | 'forbidden_origin'
  | 'invalid_request'
  | 'payload_too_large'
  | 'quota_exceeded'
  | 'service_not_configured'
  | 'upstream_timeout'
  | 'upstream_error';

const NO_STORE = { 'Cache-Control': 'no-store' };

function fail(
  error: ErrorCode,
  status: number,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return Response.json({ ok: false, error, ...extra }, { status, headers: { ...NO_STORE, ...headers } });
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || request.headers.get('x-real-ip')?.trim() || 'unknown';
}

function parseCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) {
      const value = part.slice(eq + 1).trim();
      return BROWSER_ID_RE.test(value) ? value : undefined;
    }
  }
  return undefined;
}

function resolveBrowserIdentity(request: Request): {
  keys: string[];
  setCookieHeader?: string;
} {
  const cookieId = parseCookie(request.headers.get('cookie'), BROWSER_COOKIE_NAME);
  const rawHeaderId = request.headers.get('x-browser-id')?.trim();
  const headerId = rawHeaderId && BROWSER_ID_RE.test(rawHeaderId) ? rawHeaderId : undefined;

  const keys: string[] = [];
  if (cookieId) keys.push(cookieId);
  if (headerId && headerId !== cookieId) keys.push(headerId);

  let setCookieHeader: string | undefined;
  if (!cookieId) {
    const issued = headerId ?? crypto.randomUUID();
    if (keys.length === 0) keys.push(issued);
    const isHttps = new URL(request.url).protocol === 'https:';
    setCookieHeader = `${BROWSER_COOKIE_NAME}=${issued}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${isHttps ? '; Secure' : ''}`;
  }

  return { keys, setCookieHeader };
}

function originOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

// Spoofable outside browsers: blocks hot-linking only; the per-IP and per-browser limits are the real guards.
function originAllowed(request: Request, allowList: string[]): boolean {
  if (allowList.length === 0) return true;
  const origin = originOf(request.headers.get('origin')) ?? originOf(request.headers.get('referer'));
  return origin !== null && allowList.includes(origin);
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function resolveAllowedModels(defaultModel: string, rawModels?: string): string[] {
  const fromEnv = (rawModels ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const seeds = fromEnv.length > 0 ? fromEnv : [defaultModel, ...DEFAULT_SITE_MODELS];
  const unique: string[] = [];
  if (!seeds.includes(defaultModel)) unique.push(defaultModel);
  for (const id of seeds) {
    if (!unique.includes(id)) unique.push(id);
  }
  return unique;
}

function resolveFallbackModel(requestedModel: string, envFallbackModel?: string): string {
  if (envFallbackModel?.trim()) return envFallbackModel.trim();
  return FALLBACK_MODEL_MAP[requestedModel.toLowerCase()] ?? DEFAULT_FALLBACK_MODEL;
}

interface AgentRequest {
  messages: CompatMessage[];
  model?: string;
  temperature?: number;
  jsonMode?: boolean;
  stream?: boolean;
}

interface UpstreamChannel {
  baseUrl: string;
  apiKey: string;
  model: string;
}

function parseAgentRequest(raw: unknown): AgentRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const { action, messages, model, temperature, jsonMode, stream } = raw as Record<string, unknown>;
  if (typeof action !== 'string' || !ACTIONS.has(action)) return null;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) return null;

  let total = 0;
  const clean: CompatMessage[] = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') return null;
    const { role, content } = m as Record<string, unknown>;
    if (typeof role !== 'string' || !ROLES.has(role) || typeof content !== 'string') return null;
    total += content.length;
    clean.push({ role: role as CompatMessage['role'], content });
  }
  if (total > MAX_TOTAL_CHARS) return null;

  if (model !== undefined && (typeof model !== 'string' || model.trim().length === 0 || model.trim().length > 80)) {
    return null;
  }
  if (temperature !== undefined && (typeof temperature !== 'number' || temperature < 0 || temperature > 1.5)) {
    return null;
  }
  if (jsonMode !== undefined && typeof jsonMode !== 'boolean') return null;
  if (stream !== undefined && typeof stream !== 'boolean') return null;
  return {
    messages: clean,
    model: typeof model === 'string' ? model.trim() : undefined,
    temperature,
    jsonMode,
    stream,
  };
}

export function createHandler(deps: HandlerDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const ipLimit = parsePositiveInt(deps.getEnv('DAILY_LIMIT_PER_IP'), DEFAULT_DAILY_LIMIT);
  const browserLimit = parsePositiveInt(deps.getEnv('DAILY_LIMIT_PER_BROWSER'), ipLimit);
  const effectiveDailyLimit = Math.min(ipLimit, browserLimit);
  const ipLimiter = new DailyLimiter(ipLimit);
  const browserLimiter = new DailyLimiter(browserLimit);
  const allowList = (deps.getEnv('ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  function remainingFor(ip: string, browserKeys: string[], ts: number): number {
    let min = ipLimiter.remaining(ip, ts);
    for (const key of browserKeys) {
      min = Math.min(min, browserLimiter.remaining(key, ts));
    }
    return min;
  }

  function takeQuota(
    ip: string,
    browserKeys: string[],
    ts: number,
  ): { allowed: boolean; remaining: number; limitReason?: 'ip' | 'browser' } {
    if (ipLimiter.remaining(ip, ts) <= 0) {
      return { allowed: false, remaining: 0, limitReason: 'ip' };
    }
    for (const key of browserKeys) {
      if (browserLimiter.remaining(key, ts) <= 0) {
        return { allowed: false, remaining: 0, limitReason: 'browser' };
      }
    }
    const ipResult = ipLimiter.take(ip, ts);
    let minRemaining = ipResult.remaining;
    for (const key of browserKeys) {
      const browserResult = browserLimiter.take(key, ts);
      minRemaining = Math.min(minRemaining, browserResult.remaining);
    }
    return { allowed: true, remaining: minRemaining };
  }

  function resolveChannels(requestedModel?: string): { selectedModel: string; channels: UpstreamChannel[] } {
    const defaultModel = deps.getEnv('LLM_MODEL')?.trim() || DEFAULT_MODEL;
    const allowedModels = resolveAllowedModels(defaultModel, deps.getEnv('LLM_MODELS'));
    const selectedModel = requestedModel && allowedModels.includes(requestedModel) ? requestedModel : defaultModel;

    const channels: UpstreamChannel[] = [];
    const primaryKey = deps.getEnv('LLM_API_KEY')?.trim();
    if (primaryKey) {
      channels.push({
        baseUrl: deps.getEnv('LLM_BASE_URL')?.trim() || DEFAULT_BASE_URL,
        apiKey: primaryKey,
        model: selectedModel,
      });
    }

    const fallbackKey = deps.getEnv('FALLBACK_LLM_API_KEY')?.trim();
    if (fallbackKey) {
      channels.push({
        baseUrl: deps.getEnv('FALLBACK_LLM_BASE_URL')?.trim() || DEFAULT_FALLBACK_BASE_URL,
        apiKey: fallbackKey,
        model: resolveFallbackModel(selectedModel, deps.getEnv('FALLBACK_LLM_MODEL')),
      });
    }

    return { selectedModel, channels };
  }

  return async (request: Request) => {
    const path = new URL(request.url).pathname.replace(/\/+$/, '');

    if (path.endsWith('/models')) {
      if (request.method !== 'GET') return fail('method_not_allowed', 405, {}, { Allow: 'GET' });
      const defaultModel = deps.getEnv('LLM_MODEL')?.trim() || DEFAULT_MODEL;
      const allowedModels = resolveAllowedModels(defaultModel, deps.getEnv('LLM_MODELS'));
      const models = allowedModels.map((id) => ({
        id,
        label: MODEL_LABELS[id]?.label ?? id,
        ownedBy: MODEL_LABELS[id]?.ownedBy ?? '站点默认',
      }));
      return Response.json({ ok: true, models }, { headers: NO_STORE });
    }

    if (path.endsWith('/quota')) {
      if (request.method !== 'GET') return fail('method_not_allowed', 405, {}, { Allow: 'GET' });
      const browser = resolveBrowserIdentity(request);
      const headers: Record<string, string> = { ...NO_STORE };
      if (browser.setCookieHeader) headers['Set-Cookie'] = browser.setCookieHeader;
      return Response.json(
        {
          ok: true,
          remainingQuota: remainingFor(clientIp(request), browser.keys, now()),
          dailyLimit: effectiveDailyLimit,
        },
        { headers },
      );
    }

    if (!path.endsWith('/agent')) return fail('not_found', 404);
    if (request.method !== 'POST') return fail('method_not_allowed', 405, {}, { Allow: 'POST' });
    if (!originAllowed(request, allowList)) return fail('forbidden_origin', 403);

    const declaredLength = Number(request.headers.get('content-length') ?? 0);
    if (declaredLength > MAX_BODY_BYTES) return fail('payload_too_large', 413);
    const text = await request.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return fail('payload_too_large', 413);

    let parsed: AgentRequest | null = null;
    try {
      parsed = parseAgentRequest(JSON.parse(text));
    } catch {
      parsed = null;
    }
    if (!parsed) return fail('invalid_request', 400);

    const { channels } = resolveChannels(parsed.model);
    if (channels.length === 0) return fail('service_not_configured', 503);

    const browser = resolveBrowserIdentity(request);
    const cookieHeaders: Record<string, string> = browser.setCookieHeader
      ? { 'Set-Cookie': browser.setCookieHeader }
      : {};

    const quota = takeQuota(clientIp(request), browser.keys, now());
    if (!quota.allowed) {
      return fail(
        'quota_exceeded',
        429,
        { remainingQuota: 0, dailyLimit: effectiveDailyLimit, limitReason: quota.limitReason },
        cookieHeaders,
      );
    }

    if (parsed.stream) {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          const sendEvent = (payload: Record<string, unknown>) => {
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
            } catch {
              // Ignore writes after stream closed by client disconnect.
            }
          };

          let emittedContent = false;
          let lastError: unknown;
          let succeeded = false;

          for (let i = 0; i < channels.length; i++) {
            const channel = channels[i];
            sendEvent({ type: 'meta', remainingQuota: quota.remaining, model: channel.model });
            try {
              const content = await callOpenAICompatible({
                baseUrl: channel.baseUrl,
                apiKey: channel.apiKey,
                model: channel.model,
                messages: parsed.messages,
                temperature: parsed.temperature,
                jsonMode: parsed.jsonMode,
                stream: true,
                onDelta: (delta) => {
                  emittedContent = true;
                  sendEvent({ type: 'delta', delta });
                },
                onReasoningDelta: (delta) => {
                  emittedContent = true;
                  sendEvent({ type: 'reasoning', delta });
                },
                signal: request.signal,
                fetchImpl: deps.fetchImpl,
              });
              sendEvent({ type: 'done', text: content, remainingQuota: quota.remaining, model: channel.model });
              succeeded = true;
              break;
            } catch (error) {
              lastError = error;
              if (request.signal.aborted || emittedContent || i === channels.length - 1) {
                break;
              }
            }
          }

          if (!succeeded && !request.signal.aborted) {
            const timeout = lastError instanceof UpstreamError && lastError.kind === 'timeout';
            sendEvent({
              type: 'error',
              error: timeout ? 'upstream_timeout' : 'upstream_error',
              remainingQuota: quota.remaining,
            });
          }

          try {
            controller.close();
          } catch {
            // Ignore already-closed controller.
          }
        },
      });
      return new Response(body, {
        status: 200,
        headers: {
          ...NO_STORE,
          ...cookieHeaders,
          'Content-Type': 'text/event-stream; charset=utf-8',
          Connection: 'keep-alive',
        },
      });
    }

    let lastError: unknown;
    for (let i = 0; i < channels.length; i++) {
      const channel = channels[i];
      try {
        const content = await callOpenAICompatible({
          baseUrl: channel.baseUrl,
          apiKey: channel.apiKey,
          model: channel.model,
          messages: parsed.messages,
          temperature: parsed.temperature,
          jsonMode: parsed.jsonMode,
          signal: request.signal,
          fetchImpl: deps.fetchImpl,
        });
        return Response.json(
          { ok: true, text: content, remainingQuota: quota.remaining },
          { headers: { ...NO_STORE, ...cookieHeaders } },
        );
      } catch (error) {
        lastError = error;
        if (request.signal.aborted || i === channels.length - 1) break;
      }
    }

    const timeout = lastError instanceof UpstreamError && lastError.kind === 'timeout';
    return fail(
      timeout ? 'upstream_timeout' : 'upstream_error',
      timeout ? 504 : 502,
      { remainingQuota: quota.remaining },
      cookieHeaders,
    );
  };
}
