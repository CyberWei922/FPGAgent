export type ThemeMode = 'light' | 'dark' | 'system';

export type AccentPresetId = 'nvidia' | 'teal' | 'cobalt' | 'emerald' | 'amber' | 'indigo' | 'crimson' | 'custom';

export interface AccentPreset {
  id: Exclude<AccentPresetId, 'custom'>;
  name: string;
  swatch: string;
  light: {
    accent: string;
    dark: string;
    tint: string;
    tintSoft: string;
    border: string;
    ink: string;
  };
  dark: {
    accent: string;
    dark: string;
    tint: string;
    tintSoft: string;
    border: string;
    ink: string;
  };
}

export interface ThemePreferences {
  mode: ThemeMode;
  accentId: AccentPresetId;
  customAccent: string;
}

const THEME_STORAGE_KEY = 'fpgagent.theme.v2';

export const DEFAULT_THEME: ThemePreferences = {
  mode: 'dark',
  accentId: 'nvidia',
  customAccent: '#76b900',
};

export const ACCENT_PRESETS: AccentPreset[] = [
  {
    id: 'nvidia',
    name: 'NVIDIA 绿',
    swatch: '#76b900',
    light: {
      accent: '#76b900',
      dark: '#5a8f00',
      tint: '#eaf6d4',
      tintSoft: '#f4fae9',
      border: '#a5cf58',
      ink: '#3d6e00',
    },
    dark: {
      accent: '#76b900',
      dark: '#5b8f00',
      tint: '#182406',
      tintSoft: '#101804',
      border: '#3e6109',
      ink: '#9ce619',
    },
  },
  {
    id: 'teal',
    name: '青瓷绿',
    swatch: '#126e71',
    light: {
      accent: '#126e71',
      dark: '#0c5659',
      tint: '#e3f2f1',
      tintSoft: '#eef7f6',
      border: '#badbd8',
      ink: '#0c5659',
    },
    dark: {
      accent: '#2fb8b4',
      dark: '#229d99',
      tint: '#143335',
      tintSoft: '#10282a',
      border: '#215356',
      ink: '#7ee3df',
    },
  },
  {
    id: 'cobalt',
    name: '钴蓝',
    swatch: '#2563eb',
    light: {
      accent: '#2563eb',
      dark: '#1d4ed8',
      tint: '#e7f0fe',
      tintSoft: '#f1f6fe',
      border: '#bfd5fc',
      ink: '#1d4ed8',
    },
    dark: {
      accent: '#60a5fa',
      dark: '#3b82f6',
      tint: '#162742',
      tintSoft: '#111e33',
      border: '#264473',
      ink: '#93c5fd',
    },
  },
  {
    id: 'emerald',
    name: '松石绿',
    swatch: '#0f766e',
    light: {
      accent: '#0d7a5f',
      dark: '#095f4a',
      tint: '#e3f5ef',
      tintSoft: '#eff9f6',
      border: '#b5dfd2',
      ink: '#095f4a',
    },
    dark: {
      accent: '#34d399',
      dark: '#10b981',
      tint: '#12332a',
      tintSoft: '#0e2821',
      border: '#1f5646',
      ink: '#6ee7b7',
    },
  },
  {
    id: 'amber',
    name: '琥珀橙',
    swatch: '#c2650c',
    light: {
      accent: '#b85a08',
      dark: '#924505',
      tint: '#fdf0e2',
      tintSoft: '#fef7ef',
      border: '#f1cfb0',
      ink: '#924505',
    },
    dark: {
      accent: '#f59e0b',
      dark: '#d97706',
      tint: '#362612',
      tintSoft: '#291d0e',
      border: '#60421c',
      ink: '#fcd34d',
    },
  },
  {
    id: 'indigo',
    name: '靛青紫',
    swatch: '#4f46e5',
    light: {
      accent: '#4f46e5',
      dark: '#3f37c9',
      tint: '#ecebfe',
      tintSoft: '#f4f4fe',
      border: '#cac8fb',
      ink: '#3f37c9',
    },
    dark: {
      accent: '#818cf8',
      dark: '#6366f1',
      tint: '#1e1f45',
      tintSoft: '#171836',
      border: '#353775',
      ink: '#a5b4fc',
    },
  },
  {
    id: 'crimson',
    name: '绯红',
    swatch: '#be123c',
    light: {
      accent: '#be123c',
      dark: '#9f1239',
      tint: '#fde8ee',
      tintSoft: '#fef3f6',
      border: '#f5bccb',
      ink: '#9f1239',
    },
    dark: {
      accent: '#fb7185',
      dark: '#f43f5e',
      tint: '#3a1822',
      tintSoft: '#2d121a',
      border: '#67283b',
      ink: '#fda4af',
    },
  },
];

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '').trim();
  const normalized = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return [18, 110, 113];
  return [
    parseInt(normalized.slice(0, 2), 16),
    parseInt(normalized.slice(2, 4), 16),
    parseInt(normalized.slice(4, 6), 16),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${[r, g, b].map((v) => clamp(v).toString(16).padStart(2, '0')).join('')}`;
}

function mixHex(base: string, target: string, ratio: number): string {
  const [r1, g1, b1] = hexToRgb(base);
  const [r2, g2, b2] = hexToRgb(target);
  return rgbToHex(
    r1 + (r2 - r1) * ratio,
    g1 + (g2 - g1) * ratio,
    b1 + (b2 - b1) * ratio,
  );
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function resolveThemeMode(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'light' || mode === 'dark') return mode;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

export function contrastInkOn(hex: string): '#081216' | '#ffffff' {
  return relativeLuminance(hex) > 0.26 ? '#081216' : '#ffffff';
}

export function computeAccentTokens(prefs: ThemePreferences, resolvedMode: 'light' | 'dark') {
  if (prefs.accentId !== 'custom') {
    const preset = ACCENT_PRESETS.find((item) => item.id === prefs.accentId) ?? ACCENT_PRESETS[0];
    const palette = preset[resolvedMode];
    return { ...palette, onAccent: contrastInkOn(palette.accent) };
  }

  const base = /^#[0-9a-fA-F]{6}$/.test(prefs.customAccent) ? prefs.customAccent : DEFAULT_THEME.customAccent;
  if (resolvedMode === 'light') {
    // Darken overly bright custom colors so light-mode controls keep legible contrast.
    const accent = relativeLuminance(base) > 0.4 ? mixHex(base, '#11181c', 0.35) : base;
    const dark = mixHex(accent, '#080e10', 0.22);
    return {
      accent,
      dark,
      tint: mixHex(accent, '#ffffff', 0.87),
      tintSoft: mixHex(accent, '#ffffff', 0.93),
      border: mixHex(accent, '#ffffff', 0.65),
      ink: dark,
      onAccent: contrastInkOn(accent),
    };
  }

  // Lift overly dark custom colors in dark mode.
  const accent = relativeLuminance(base) < 0.18 ? mixHex(base, '#ffffff', 0.36) : base;
  const dark = mixHex(accent, '#091012', 0.18);
  return {
    accent,
    dark,
    tint: mixHex(accent, '#101618', 0.78),
    tintSoft: mixHex(accent, '#101618', 0.86),
    border: mixHex(accent, '#101618', 0.56),
    ink: mixHex(accent, '#ffffff', 0.35),
    onAccent: contrastInkOn(accent),
  };
}

export function loadThemePreferences(): ThemePreferences {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return DEFAULT_THEME;
    const parsed = JSON.parse(raw) as Partial<ThemePreferences>;
    const mode: ThemeMode = parsed.mode === 'dark' || parsed.mode === 'system' || parsed.mode === 'light'
      ? parsed.mode
      : DEFAULT_THEME.mode;
    const validAccent = parsed.accentId === 'custom' || ACCENT_PRESETS.some((p) => p.id === parsed.accentId);
    const accentId: AccentPresetId = validAccent && parsed.accentId ? parsed.accentId : DEFAULT_THEME.accentId;
    const customAccent = typeof parsed.customAccent === 'string' && /^#[0-9a-fA-F]{6}$/.test(parsed.customAccent)
      ? parsed.customAccent
      : DEFAULT_THEME.customAccent;
    return { mode, accentId, customAccent };
  } catch {
    return DEFAULT_THEME;
  }
}

export function saveThemePreferences(prefs: ThemePreferences): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage failures in private browsing.
  }
}

export function applyThemePreferences(prefs: ThemePreferences): 'light' | 'dark' {
  const resolved = resolveThemeMode(prefs.mode);
  if (typeof document === 'undefined') return resolved;
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  const tokens = computeAccentTokens(prefs, resolved);
  root.style.setProperty('--theme-accent', tokens.accent);
  root.style.setProperty('--accent-dark', tokens.dark);
  root.style.setProperty('--accent-tint', tokens.tint);
  root.style.setProperty('--accent-tint-soft', tokens.tintSoft);
  root.style.setProperty('--accent-border', tokens.border);
  root.style.setProperty('--accent-ink', tokens.ink);
  root.style.setProperty('--theme-on-accent', tokens.onAccent);
  return resolved;
}

export function subscribeSystemTheme(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}
