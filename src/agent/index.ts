import type { AgentRuntimeFactory } from '../types/contracts';
import { createHarnessAgentRuntime } from './harness';

export const createAgentRuntime: AgentRuntimeFactory = createHarnessAgentRuntime;