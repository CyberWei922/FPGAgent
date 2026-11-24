import type { AgentRuntimeFactory } from '../types/contracts';
import { createMockAgentRuntime } from './mock';

// 队友 2：实现真实 Harness 后，把这里替换为真实工厂函数。
export const createAgentRuntime: AgentRuntimeFactory = createMockAgentRuntime;
