import { describe, expect, it } from 'vitest';
import { createHandler } from '../functions/handler';

const URL_BASE = 'https://lab.example.test/functions/v1/app';
const validBody = { action: 'plan', messages: [{ role: 'user', content: '交通灯' }], jsonMode: true };

const upstreamOk: typeof fetch = async () =>
  new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));

function handler(env: Record<string, string> = {}, fetchImpl: typeof fetch = upstreamOk) {
  return createHandler({ getEnv: (k) => ({ LLM_API_KEY: 'sk-server', ...env })[k], fetchImpl });
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${URL_BASE}/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '1.2.3.4', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function json(res: Response) {
  return (await res.json()) as Record<string, unknown>;
}

describe('云函数 /agent', () => {
  it('正常请求返回 text 与剩余额度，且不泄露 Key', async () => {
    const res = await handler()(post(validBody));
    const body = await json(res);
    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, text: '{"ok":true}', remainingQuota: 7 });
    expect(JSON.stringify(body)).not.toContain('sk-server');
  });

  it('单 IP 超出每日次数返回 429', async () => {
    const h = handler({ DAILY_LIMIT_PER_IP: '2' });
    expect((await h(post(validBody))).status).toBe(200);
    expect((await h(post(validBody))).status).toBe(200);
    const res = await h(post(validBody));
    expect(res.status).toBe(429);
    expect((await json(res)).error).toBe('quota_exceeded');
    expect((await h(post(validBody, { 'x-forwarded-for': '5.6.7.8' }))).status).toBe(200);
  });

  it('配置 ALLOWED_ORIGINS 时校验 Origin / Referer', async () => {
    const h = handler({ ALLOWED_ORIGINS: 'https://lab.example.test' });
    expect((await h(post(validBody, { origin: 'https://evil.test' }))).status).toBe(403);
    expect((await h(post(validBody))).status).toBe(403);
    expect((await h(post(validBody, { referer: 'https://lab.example.test/page' }))).status).toBe(200);
  });

  it('未配置 LLM_API_KEY 返回 503 service_not_configured', async () => {
    const h = createHandler({ getEnv: () => undefined, fetchImpl: upstreamOk });
    const res = await h(post(validBody));
    expect(res.status).toBe(503);
    expect((await json(res)).error).toBe('service_not_configured');
  });

  it('拒绝非法请求体', async () => {
    const h = handler();
    for (const bad of [
      'not json',
      { ...validBody, action: 'rm_rf' },
      { ...validBody, messages: [] },
      { ...validBody, messages: [{ role: 'root', content: 'x' }] },
      { ...validBody, temperature: 9 },
    ]) {
      expect((await h(post(bad))).status).toBe(400);
    }
  });

  it('请求体过大返回 413', async () => {
    const res = await handler()(post({ ...validBody, messages: [{ role: 'user', content: 'x'.repeat(70_000) }] }));
    expect(res.status).toBe(413);
  });

  it('方法与路径校验', async () => {
    const h = handler();
    expect((await h(new Request(`${URL_BASE}/agent`))).status).toBe(405);
    expect((await h(new Request(`${URL_BASE}/other`, { method: 'POST' }))).status).toBe(404);
  });

  it('上游失败返回 502，且不透出原始错误', async () => {
    const h = handler({}, async () => new Response('secret upstream detail', { status: 500 }));
    const res = await h(post(validBody));
    const body = await json(res);
    expect(res.status).toBe(502);
    expect(body.error).toBe('upstream_error');
    expect(JSON.stringify(body)).not.toContain('secret upstream detail');
  });
});

describe('云函数 /quota', () => {
  it('返回当前 IP 剩余次数与每日上限，且不消耗额度并下发浏览器票据 Cookie', async () => {
    const h = handler({ DAILY_LIMIT_PER_IP: '3' });
    const quota = () => h(new Request(`${URL_BASE}/quota`, { headers: { 'x-forwarded-for': '9.9.9.9' } }));
    const res1 = await quota();
    const body1 = await json(res1);
    expect(body1.remainingQuota).toBe(3);
    expect(body1.dailyLimit).toBe(3);
    expect(res1.headers.get('set-cookie')).toContain('fpgagent_bid=');
    expect((await json(await quota())).remainingQuota).toBe(3);
  });
});

describe('云函数双维度限流、模型白名单与 AMD 备用渠道', () => {
  it('同一浏览器切换不同 VPN IP 时依然受 DAILY_LIMIT_PER_BROWSER 限制', async () => {
    const h = handler({ DAILY_LIMIT_PER_IP: '10', DAILY_LIMIT_PER_BROWSER: '2' });
    const bid = 'browser-id-12345678';
    expect((await h(post(validBody, { 'x-forwarded-for': '10.0.0.1', 'x-browser-id': bid }))).status).toBe(200);
    expect((await h(post(validBody, { 'x-forwarded-for': '10.0.0.2', cookie: `fpgagent_bid=${bid}` }))).status).toBe(
      200,
    );
    const blocked = await h(post(validBody, { 'x-forwarded-for': '10.0.0.3', 'x-browser-id': bid }));
    expect(blocked.status).toBe(429);
    const blockedBody = await json(blocked);
    expect(blockedBody.error).toBe('quota_exceeded');
    expect(blockedBody.limitReason).toBe('browser');
  });

  it('GET /models 返回站点默认模型列表，POST /agent 仅接受白名单模型', async () => {
    const sentModels: string[] = [];
    const h = handler({}, async (_url, init) => {
      const payload = JSON.parse(String(init?.body)) as { model: string };
      sentModels.push(payload.model);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
    });

    const modelsRes = await h(new Request(`${URL_BASE}/models`));
    expect(modelsRes.status).toBe(200);
    const modelsBody = (await modelsRes.json()) as { ok: boolean; models: Array<{ id: string }> };
    expect(modelsBody.ok).toBe(true);
    expect(modelsBody.models.map((m) => m.id)).toEqual(['qwen3.8-flash', 'deepseek-v4.1-flash']);

    expect((await h(post({ ...validBody, model: 'deepseek-v4.1-flash' }))).status).toBe(200);
    expect((await h(post({ ...validBody, model: 'qwen4-max' }))).status).toBe(200);
    expect(sentModels).toEqual(['deepseek-v4.1-flash', 'qwen3.8-flash']);
  });

  it('主渠道异常时自动切换到 AMD Radeon Cloud 备用渠道并映射模型名（含流式）', async () => {
    const calls: Array<{ url: string; auth: string | null; model: string; stream?: boolean }> = [];
    const h = createHandler({
      getEnv: (k) =>
        ({
          LLM_API_KEY: 'sk-aliyun-primary',
          FALLBACK_LLM_API_KEY: 'rc-amd-fallback',
        })[k],
      fetchImpl: async (url, init) => {
        const body = JSON.parse(String(init?.body)) as { model: string; stream?: boolean };
        const auth = new Headers(init?.headers).get('Authorization');
        calls.push({ url: String(url), auth, model: body.model, stream: body.stream });
        if (String(url).includes('dashscope.aliyuncs.com')) {
          return new Response(JSON.stringify({ error: { message: 'rate limit' } }), { status: 429 });
        }
        if (body.stream) {
          const sse =
            'data: {"choices":[{"delta":{"content":"{\\"ok\\":true}"}}]}\n\ndata: [DONE]\n\n';
          return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
      },
    });

    const res1 = await h(post({ ...validBody, model: 'deepseek-v4.1-flash' }));
    expect(res1.status).toBe(200);
    expect((await json(res1)).text).toBe('{"ok":true}');

    const res2 = await h(post({ ...validBody, model: 'qwen3.8-flash', stream: true }));
    expect(res2.status).toBe(200);
    const sseText = await res2.text();
    expect(sseText).toContain('"model":"Qwen3.8-Flash-Next"');
    expect(sseText).toContain('"type":"done"');

    expect(calls).toEqual([
      {
        url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        auth: 'Bearer sk-aliyun-primary',
        model: 'deepseek-v4.1-flash',
        stream: undefined,
      },
      {
        url: 'https://developer.amd.com.cn/radeon/api/v1/chat/completions',
        auth: 'Bearer rc-amd-fallback',
        model: 'DeepSeek-V4.1-Flash-1017',
        stream: undefined,
      },
      {
        url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        auth: 'Bearer sk-aliyun-primary',
        model: 'qwen3.8-flash',
        stream: true,
      },
      {
        url: 'https://developer.amd.com.cn/radeon/api/v1/chat/completions',
        auth: 'Bearer rc-amd-fallback',
        model: 'Qwen3.8-Flash-Next',
        stream: true,
      },
    ]);
  });

  it('仅配置 FALLBACK_LLM_API_KEY 时也可独立工作', async () => {
    const h = createHandler({
      getEnv: (k) => ({ FALLBACK_LLM_API_KEY: 'rc-amd-only' })[k],
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe('https://developer.amd.com.cn/radeon/api/v1/chat/completions');
        expect(JSON.parse(String(init?.body)).model).toBe('Qwen3.8-Flash-Next');
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
      },
    });
    const res = await h(post(validBody));
    expect(res.status).toBe(200);
  });
});
