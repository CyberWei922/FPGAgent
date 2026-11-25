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
  stream?: boolean;
  onDelta?: (chunk: string) => void;
  onReasoningDelta?: (chunk: string) => void;
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

const DEFAULT_TIMEOUT_MS = 90_000;

async function extractUpstreamDetail(res: Response): Promise<string | undefined> {
  try {
    const data = (await res.json()) as { error?: { message?: unknown } | string; message?: unknown };
    const msg =
      typeof data?.error === 'string'
        ? data.error
        : typeof data?.error?.message === 'string'
          ? data.error.message
          : typeof data?.message === 'string'
            ? data.message
            : undefined;
    return msg?.trim().slice(0, 180) || undefined;
  } catch {
    return undefined;
  }
}

async function readOpenAISSE(
  res: Response,
  req: CompatRequest,
  timeoutSignal: AbortSignal,
): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    throw new UpstreamError('bad_response', '大模型流式响应缺少可读正文');
  }
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let finished = false;

  const handleLine = (rawLine: string) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload) return;
    if (payload === '[DONE]') {
      finished = true;
      return;
    }
    let parsed: {
      choices?: Array<{
        delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown };
        message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown };
      }>;
    };
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    const choice = parsed?.choices?.[0];
    const delta = choice?.delta ?? choice?.message;
    if (!delta) return;
    const reasoning =
      typeof delta.reasoning_content === 'string'
        ? delta.reasoning_content
        : typeof delta.reasoning === 'string'
          ? delta.reasoning
          : '';
    if (reasoning) req.onReasoningDelta?.(reasoning);
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      content += delta.content;
      req.onDelta?.(delta.content);
    }
  };

  try {
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        if (finished) break;
        nl = buffer.indexOf('\n');
      }
    }
    if (!finished) {
      buffer += decoder.decode();
      if (buffer.trim()) handleLine(buffer);
    }
  } catch (error) {
    if (req.signal?.aborted) throw new UpstreamError('aborted', '请求已取消');
    if (timeoutSignal.aborted) throw new UpstreamError('timeout', '大模型响应超时');
    throw new UpstreamError('network', error instanceof Error ? error.message : '流式读取中断');
  } finally {
    reader.releaseLock();
  }

  if (!content) {
    throw new UpstreamError('bad_response', '大模型流式返回缺少有效内容');
  }
  return content;
}

export async function callOpenAICompatible(req: CompatRequest): Promise<string> {
  const fetchImpl = req.fetchImpl ?? fetch;
  const timeoutSignal = AbortSignal.timeout(req.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = req.signal ? AbortSignal.any([req.signal, timeoutSignal]) : timeoutSignal;
  const wantsStream = Boolean(req.stream || req.onDelta || req.onReasoningDelta);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (wantsStream) headers.Accept = 'text/event-stream, application/json';
  if (req.apiKey.trim()) headers.Authorization = `Bearer ${req.apiKey.trim()}`;

  const endpoint = `${req.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const send = async (withJsonMode: boolean): Promise<Response> => {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (withJsonMode) body.response_format = { type: 'json_object' };
    if (wantsStream) body.stream = true;
    try {
      return await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (req.signal?.aborted) throw new UpstreamError('aborted', '请求已取消');
      if (timeoutSignal.aborted) throw new UpstreamError('timeout', '大模型响应超时');
      throw new UpstreamError('network', error instanceof Error ? error.message : '网络错误');
    }
  };

  let res = await send(Boolean(req.jsonMode));
  // Fallback once without response_format for local/gateway models that reject json_object.
  if (req.jsonMode && (res.status === 400 || res.status === 422)) {
    res = await send(false);
  }

  if (!res.ok) {
    const detail = await extractUpstreamDetail(res);
    throw new UpstreamError(
      'upstream',
      detail ? `大模型服务返回 HTTP ${res.status}：${detail}` : `大模型服务返回 HTTP ${res.status}`,
      res.status,
    );
  }

  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  if (wantsStream && contentType.includes('text/event-stream') && res.body) {
    return readOpenAISSE(res, req, timeoutSignal);
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new UpstreamError('bad_response', '大模型返回的不是 JSON');
  }

  const message = (data as {
    choices?: { message?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown } }[];
  })?.choices?.[0]?.message;
  const content = message?.content;
  if (typeof content !== 'string') {
    throw new UpstreamError('bad_response', '大模型返回缺少 choices[0].message.content');
  }
  const reasoning =
    typeof message?.reasoning_content === 'string'
      ? message.reasoning_content
      : typeof message?.reasoning === 'string'
        ? message.reasoning
        : '';
  if (reasoning) req.onReasoningDelta?.(reasoning);
  if (content) req.onDelta?.(content);
  return content;
}
