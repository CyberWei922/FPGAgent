import type { RtlEngineFactory } from '../types/contracts';
import { createMockRtlEngine } from './mock';

// 队友 1：实现真实引擎后，把这里替换为真实工厂函数。
export const createRtlEngine: RtlEngineFactory = createMockRtlEngine;
