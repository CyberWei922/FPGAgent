import { describe, expect, it } from 'vitest';
import { createHandler } from '../functions/handler';
import { createAgentRuntime } from '../src/agent';
import { mergeTracesToSteps } from '../src/components/ChatPane';
import {
  collectVerilogTokenBoundaries,
  createRtlEngine,
  extractPartialJsonStringField,
  extractSafeVerilogPrefix,
} from '../src/engine';
import { createLLMClient } from '../src/services/llmClient';
import type { HarnessTraceEvent, LLMCallOptions, LLMClient } from '../src/types/contracts';

function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const evt of events) {
        controller.enqueue(encoder.encode(evt));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
  });
}

describe('SSE 真流式：云函数代理与 LLMClient', () => {
  it('云函数 /agent 在 stream=true 时透传 reasoning 与 delta SSE 事件', async () => {
    const upstreamSSE: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.stream).toBe(true);
      return sseResponse([
        'data: {"choices":[{"delta":{"reasoning_content":"先检查端口"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"{\\"ok\\":"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"true}"}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
    };

    const handler = createHandler({
      getEnv: (k) => ({ LLM_API_KEY: 'sk-test', LLM_MODEL: 'qwen-plus' })[k],
      fetchImpl: upstreamSSE,
    });

    const client = createLLMClient({
      mode: 'proxy',
      endpoint: 'https://lab.example.test/functions/v1/app/agent',
      fetchImpl: (input, init) => handler(new Request(String(input), init)),
    });

    const deltas: string[] = [];
    const reasonings: string[] = [];
    const result = await client.chat({
      action: 'generate',
      messages: [{ role: 'user', content: '交通灯' }],
      jsonMode: true,
      onDelta: (c) => deltas.push(c),
      onReasoningDelta: (r) => reasonings.push(r),
    });

    expect(result).toEqual({ text: '{"ok":true}', remainingQuota: 7, model: 'qwen-plus' });
    expect(deltas).toEqual(['{"ok":', 'true}']);
    expect(reasonings).toEqual(['先检查端口']);
  });

  it('BYOK 直连模式支持 OpenAI SSE 流式解析并在服务端返回 JSON 时优雅降级', async () => {
    const sseClient = createLLMClient({
      mode: 'byok',
      baseUrl: 'https://llm.example.test/v1',
      apiKey: 'sk-byok',
      model: 'deepseek-reasoner',
      fetchImpl: async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"reasoning_content":"分析状态机"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"module top"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"(); endmodule"}}]}\n\n',
          'data: [DONE]\n\n',
        ]),
    });

    const deltas: string[] = [];
    const reasonings: string[] = [];
    const res = await sseClient.chat({
      action: 'generate',
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: (c) => deltas.push(c),
      onReasoningDelta: (r) => reasonings.push(r),
    });
    expect(res.text).toBe('module top(); endmodule');
    expect(deltas.join('')).toBe('module top(); endmodule');
    expect(reasonings).toEqual(['分析状态机']);

    // JSON fallback when upstream ignores stream=true
    const fallbackDeltas: string[] = [];
    const jsonFallbackClient = createLLMClient({
      mode: 'byok',
      baseUrl: 'https://llm.example.test/v1',
      apiKey: 'sk-byok',
      model: 'm',
      fetchImpl: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'plain-json-reply' } }] }), {
          headers: { 'Content-Type': 'application/json' },
        }),
    });
    const fallbackRes = await jsonFallbackClient.chat({
      action: 'plan',
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: (c) => fallbackDeltas.push(c),
    });
    expect(fallbackRes.text).toBe('plain-json-reply');
    expect(fallbackDeltas).toEqual(['plain-json-reply']);
  });
});

describe('流式 Verilog 提取与防闪烁词法边界缓冲', () => {
  it('增量提取 JSON 中的 code 字段并正确处理换行、转义与未闭合尾部转义', () => {
    expect(extractPartialJsonStringField('{"explanation":"x"}', 'code')).toBeNull();
    expect(extractPartialJsonStringField('{"code": "module top();\\n  reg a;\\', 'code')).toEqual({
      value: 'module top();\n  reg a;',
      complete: false,
    });
    expect(extractPartialJsonStringField('{"code": "module top();\\nendmodule"}', 'code')).toEqual({
      value: 'module top();\nendmodule',
      complete: true,
    });
  });

  it('extractSafeVerilogPrefix 裁剪半截关键词与位宽字面量，防止染色闪烁', () => {
    expect(extractSafeVerilogPrefix('always @(posedge clk) begi')).toBe('always @(posedge clk) ');
    expect(extractSafeVerilogPrefix("assign led = 8'b10")).toBe('assign led = ');
    expect(extractSafeVerilogPrefix('always @(posedge clk) begin\n', false)).toBe(
      'always @(posedge clk) begin\n',
    );
    expect(extractSafeVerilogPrefix('always @(posedge clk) begi', true)).toBe('always @(posedge clk) begi');
  });

  it('collectVerilogTokenBoundaries 按完整词法单元单调递增至全文末尾', () => {
    const code = "module top(\n  input clk\n);\n  assign led = 8'h01;\nendmodule";
    const boundaries = collectVerilogTokenBoundaries(code);
    expect(boundaries.length).toBeGreaterThan(8);
    expect(boundaries[boundaries.length - 1]).toBe(code.length);
    for (let i = 1; i < boundaries.length; i++) {
      expect(boundaries[i]).toBeGreaterThan(boundaries[i - 1]);
    }
  });
});

describe('Agent Harness 流式回调与左侧步骤合并', () => {
  it('runHarness 在流式生成期间触发 onBlueprint、增量 onCodeDelta 与 onReasoningDelta', async () => {
    const engine = createRtlEngine();
    const preset = createAgentRuntime({
      llm: { chat: async () => ({ text: '' }) },
      engine,
    }).presets[0];

    const planText = JSON.stringify({ blueprint: preset.blueprint, testVectors: preset.testVectors });
    const genText = JSON.stringify({ code: preset.verilogCode, explanation: '按蓝图生成' });

    const streamingLLM: LLMClient = {
      async chat(options: LLMCallOptions) {
        if (options.action === 'plan') {
          options.onReasoningDelta?.('拆解交通灯状态机');
          options.onDelta?.(planText);
          return { text: planText };
        }
        options.onReasoningDelta?.('编写主状态寄存器');
        for (let i = 0; i < genText.length; i += 35) {
          options.onDelta?.(genText.slice(i, i + 35));
        }
        return { text: genText };
      },
    };

    const runtime = createAgentRuntime({ llm: streamingLLM, engine });
    const blueprints: string[] = [];
    const codeSnapshots: string[] = [];
    const reasonings: Array<{ stage: string; text: string }> = [];
    const traces: HarnessTraceEvent[] = [];

    const result = await runtime.runHarness('做一个交通灯', {
      onTrace: (e) => traces.push(e),
      onBlueprint: (bp) => blueprints.push(bp.title),
      onCodeDelta: (c) => codeSnapshots.push(c),
      onReasoningDelta: (stage, text) => reasonings.push({ stage, text }),
    });

    expect(result.ok).toBe(true);
    expect(blueprints).toEqual([preset.blueprint.title]);
    expect(codeSnapshots.length).toBeGreaterThan(3);
    expect(codeSnapshots[codeSnapshots.length - 1]).toBe(preset.verilogCode.trim());
    expect(reasonings.some((r) => r.stage === 'planning' && r.text.includes('拆解交通灯'))).toBe(true);
    expect(reasonings.some((r) => r.stage === 'coding' && r.text.includes('主状态寄存器'))).toBe(true);

    // 验证 mergeTracesToSteps 将同阶段 running + pass 合并为单一步骤且不重复
    const steps = mergeTracesToSteps(traces);
    expect(steps.map((s) => s.stage)).toEqual(['planning', 'coding', 'linting', 'simulating']);
    expect(steps.every((s) => s.status === 'pass')).toBe(true);
    expect(steps[0].checkpoints?.length).toBeGreaterThan(0);
    expect(steps[0].reasoning).toContain('拆解交通灯');
  });
});
