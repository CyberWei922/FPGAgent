export interface CompatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompatRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: CompatMessage[];
  temperature?: number;
  jsonMode?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export type UpstreamErrorKind = 'timeout' | 'aborted' | 'network' | 'upstream' | 'bad_response';

export class UpstreamError extends Error {
  readonly kind: UpstreamErrorKind;
  readonly status?: number;

  constructor(kind: UpstreamErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'UpstreamError';
    this.kind = kind;
    this.status = status;
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;

export async function callOpenAICompatible(req: CompatRequest): Promise<string> {
  const fetchImpl = req.fetchImpl ?? fetch;
  const timeoutSignal = AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = req.signal ? AbortSignal.any([req.signal, timeoutSignal]) : timeoutSignal;

  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
  };
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.jsonMode) body.response_format = { type: 'json_object' };

  let res: Response;
  try {
    res = await fetchImpl(`${req.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${req.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (req.signal?.aborted) throw new UpstreamError('aborted', '请求已取消');
    if (timeoutSignal.aborted) throw new UpstreamError('timeout', '大模型响应超时');
    throw new UpstreamError('network', error instanceof Error ? error.message : '网络错误');
  }

  if (!res.ok) {
    throw new UpstreamError('upstream', `大模型服务返回 HTTP ${res.status}`, res.status);
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new UpstreamError('bad_response', '大模型返回的不是 JSON');
  }

  const content = (data as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message
    ?.content;
  if (typeof content !== 'string') {
    throw new UpstreamError('bad_response', '大模型返回缺少 choices[0].message.content');
  }
  return content;
}
