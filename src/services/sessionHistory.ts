import type { AgentBlueprint, TestVectorStep } from '../types/contracts';

export interface HistoryEntry {
  id: string;
  title: string;
  prompt: string;
  filename: string;
  version: number;
  code: string;
  vectors: TestVectorStep[];
  blueprint: AgentBlueprint;
  presetId?: string;
  passedChecks?: number;
  totalChecks?: number;
  modelUsed?: string;
  timestamp: number;
}

const HISTORY_STORAGE_KEY = 'fpgagent.history.v1';
const MAX_ENTRIES = 16;

export function loadHistoryEntries(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is HistoryEntry => Boolean(item && typeof item.id === 'string' && typeof item.code === 'string'));
  } catch {
    return [];
  }
}

export function saveHistoryEntry(entry: HistoryEntry): HistoryEntry[] {
  const existing = loadHistoryEntries().filter((item) => item.id !== entry.id);
  const next = [entry, ...existing].slice(0, MAX_ENTRIES);
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore quota errors.
  }
  return next;
}

export function deleteHistoryEntry(id: string): HistoryEntry[] {
  const next = loadHistoryEntries().filter((item) => item.id !== id);
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage errors.
  }
  return next;
}

export function clearHistoryEntries(): void {
  try {
    localStorage.removeItem(HISTORY_STORAGE_KEY);
  } catch {
    // Ignore storage errors.
  }
}
