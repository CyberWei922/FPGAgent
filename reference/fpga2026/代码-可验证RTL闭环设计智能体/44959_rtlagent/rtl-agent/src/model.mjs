import { Agent } from '@earendil-works/pi-agent-core';
import { stream as streamCompletions, convertMessages } from '@earendil-works/pi-ai/api/openai-completions';
import { observeServerTiming } from './server-timing.mjs';
import { checkOutputPolicy } from './output-policy.mjs';
import {createHash} from 'node:crypto';

const PROTECTED_BODY_FIELDS = new Set([
  'model', 'messages', 'tools', 'tool_choice', 'functions', 'function_call',
  'stream', 'n', 'max_tokens', 'max_completion_tokens',
]);
const THINKING_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const THINKING_BODY_FIELDS = new Set(['think', 'thinking', 'reasoning', 'reasoning_effort', 'enable_thinking',
  'preserve_thinking', 'clear_thinking', 'thinking_budget', 'thinking_budget_tokens', 'thinking_token_budget',
  'reasoning_budget', 'reasoning_budget_tokens']);

export class ModelGenerationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ModelGenerationError';
    this.code = code;
    Object.assign(this, details);
    this.details = details;
  }
}

function configurationError(message) {
  return new ModelGenerationError('MODEL_CONFIG', message);
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw configurationError(`${name} must be a positive integer.`);
  }
  return value;
}

function prepareThinking(config, thinkingLevel, extraBody) {
  if (config.reasoning !== undefined && typeof config.reasoning !== 'boolean') {
    throw configurationError('model.reasoning must be a boolean.');
  }
  if (!config.reasoning) {
    if (thinkingLevel !== undefined && thinkingLevel !== 'off') {
      throw configurationError('thinkingLevel requires model.reasoning=true.');
    }
    return { requestedLevel: 'off', effectiveLevel: 'off', format: null, capability: null, wireValue: null };
  }
  const requestedLevel = thinkingLevel ?? 'medium';
  if (!THINKING_LEVELS.has(requestedLevel)) throw configurationError('Unsupported thinkingLevel.');
  const thinking = config.thinking;
  if (!thinking || typeof thinking !== 'object' || Array.isArray(thinking) ||
      !['reasoning_effort', 'qwen-template', 'qwen-template-graded'].includes(thinking.format) ||
      !['graded', 'binary'].includes(thinking.capability)) {
    throw configurationError('model.thinking requires an explicit format and capability.');
  }
  const conflictingField = (value) => value && typeof value === 'object' && Object.entries(value).some(([key, nested]) =>
    THINKING_BODY_FIELDS.has(key.toLowerCase()) || /^(thinking|reasoning)[_-]/i.test(key) || conflictingField(nested));
  if (conflictingField(extraBody)) throw configurationError('model.extraBody conflicts with explicit thinking settings.');
  if (thinking.format === 'qwen-template') {
    if (thinking.capability !== 'binary') throw configurationError('qwen-template supports only binary thinking.');
    if (extraBody.chat_template_kwargs !== undefined && (!extraBody.chat_template_kwargs ||
        typeof extraBody.chat_template_kwargs !== 'object' || Array.isArray(extraBody.chat_template_kwargs))) {
      throw configurationError('model.extraBody.chat_template_kwargs must be an object.');
    }
    return { requestedLevel, effectiveLevel: 'enabled', format: thinking.format, capability: 'binary', wireValue: true };
  }
  const mapping = thinking.effortMap;
  if (thinking.format === 'qwen-template-graded' && thinking.capability !== 'graded') {
    throw configurationError('qwen-template-graded requires graded capability.');
  }
  if (thinking.format === 'qwen-template-graded' && extraBody.chat_template_kwargs !== undefined &&
      (!extraBody.chat_template_kwargs || typeof extraBody.chat_template_kwargs !== 'object' || Array.isArray(extraBody.chat_template_kwargs))) {
    throw configurationError('model.extraBody.chat_template_kwargs must be an object.');
  }
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) ||
      Object.values(mapping).some(value => typeof value !== 'string' || !value.trim()) ||
      !Object.hasOwn(mapping, requestedLevel)) {
    throw configurationError('model.thinking.effortMap must explicitly map the requested thinkingLevel.');
  }
  return { requestedLevel, effectiveLevel: thinking.capability === 'graded' ? mapping[requestedLevel] : 'enabled',
    format: thinking.format, capability: thinking.capability, wireValue: mapping[requestedLevel] };
}

function prepareModel(config, thinkingLevel) {
  if (!config || typeof config !== 'object') throw configurationError('model is required.');
  if (typeof config.id !== 'string' || !config.id.trim()) throw configurationError('model.id is required.');
  let url;
  try { url = new URL(config.baseUrl); } catch { throw configurationError('model.baseUrl must be an HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw configurationError('model.baseUrl must use HTTP(S) without embedded credentials.');
  }
  const contextWindow = positiveInteger(config.contextWindow, 'model.contextWindow');
  const maxTokens = positiveInteger(config.maxTokens, 'model.maxTokens');
  if (maxTokens >= contextWindow) throw configurationError('model.maxTokens must leave room for input in model.contextWindow.');
  const timeoutMs = positiveInteger(config.requestTimeoutMs ?? 120_000, 'model.requestTimeoutMs');
  if (timeoutMs > 2_147_483_647) throw configurationError('model.requestTimeoutMs exceeds the timer limit.');
  const temperature = config.temperature ?? 0;
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw configurationError('model.temperature must be between 0 and 2.');
  }
  if (config.topP !== undefined && (!Number.isFinite(config.topP) || config.topP <= 0 || config.topP > 1)) {
    throw configurationError('model.topP must be greater than 0 and at most 1.');
  }
  if (config.compat !== undefined && (!config.compat || typeof config.compat !== 'object' || Array.isArray(config.compat))) {
    throw configurationError('model.compat must be an object.');
  }
  let extraBody = {};
  if (config.extraBody !== undefined) {
    if (!config.extraBody || typeof config.extraBody !== 'object' || Array.isArray(config.extraBody)) {
      throw configurationError('model.extraBody must be an object.');
    }
    try { extraBody = JSON.parse(JSON.stringify(config.extraBody)); } catch {
      throw configurationError('model.extraBody must be JSON serializable.');
    }
    for (const key of Object.keys(extraBody)) {
      if (PROTECTED_BODY_FIELDS.has(key)) throw configurationError(`model.extraBody cannot override ${key}.`);
    }
  }
  if (config.compat?.supportsFinishReason === false) {
    throw configurationError('A finish_reason is required to detect truncated output.');
  }
  const thinking = prepareThinking(config, thinkingLevel, extraBody);
  if (config.reasoningBudget !== undefined && (!Number.isSafeInteger(config.reasoningBudget) || config.reasoningBudget < -1 || config.reasoningBudget >= maxTokens)) {
    throw configurationError('model.reasoningBudget must be -1 or a nonnegative integer below maxTokens.');
  }
  const compat = {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: false,
    maxTokensField: 'max_tokens',
    ...config.compat,
    supportsFinishReason: true,
  };
  if (config.reasoning) {
    // Use Pi's native payload builder; never let a compatibility hint silently disable thinking.
    compat.supportsReasoningEffort = thinking.format === 'reasoning_effort';
    compat.thinkingFormat = thinking.format === 'reasoning_effort' ? 'openai' : 'chat-template';
    if (thinking.format === 'qwen-template') compat.chatTemplateKwargs = { enable_thinking: { $var: 'thinking.enabled' } };
    if (thinking.format === 'qwen-template-graded') compat.chatTemplateKwargs = { reasoning_effort: thinking.wireValue };
  }
  return {
    piModel: {
      id: config.id,
      name: config.id,
      api: 'openai-completions',
      provider: 'rtl-local',
      baseUrl: url.href.replace(/\/$/, ''),
      reasoning: config.reasoning === true,
      ...(thinking.format === 'reasoning_effort' ? { thinkingLevelMap: { [thinking.requestedLevel]: thinking.wireValue } } : {}),
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens,
      compat,
    },
    maxTokens, timeoutMs, temperature, topP: config.topP, extraBody, thinking,
  };
}

// Local template/token endpoints perform no generation. Use the same Pi message
// conversion and thinking kwargs as generateRtl, not a bytes-as-tokens estimate.
export async function measureModelContext({model,systemPrompt,prompt,thinkingLevel,signal,deadline=Date.now()+5000}){
  const options=prepareModel(model,thinkingLevel),url=new URL(model.baseUrl);
  if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw configurationError('Token measurement requires local inference');
  const bounded=AbortSignal.timeout(Math.max(1,Math.min(5000,deadline-Date.now()))),combined=signal?AbortSignal.any([signal,bounded]):bounded;
  const messages=convertMessages(options.piModel,{messages:[...(systemPrompt?[{role:'system',content:systemPrompt,timestamp:0}]:[]),{role:'user',content:[{type:'text',text:prompt}],timestamp:0}]},options.piModel.compat);
  const kwargs={...options.extraBody.chat_template_kwargs,...(options.thinking.format==='qwen-template-graded'?{reasoning_effort:options.thinking.wireValue}:options.thinking.format==='qwen-template'?{enable_thinking:true}:{})};
  const post=async(route,body)=>{
    const response=await fetch(new URL(route,url.origin),{method:'POST',headers:{'content-type':'application/json',...(model.apiKey?{authorization:'Bearer '+model.apiKey}:{})},body:JSON.stringify(body),signal:combined});
    if(!response.ok)throw new ModelGenerationError('TOKEN_COUNT_UNAVAILABLE','Local token/template endpoint unavailable');
    const text=await response.text();if(Buffer.byteLength(text)>2*1024*1024)throw new ModelGenerationError('TOKEN_COUNT_UNAVAILABLE','Oversized token/template response');return JSON.parse(text);
  };
  try{
    const rendered=await post('/apply-template',{model:model.id,messages,add_generation_prompt:true,chat_template_kwargs:kwargs});
    if(typeof rendered.prompt!=='string'||!rendered.prompt.length)throw new Error('No template prompt');
    const result=await post('/tokenize',{content:rendered.prompt,add_special:true,parse_special:true,with_pieces:false});
    if(!Array.isArray(result.tokens)||!result.tokens.length||result.tokens.some(t=>!Number.isSafeInteger(t)||t<0))throw new Error('Invalid tokenizer response');
    return {inputTokens:result.tokens.length,method:'local_apply_template_tokenize',messageSha256:createHash('sha256').update(JSON.stringify({messages,chat_template_kwargs:kwargs})).digest('hex'),templateBytes:Buffer.byteLength(rendered.prompt)};
  }catch(error){
    signal?.throwIfAborted();if(error.code==='TOKEN_COUNT_UNAVAILABLE')throw error;
    throw new ModelGenerationError('TOKEN_COUNT_UNAVAILABLE','Local template/token count failed; no generation sent');
  }
}

// Buffer until completion so split tags cannot leak through text_delta events.
// Exact thought delimiters cannot consume SV comparisons, strings, or comments.
export function removeInlineThinking(raw) {
  const tag = /^<\s*(\/?)\s*(?:think|thinking)\s*>/i;
  const scopeEnds = new Map([['module', 'endmodule'], ['macromodule', 'endmodule'], ['interface', 'endinterface'],
    ['package', 'endpackage'], ['program', 'endprogram'], ['primitive', 'endprimitive'], ['checker', 'endchecker']]);
  const scopes = [];
  const word = /[A-Za-z_$][\w$]*/y;
  const visible = [];
  let cursor = 0, depth = 0, characters = 0, pending = '', rtlFence;
  const preserveThrough = (end) => {
    visible.push(pending, raw.slice(cursor, end));
    pending = '';
    cursor = end;
  };
  while (cursor < raw.length) {
    if (depth > 0) {
      const match = raw[cursor] === '<' ? tag.exec(raw.slice(cursor)) : null;
      if (match) {
        depth += match[1] ? -1 : 1;
        cursor += match[0].length;
      } else { characters++; cursor++; }
      continue;
    }
    // Track RTL fences while still filtering real delimiters outside source literals.
    if (cursor === 0 || raw[cursor - 1] === '\n') {
      const lineEnd = raw.indexOf('\n', cursor);
      const line = raw.slice(cursor, lineEnd < 0 ? raw.length : lineEnd);
      const fence = /^[ \t]{0,3}(`{3,}|~{3,})(?:[ \t]*(?:systemverilog|verilog|sv))?[ \t]*\r?$/i.exec(line);
      const close = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*\r?$/.exec(line);
      if (rtlFence && close && close[1][0] === rtlFence[0] && close[1].length >= rtlFence.length) {
        rtlFence = undefined;
        preserveThrough(lineEnd < 0 ? raw.length : lineEnd + 1);
        continue;
      }
      if (!rtlFence && fence) {
        rtlFence = fence[1];
        preserveThrough(lineEnd < 0 ? raw.length : lineEnd + 1);
        continue;
      }
    }
    if (raw.startsWith('//', cursor)) {
      const end = raw.indexOf('\n', cursor + 2);
      preserveThrough(end < 0 ? raw.length : end + 1);
      continue;
    }
    if (raw.startsWith('/*', cursor)) {
      const end = raw.indexOf('*/', cursor + 2);
      preserveThrough(end < 0 ? raw.length : end + 2);
      continue;
    }
    if (raw[cursor] === '"') {
      let end = cursor + 1;
      while (end < raw.length) {
        if (raw[end] === '\\') end = Math.min(raw.length, end + 2);
        else if (raw[end++] === '"') break;
      }
      preserveThrough(end);
      continue;
    }
    word.lastIndex = cursor;
    const token = word.exec(raw);
    if (token) {
      if (scopeEnds.has(token[0])) scopes.push(scopeEnds.get(token[0]));
      const protectedToken = scopes.length > 0;
      if (token[0] === scopes.at(-1)) scopes.pop();
      if (protectedToken) preserveThrough(cursor + token[0].length);
      else { pending += token[0]; cursor += token[0].length; }
      continue;
    }
    if (raw[cursor] === '<') {
      const match = tag.exec(raw.slice(cursor));
      if (match) {
        const left = raw.slice(0, cursor).trimEnd().at(-1) ?? '';
        const right = raw.slice(cursor + match[0].length).trimStart()[0] ?? '';
        if (!match[1] && (scopes.length || rtlFence) && /[\w$\])}]/.test(left) && /[\w$('"!~{+\-]/.test(right)) {
          preserveThrough(cursor + match[0].length); // For example: a < think > b.
          continue;
        }
        if (match[1]) characters += pending.length; // A provider may omit the opening prefill tag.
        else { visible.push(pending); depth = 1; }
        pending = '';
        cursor += match[0].length;
        continue;
      }
      // A cut-off delimiter alone is not response text; do not treat expressions as tags.
      if (!scopes.length && !rtlFence && /^<\s*(?:think|thinking)\s*$/i.test(raw.slice(cursor))) break;
    }
    pending += raw[cursor++];
  }
  visible.push(pending);
  return { text: visible.join(''), characters };
}

function resolveApiKey(config) {
  if (config.apiKeyEnv !== undefined) {
    if (typeof config.apiKeyEnv !== 'string' || !config.apiKeyEnv.trim()) {
      throw configurationError('model.apiKeyEnv must be an environment variable name.');
    }
    const value = process.env[config.apiKeyEnv];
    if (!value) throw configurationError('The configured model API-key environment variable is not set.');
    return value;
  }
  if (config.apiKey !== undefined && (typeof config.apiKey !== 'string' || !config.apiKey)) {
    throw configurationError('model.apiKey must be a non-empty string when supplied.');
  }
  // Do not discover ambient cloud credentials for a keyless local endpoint.
  return config.apiKey ?? 'local-placeholder';
}

/**
 * Make exactly one model request through a fresh, tool-free Pi Agent.
 * onEvent is observational: it receives safe metadata/text deltas, never raw
 * Pi events, credentials, provider response bodies, or reasoning text.
 * Usage is Pi's provider-reported usage; absent server usage remains zero on
 * normal completion, but is explicitly unknown (null) after early cancellation.
 */
export async function generateRtl({ model, systemPrompt, prompt, signal, onEvent, thinkingLevel, outputPolicy, candidateGate } = {}) {
  const options = prepareModel(model, thinkingLevel);
  if (typeof systemPrompt !== 'string' || typeof prompt !== 'string' || !prompt.trim()) {
    throw configurationError('systemPrompt and a non-empty prompt must be strings.');
  }
  if (signal?.aborted) throw new ModelGenerationError('MODEL_ABORTED', 'Model generation was cancelled.');
  if (onEvent !== undefined && typeof onEvent !== 'function') throw configurationError('onEvent must be a function.');
  checkOutputPolicy('', outputPolicy);
  if(candidateGate!==undefined&&typeof candidateGate?.push!=='function')throw configurationError('Invalid candidate gate.');
  const apiKey = resolveApiKey(model);
  const redact = (text) => String(text ?? '').split(apiKey).join('[REDACTED]');
  const emit = (event) => {
    if (!onEvent) return;
    // Observers cannot keep a model request alive after its deadline.
    try { Promise.resolve(onEvent(event)).catch(() => {}); } catch { /* observer only */ }
  };
  const controller = new AbortController();
  let cancellationCode;
  let response;
  let requestCount = 0;
  let textBuffer = '';
  let policyCheckedAt = 0;
  let thinkingCharacters = 0;
  const startedAt = performance.now();
  let firstTokenMs = null;
  let requestParameters = null;
  let serverTiming = null;
  let handoff = null;
  let unexpectedToolCall = false;
  const responseText = () => response?.content?.filter(block => block.type === 'text').map(block => block.text).join('') ?? textBuffer;
  const responseDetails = () => ({ stopReason: response?.stopReason, usage: response?.usage, modelId: options.piModel.id,
    responseReceived: Boolean(response), visibleTextChars: removeInlineThinking(responseText()).text.length,
    timing: { wallMs: performance.now() - startedAt, firstTokenMs, ...(serverTiming ? {server:serverTiming} : {}) },
    requestParameters,
    thinking: { ...options.thinking, observedCharacters: thinkingCharacters + removeInlineThinking(responseText()).characters,
      maxTokens: options.maxTokens } });
  const agent = new Agent({
    initialState: {
      model: options.piModel,
      systemPrompt,
      thinkingLevel: options.thinking.requestedLevel,
      tools: [],
      messages: [],
    },
    // Even an unsolicited tool call must never create a follow-up request.
    finishTurn: () => ({ action: 'end' }),
    streamFn: (piModel, context, agentOptions) => {
      requestCount += 1;
      emit({ type: 'request_start', modelId: piModel.id, requestCount });
      return streamCompletions(piModel, context, {
        fetch: async (...args) => observeServerTiming(await globalThis.fetch(...args),timing=>{serverTiming=timing;}),
        apiKey,
        signal: AbortSignal.any([controller.signal, agentOptions.signal]),
        timeoutMs: options.timeoutMs,
        maxRetries: 0,
        maxTokens: options.maxTokens,
        reasoningEffort: model.reasoning ? options.thinking.requestedLevel : undefined,
        temperature: options.temperature,
        cacheRetention: 'none',
        samplingParams: options.topP === undefined ? {} : { top_p: options.topP },
        onPayload: (body) => {
          const payload = { ...body, ...options.extraBody,
          ...(model.reasoningBudget !== undefined ? { reasoning_budget_tokens: model.reasoningBudget } : {}),
          ...(options.thinking.format?.startsWith('qwen-template') ? { chat_template_kwargs: {
            ...body.chat_template_kwargs, ...options.extraBody.chat_template_kwargs,
          } } : {}),
          };
          const keys = ['model', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'top_k', 'min_p', 'seed', 'repeat_penalty', 'cache_prompt', 'reasoning_budget_tokens', 'reasoning_effort', 'chat_template_kwargs'];
          requestParameters = Object.fromEntries(keys.filter(key => payload[key] !== undefined).map(key => [key,
            key === 'chat_template_kwargs' ? Object.fromEntries(['enable_thinking', 'reasoning_effort'].filter(k => payload[key]?.[k] !== undefined).map(k => [k, payload[key][k]])) : payload[key]]));
          return payload;
        },
      });
    },
  });
  const unsubscribe = agent.subscribe((event) => {
    if (event.type === 'message_update') {
      const update = event.assistantMessageEvent;
      if(update.type.startsWith('toolcall_'))unexpectedToolCall=true;
      if (firstTokenMs === null && ['text_delta', 'thinking_delta'].includes(update.type) && update.delta) firstTokenMs = performance.now() - startedAt;
      if (update.type === 'text_delta') {
        textBuffer += update.delta;
        if(candidateGate&&!unexpectedToolCall&&!cancellationCode&&!signal?.aborted) {
          handoff=candidateGate.push(update.delta);
          if(handoff) {
            emit({type:'candidate_ready',...handoff.metadata});
            cancel('MODEL_CANDIDATE_READY');
          }
        }
        if (outputPolicy && textBuffer.length - policyCheckedAt >= 32) {
          policyCheckedAt = textBuffer.length;
          const violation = checkOutputPolicy(removeInlineThinking(textBuffer).text, outputPolicy);
          if (violation) cancel(violation);
        }
      }
      if (update.type === 'thinking_delta') {
        thinkingCharacters += update.delta.length;
        emit({ type: 'thinking_delta', characters: update.delta.length });
      }
    }
    if (event.type === 'message_end' && event.message.role === 'assistant') response = event.message;
  });
  const cancel = (code) => {
    // A user cancellation/deadline always takes precedence over candidate capture.
    if(!cancellationCode||cancellationCode==='MODEL_CANDIDATE_READY')cancellationCode=code;
    controller.abort();
    agent.abort();
  };
  const onAbort = () => cancel('MODEL_ABORTED');
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => cancel('MODEL_TIMEOUT'), options.timeoutMs);
  try {
    if (signal?.aborted) onAbort();
    await agent.prompt(prompt);
    if(signal?.aborted)cancel('MODEL_ABORTED');
    if (!cancellationCode && checkOutputPolicy(removeInlineThinking(responseText()).text, outputPolicy)) cancellationCode = 'MODEL_OUTPUT_POLICY';
    // Only a normal provider EOS can flush an unterminated closing-wrapper line.
    // A gap, token limit, timeout, user cancellation or tool response is not EOS.
    if(!cancellationCode&&response?.stopReason==='stop'&&candidateGate&&!unexpectedToolCall
      &&!response.content.some(block=>block.type==='toolCall')) {
      handoff=candidateGate.finish?.()??null;
      if(handoff) {
        cancellationCode='MODEL_CANDIDATE_READY';
        emit({type:'candidate_ready',...handoff.metadata});
        if(signal?.aborted)cancel('MODEL_ABORTED');
      }
    }
    const details = responseDetails();
    if(cancellationCode==='MODEL_CANDIDATE_READY'&&handoff) {
      if(unexpectedToolCall||response?.content?.some(block=>block.type==='toolCall'))throw new ModelGenerationError('MODEL_UNEXPECTED_RESPONSE','Unexpected tool response.',details);
      const text=redact(handoff.text);
      const result={...details,text,stopReason:'handoff',providerStopReason:details.stopReason,
        usage:details.usage?.totalTokens>0?details.usage:null,usageStatus:'partial_or_unavailable_after_handoff',
        handoff:{...handoff.metadata,client_stream_settled:true,backend_idle_confirmed:false}};
      emit({type:'text_delta',delta:text});emit({type:'response',...result,text:undefined,requestCount});
      return result;
    }
    if (cancellationCode) {
      throw new ModelGenerationError(cancellationCode,
        cancellationCode === 'MODEL_OUTPUT_POLICY' ? 'Output draft exceeded the comment budget; return final RTL without comments or deliberation.'
          : cancellationCode === 'MODEL_TIMEOUT' ? 'Model generation exceeded requestTimeoutMs.' : 'Model generation was cancelled.', details);
    }
    if (!response) throw new ModelGenerationError('MODEL_EMPTY', 'The model returned no assistant response.', details);
    if (response.stopReason === 'length') {
      throw new ModelGenerationError('MODEL_TRUNCATED', 'Model output hit the token limit; incomplete RTL was rejected.', details);
    }
    if (response.stopReason === 'error' || response.stopReason === 'aborted') {
      throw new ModelGenerationError('MODEL_REQUEST_FAILED', 'Model request failed; provider response text was withheld.', details);
    }
    if (response.stopReason !== 'stop' || response.content.some((block) => block.type === 'toolCall')) {
      throw new ModelGenerationError('MODEL_UNEXPECTED_RESPONSE', 'The model did not finish with a normal text response.', details);
    }
    const text = redact(removeInlineThinking(responseText()).text);
    if (!text.trim()) throw new ModelGenerationError('MODEL_EMPTY', 'The model returned no RTL text.', details);
    emit({ type: 'text_delta', delta: text });
    emit({ type: 'response', ...details, requestCount });
    return { text, ...details };
  } catch (error) {
    const failure = error instanceof ModelGenerationError ? error : new ModelGenerationError(
      cancellationCode ?? 'MODEL_REQUEST_FAILED',
      cancellationCode === 'MODEL_TIMEOUT' ? 'Model generation exceeded requestTimeoutMs.'
        : cancellationCode === 'MODEL_ABORTED' ? 'Model generation was cancelled.'
          : 'Model request failed; provider response text was withheld.', responseDetails(),
    );
    emit({ type: 'error', code: failure.code, modelId: options.piModel.id, requestCount, thinking: failure.thinking });
    throw failure;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    unsubscribe();
  }
}
