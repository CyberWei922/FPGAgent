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
const DEFAULT_MODEL = 'qwen-plus';
const DEFAULT_DAILY_LIMIT = 8;

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

function fail(error: ErrorCode, status: number, extra: Record<string, unknown> = {}, headers = {}) {
  return Response.json({ ok: false, error, ...extra }, { status, headers: { ...NO_STORE, ...headers } });
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || request.headers.get('x-real-ip')?.trim() || 'unknown';
}

function originOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

// Spoofable outside browsers: blocks hot-linking only; the per-IP limit is the real guard.
function originAllowed(request: Request, allowList: string[]): boolean {
  if (allowList.length === 0) return true;
  const origin = originOf(request.headers.get('origin')) ?? originOf(request.headers.get('referer'));
  return origin !== null && allowList.includes(origin);
}

interface AgentRequest {
  messages: CompatMessage[];
  temperature?: number;
  jsonMode?: boolean;
}

function parseAgentRequest(raw: unknown): AgentRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const { action, messages, temperature, jsonMode } = raw as Record<string, unknown>;
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

  if (temperature !== undefined && (typeof temperature !== 'number' || temperature < 0 || temperature > 1.5)) {
    return null;
  }
  if (jsonMode !== undefined && typeof jsonMode !== 'boolean') return null;
  return { messages: clean, temperature, jsonMode };
}

export function createHandler(deps: HandlerDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const limitRaw = Number(deps.getEnv('DAILY_LIMIT_PER_IP'));
  const limiter = new DailyLimiter(Number.isInteger(limitRaw) && limitRaw > 0 ? limitRaw : DEFAULT_DAILY_LIMIT);
  const allowList = (deps.getEnv('ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  return async (request: Request) => {
    const path = new URL(request.url).pathname.replace(/\/+$/, '');

    if (path.endsWith('/quota')) {
      if (request.method !== 'GET') return fail('method_not_allowed', 405, {}, { Allow: 'GET' });
      return Response.json(
        { ok: true, remainingQuota: limiter.remaining(clientIp(request), now()) },
        { headers: NO_STORE },
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

    const apiKey = deps.getEnv('LLM_API_KEY');
    if (!apiKey) return fail('service_not_configured', 503);

    const quota = limiter.take(clientIp(request), now());
    if (!quota.allowed) return fail('quota_exceeded', 429, { remainingQuota: 0 });

    try {
      const content = await callOpenAICompatible({
        baseUrl: deps.getEnv('LLM_BASE_URL') || DEFAULT_BASE_URL,
        apiKey,
        model: deps.getEnv('LLM_MODEL') || DEFAULT_MODEL,
        messages: parsed.messages,
        temperature: parsed.temperature,
        jsonMode: parsed.jsonMode,
        signal: request.signal,
        fetchImpl: deps.fetchImpl,
      });
      return Response.json(
        { ok: true, text: content, remainingQuota: quota.remaining },
        { headers: NO_STORE },
      );
    } catch (error) {
      const timeout = error instanceof UpstreamError && error.kind === 'timeout';
      return fail(timeout ? 'upstream_timeout' : 'upstream_error', timeout ? 504 : 502, {
        remainingQuota: quota.remaining,
      });
    }
  };
}
