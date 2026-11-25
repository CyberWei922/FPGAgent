import { describe, expect, it } from 'vitest';
import {
  createLLMClient,
  fetchOpenAIModels,
  inferProviderId,
  isAllowedBaseUrl,
  PROVIDER_PRESETS,
} from '../src/services/llmClient';
import { ACCENT_PRESETS, computeAccentTokens } from '../src/services/theme';
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

  it('单次 chat 支持通过 options.model 覆盖默认模型', async () => {
    let sentModel = '';
    const client = createLLMClient({
      mode: 'byok',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-test',
      model: 'deepseek-chat',
      fetchImpl: async (_url, init) => {
        sentModel = JSON.parse(String(init?.body)).model;
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
      },
    });
    const res = await client.chat({ ...call, model: 'deepseek-reasoner' });
    expect(sentModel).toBe('deepseek-reasoner');
    expect(res.model).toBe('deepseek-reasoner');
  });

  it('listModels 解析 /models 返回并去重排序', async () => {
    const models = await fetchOpenAIModels('https://api.deepseek.com/v1/', 'sk-test', {
      fetchImpl: jsonFetch(200, {
        data: [
          { id: 'deepseek-reasoner', owned_by: 'deepseek' },
          { id: 'deepseek-chat', owned_by: 'deepseek' },
          { id: 'deepseek-chat', owned_by: 'deepseek' },
        ],
      }),
    });
    expect(models.map((m) => m.id)).toEqual(['deepseek-chat', 'deepseek-reasoner']);
  });

  it('testConnection 成功与失败均返回结构化延迟与状态', async () => {
    const okClient = createLLMClient({
      mode: 'byok',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-ok',
      model: 'deepseek-chat',
      fetchImpl: jsonFetch(200, { choices: [{ message: { content: 'pong' } }] }),
    });
    const okRes = await okClient.testConnection!();
    expect(okRes.ok).toBe(true);
    expect(okRes.latencyMs).toBeGreaterThanOrEqual(1);

    const failClient = createLLMClient({
      mode: 'byok',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-bad',
      model: 'deepseek-chat',
      fetchImpl: jsonFetch(401, { error: { message: 'invalid key' } }),
    });
    const failRes = await failClient.testConnection!();
    expect(failRes.ok).toBe(false);
    expect(failRes.message).toBeTruthy();
  });

  it('内置国内常用服务商预设与 URL 反推正常', () => {
    const ids = PROVIDER_PRESETS.map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'deepseek',
        'zhipu-glm',
        'dashscope-qwen',
        'siliconflow',
        'moonshot-kimi',
        'local-gateway',
        'custom',
      ]),
    );
    expect(inferProviderId('https://api.deepseek.com/v1/')).toBe('deepseek');
    expect(inferProviderId('https://open.bigmodel.cn/api/paas/v4')).toBe('zhipu-glm');
    expect(inferProviderId('http://192.168.1.50:8000/v1')).toBe('local-gateway');
    expect(inferProviderId('http://10.0.0.8:3000/v1')).toBe('local-gateway');
    expect(inferProviderId('https://example.invalid/v1')).toBe('custom');
  });

  it('本地与内网网关支持 HTTP 地址、免 API Key 及 json_object 降级重试', async () => {
    expect(isAllowedBaseUrl('http://192.168.1.20:8080/v1')).toBe(true);
    expect(isAllowedBaseUrl('http://10.20.30.40:3000/v1')).toBe(true);
    expect(isAllowedBaseUrl('http://172.24.0.5:8000/v1')).toBe(true);
    expect(isAllowedBaseUrl('http://llm-gateway.local:8000/v1')).toBe(true);
    expect(isAllowedBaseUrl('http://corp-gw.example.com:8080/v1', 'local-gateway')).toBe(true);
    expect(isAllowedBaseUrl('http://evil.test/v1')).toBe(false);

    const models = await fetchOpenAIModels('http://192.168.1.20:8080/v1', '', {
      providerId: 'local-gateway',
      fetchImpl: async (_url, init) => {
        expect(new Headers(init?.headers).get('Authorization')).toBeNull();
        return new Response(JSON.stringify({ data: [{ id: 'qwen2.5-coder:14b' }] }));
      },
    });
    expect(models.map((m) => m.id)).toEqual(['qwen2.5-coder:14b']);

    const sentBodies: Array<Record<string, unknown>> = [];
    const client = createLLMClient({
      mode: 'byok',
      providerId: 'local-gateway',
      baseUrl: 'http://192.168.1.20:8080/v1',
      apiKey: '',
      model: 'qwen2.5-coder:14b',
      fetchImpl: async (_url, init) => {
        expect(new Headers(init?.headers).get('Authorization')).toBeNull();
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sentBodies.push(body);
        if (body.response_format) {
          return new Response(JSON.stringify({ error: { message: 'response_format unsupported' } }), { status: 400 });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
      },
    });

    await expect(client.chat(call)).resolves.toEqual({ text: '{"ok":true}' });
    expect(sentBodies).toHaveLength(2);
    expect(sentBodies[0].response_format).toEqual({ type: 'json_object' });
    expect(sentBodies[1].response_format).toBeUndefined();
  });

  it('主题色计算同时兼容预设与自定义颜色的深浅模式', () => {
    for (const preset of ACCENT_PRESETS) {
      const light = computeAccentTokens({ mode: 'light', accentId: preset.id, customAccent: '#126e71' }, 'light');
      const dark = computeAccentTokens({ mode: 'dark', accentId: preset.id, customAccent: '#126e71' }, 'dark');
      expect(light.accent).toMatch(/^#[0-9a-f]{6}$/i);
      expect(dark.accent).toMatch(/^#[0-9a-f]{6}$/i);
    }
    const customLight = computeAccentTokens({ mode: 'light', accentId: 'custom', customAccent: '#f5ff00' }, 'light');
    const customDark = computeAccentTokens({ mode: 'dark', accentId: 'custom', customAccent: '#0c1020' }, 'dark');
    expect(customLight.accent).not.toBe('#f5ff00');
    expect(customDark.accent).not.toBe('#0c1020');
  });
});
