import { describe, expect, it } from 'vitest';
import { createLLMClient } from '../src/services/llmClient';
import { LLMError, type LLMCallOptions } from '../src/types/contracts';

const call: LLMCallOptions = { action: 'plan', messages: [{ role: 'user', content: 'hi' }], jsonMode: true };

function jsonFetch(status: number, body: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function expectCode(promise: Promise<unknown>, code: LLMError['code']) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(LLMError);
  expect((error as LLMError).code).toBe(code);
}

describe('llmClient proxy 模式', () => {
  it('成功时返回 text 与剩余额度', async () => {
    const client = createLLMClient({ mode: 'proxy', fetchImpl: jsonFetch(200, { ok: true, text: 'x', remainingQuota: 3 }) });
    await expect(client.chat(call)).resolves.toEqual({ text: 'x', remainingQuota: 3 });
  });

  it('把云函数错误码映射为 LLMError', async () => {
    const cases: [string, number, LLMError['code']][] = [
      ['quota_exceeded', 429, 'QUOTA_EXCEEDED'],
      ['service_not_configured', 503, 'NOT_CONFIGURED'],
      ['forbidden_origin', 403, 'FORBIDDEN'],
      ['upstream_timeout', 504, 'TIMEOUT'],
      ['upstream_error', 502, 'UPSTREAM'],
    ];
    for (const [error, status, code] of cases) {
      const client = createLLMClient({ mode: 'proxy', fetchImpl: jsonFetch(status, { ok: false, error }) });
      await expectCode(client.chat(call), code);
    }
  });

  it('非 JSON 响应（如登录页）返回 BAD_RESPONSE', async () => {
    const client = createLLMClient({ mode: 'proxy', fetchImpl: async () => new Response('<html>', { status: 200 }) });
    await expectCode(client.chat(call), 'BAD_RESPONSE');
  });

  it('JSON null 响应返回 BAD_RESPONSE', async () => {
    const client = createLLMClient({ mode: 'proxy', fetchImpl: jsonFetch(200, null) });
    await expectCode(client.chat(call), 'BAD_RESPONSE');
  });

  it('断网返回 NETWORK', async () => {
    const client = createLLMClient({
      mode: 'proxy',
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await expectCode(client.chat(call), 'NETWORK');
  });
});

describe('llmClient 直连模式（BYOK / Node）', () => {
  it('BYOK 发送 OpenAI 兼容请求并解析 content', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const client = createLLMClient({
      mode: 'byok',
      baseUrl: 'https://llm.example.test/v1/',
      apiKey: 'sk-test',
      model: 'm',
      fetchImpl: async (url, init) => {
        captured = { url: String(url), init: init! };
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"a":1}' } }] }));
      },
    });
    await expect(client.chat(call)).resolves.toEqual({ text: '{"a":1}' });
    expect(captured!.url).toBe('https://llm.example.test/v1/chat/completions');
    expect(new Headers(captured!.init.headers).get('Authorization')).toBe('Bearer sk-test');
    expect(JSON.parse(String(captured!.init.body)).response_format).toEqual({ type: 'json_object' });
  });

  it('BYOK 拒绝非 https 地址', async () => {
    const client = createLLMClient({ mode: 'byok', baseUrl: 'http://evil.test', apiKey: 'k', model: 'm' });
    await expectCode(client.chat(call), 'NOT_CONFIGURED');
  });

  it('上游 401 映射为 NOT_CONFIGURED，429 映射为 QUOTA_EXCEEDED', async () => {
    for (const [status, code] of [
      [401, 'NOT_CONFIGURED'],
      [429, 'QUOTA_EXCEEDED'],
      [500, 'UPSTREAM'],
    ] as const) {
      const client = createLLMClient({ mode: 'node', env: { LLM_API_KEY: 'k' }, fetchImpl: jsonFetch(status, {}) });
      await expectCode(client.chat(call), code);
    }
  });

  it('Node 模式缺少 LLM_API_KEY 时返回 NOT_CONFIGURED', async () => {
    const client = createLLMClient({ mode: 'node', env: {} });
    await expectCode(client.chat(call), 'NOT_CONFIGURED');
  });

  it('调用方取消返回 ABORTED', async () => {
    const controller = new AbortController();
    const client = createLLMClient({
      mode: 'node',
      env: { LLM_API_KEY: 'k' },
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    });
    const pending = client.chat({ ...call, signal: controller.signal });
    controller.abort();
    await expectCode(pending, 'ABORTED');
  });
});
