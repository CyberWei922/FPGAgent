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
  it('返回当前 IP 剩余次数且不消耗额度', async () => {
    const h = handler({ DAILY_LIMIT_PER_IP: '3' });
    const quota = () => h(new Request(`${URL_BASE}/quota`, { headers: { 'x-forwarded-for': '9.9.9.9' } }));
    expect((await json(await quota())).remainingQuota).toBe(3);
    expect((await json(await quota())).remainingQuota).toBe(3);
  });
});
