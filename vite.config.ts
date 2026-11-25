/// <reference types="vitest/config" />
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const functionProxy = { '/functions/v1/app': 'http://127.0.0.1:8000' };
const LOCAL_GATEWAY_PROXY_PATH = '/__local_gateway_proxy';

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function handleLocalGatewayProxy(req: IncomingMessage, res: ServerResponse): void {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') {
    writeJson(res, 405, { error: { message: '仅支持 GET/POST 代理转发' } });
    return;
  }

  const rawTarget = req.headers['x-gateway-target'];
  const target = Array.isArray(rawTarget) ? rawTarget[0] : rawTarget;
  if (!target) {
    writeJson(res, 400, { error: { message: '缺少目标网关地址 x-gateway-target' } });
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    writeJson(res, 400, { error: { message: '目标网关地址格式无效' } });
    return;
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
    writeJson(res, 400, { error: { message: '目标网关仅支持无凭据的 http/https 地址' } });
    return;
  }

  void (async () => {
    try {
      const forwardHeaders: Record<string, string> = {};
      const auth = req.headers.authorization;
      if (typeof auth === 'string' && auth.trim()) forwardHeaders.Authorization = auth;
      const accept = req.headers.accept;
      if (typeof accept === 'string' && accept.trim()) forwardHeaders.Accept = accept;

      let body: Buffer | undefined;
      if (method === 'POST') {
        body = await readRequestBody(req);
        const contentType = req.headers['content-type'];
        forwardHeaders['Content-Type'] =
          typeof contentType === 'string' && contentType.trim() ? contentType : 'application/json';
      }

      const upstream = await fetch(parsed.toString(), {
        method,
        headers: forwardHeaders,
        body: body ? new Uint8Array(body) : undefined,
        signal: AbortSignal.timeout(120_000),
      });

      const responseBuffer = Buffer.from(await upstream.arrayBuffer());
      res.statusCode = upstream.status;
      const contentType = upstream.headers.get('content-type');
      if (contentType) res.setHeader('Content-Type', contentType);
      res.end(responseBuffer);
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知连接异常';
      writeJson(res, 502, { error: { message: `无法连接本地/内网网关 (${parsed.origin})：${detail}` } });
    }
  })();
}

function localGatewayProxyPlugin(): Plugin {
  const attach = (middlewares: { use: (route: string, fn: (req: IncomingMessage, res: ServerResponse) => void) => void }) => {
    middlewares.use(LOCAL_GATEWAY_PROXY_PATH, handleLocalGatewayProxy);
  };
  return {
    name: 'local-gateway-proxy',
    configureServer(server) {
      attach(server.middlewares);
    },
    configurePreviewServer(server) {
      attach(server.middlewares);
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), localGatewayProxyPlugin()],
  server: { host: '127.0.0.1', proxy: functionProxy },
  preview: { host: '127.0.0.1', proxy: functionProxy },
  build: { outDir: 'dist' },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Only LLM_* from .env.local reach tests, for createLLMClient({ mode: 'node' }).
    env: loadEnv(mode, process.cwd(), 'LLM_'),
  },
}));
