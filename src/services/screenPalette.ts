import { SCREEN_PALETTE } from '../engine';

export const SCREEN_PALETTE_STORAGE_KEY = 'fpgagent.screenPalette';
export const SCREEN_PALETTE_EVENT = 'fpgagent:screen-palette';

export type PaletteOverrides = Record<number, string>;

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function isValidColor(hex: string): boolean {
  return HEX_RE.test(hex.trim());
}

export function normalizeHex(hex: string): string {
  return hex.trim().toLowerCase();
}

export function loadPaletteOverrides(): PaletteOverrides {
  if (!isBrowser()) return {};
  try {
    const raw = window.localStorage.getItem(SCREEN_PALETTE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const overrides: PaletteOverrides = {};
    for (const [key, value] of Object.entries(parsed)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= 256) continue;
      if (typeof value !== 'string' || !isValidColor(value)) continue;
      overrides[index] = normalizeHex(value);
    }
    return overrides;
  } catch {
    return {};
  }
}

function emitChange(): void {
  if (!isBrowser()) return;
  window.dispatchEvent(new CustomEvent(SCREEN_PALETTE_EVENT));
}

export function savePaletteOverrides(overrides: PaletteOverrides): void {
  if (!isBrowser()) return;
  try {
    if (Object.keys(overrides).length === 0) {
      window.localStorage.removeItem(SCREEN_PALETTE_STORAGE_KEY);
    } else {
      window.localStorage.setItem(SCREEN_PALETTE_STORAGE_KEY, JSON.stringify(overrides));
    }
  } catch {
    // Ignore storage write failures in restricted environments.
  }
  emitChange();
}

export function setPaletteOverride(index: number, hex: string): PaletteOverrides {
  if (!Number.isInteger(index) || index < 0 || index >= 256 || !isValidColor(hex)) {
    return loadPaletteOverrides();
  }
  const overrides = loadPaletteOverrides();
  overrides[index] = normalizeHex(hex);
  savePaletteOverrides(overrides);
  return overrides;
}

export function clearPaletteOverride(index: number): PaletteOverrides {
  const overrides = loadPaletteOverrides();
  delete overrides[index];
  savePaletteOverrides(overrides);
  return overrides;
}

export function clearAllPaletteOverrides(): void {
  savePaletteOverrides({});
}

/** 渲染层颜色解析：优先用户覆盖值，否则回落引擎默认 256 色板。 */
export function resolveScreenColorHex(index: number): string {
  const safe = index & 0xff;
  const overrides = loadPaletteOverrides();
  return overrides[safe] ?? SCREEN_PALETTE[safe] ?? SCREEN_PALETTE[0];
}

export function paletteSnapshot(): string[] {
  const overrides = loadPaletteOverrides();
  return SCREEN_PALETTE.map((hex, index) => overrides[index] ?? hex);
}

export function subscribePaletteChange(listener: () => void): () => void {
  if (!isBrowser()) return () => {};
  const onCustom = () => listener();
  const onStorage = (event: StorageEvent) => {
    if (event.key === SCREEN_PALETTE_STORAGE_KEY) listener();
  };
  window.addEventListener(SCREEN_PALETTE_EVENT, onCustom);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(SCREEN_PALETTE_EVENT, onCustom);
    window.removeEventListener('storage', onStorage);
  };
}

export function exportPaletteOverrides(): string {
  return JSON.stringify(loadPaletteOverrides(), null, 2);
}

export function importPaletteOverrides(json: string): { ok: boolean; count: number } {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const overrides: PaletteOverrides = {};
    for (const [key, value] of Object.entries(parsed)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= 256) continue;
      if (typeof value !== 'string' || !isValidColor(value)) continue;
      overrides[index] = normalizeHex(value);
    }
    savePaletteOverrides(overrides);
    return { ok: true, count: Object.keys(overrides).length };
  } catch {
    return { ok: false, count: 0 };
  }
}

export const SCREEN_PALETTE_GROUPS = {
  base: { start: 0, end: 15, title: '基础色 0–15（0 为默认荧光色）' },
  cube: { start: 16, end: 231, title: 'RGB 色立方 16–231（6×6×6）' },
  gray: { start: 232, end: 255, title: '灰阶 232–255' },
} as const;
