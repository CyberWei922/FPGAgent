import { flushSync } from 'react-dom';
import { collectVerilogTokenBoundaries, extractSafeVerilogPrefix } from '../engine/streamTokenizer';

export type SpatialTransitionKind = 'enter-workbench' | 'return-home';

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function startSpatialTransition(update: () => void, kind?: SpatialTransitionKind): Promise<void> {
  const doc =
    typeof document !== 'undefined'
      ? (document as Document & {
          startViewTransition?: (cb: () => void) => {
            updateCallbackDone?: Promise<void>;
            finished: Promise<void>;
          };
        })
      : undefined;

  if (!doc?.startViewTransition || prefersReducedMotion()) {
    update();
    return Promise.resolve();
  }

  if (kind) doc.documentElement.dataset.vt = kind;
  try {
    const transition = doc.startViewTransition(() => {
      flushSync(update);
    });
    void transition.finished.finally(() => {
      if (kind && doc.documentElement.dataset.vt === kind) {
        delete doc.documentElement.dataset.vt;
      }
    });
    return (transition.updateCallbackDone ?? Promise.resolve()).catch(() => undefined);
  } catch {
    if (kind && doc.documentElement.dataset.vt === kind) {
      delete doc.documentElement.dataset.vt;
    }
    update();
    return Promise.resolve();
  }
}

export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (ms <= 0 || prefersReducedMotion()) return Promise.resolve(!signal?.aborted);
  return new Promise<boolean>((resolve) => {
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function countLinesFast(text: string): number {
  if (!text) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  return lines;
}

export function streamTextSmoothly(
  fullText: string,
  durationMs: number,
  onUpdate: (partial: string) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (!fullText || durationMs <= 0 || prefersReducedMotion()) {
    onUpdate(fullText);
    return Promise.resolve(!signal?.aborted);
  }

  const chars = Array.from(fullText);
  return new Promise<boolean>((resolve) => {
    const start = performance.now();
    let rafId = 0;
    let lastCount = 0;

    const cleanup = () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      cleanup();
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const frame = (now: number) => {
      if (signal?.aborted) {
        cleanup();
        resolve(false);
        return;
      }
      const progress = Math.min(1, (now - start) / durationMs);
      const targetCount = Math.max(1, Math.round(chars.length * progress));
      if (targetCount > lastCount) {
        lastCount = targetCount;
        onUpdate(chars.slice(0, targetCount).join(''));
      }
      if (progress >= 1) {
        cleanup();
        onUpdate(fullText);
        resolve(true);
      } else {
        rafId = window.requestAnimationFrame(frame);
      }
    };

    rafId = window.requestAnimationFrame(frame);
  });
}

export function streamVerilogTokens(
  fullCode: string,
  durationMs: number,
  onUpdate: (partial: string, lines: number) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  const normalized = fullCode.replace(/\r\n/g, '\n');
  if (!normalized || durationMs <= 0 || prefersReducedMotion()) {
    onUpdate(normalized, countLinesFast(normalized));
    return Promise.resolve(!signal?.aborted);
  }

  const boundaries = collectVerilogTokenBoundaries(normalized);
  if (boundaries.length === 0) {
    onUpdate(normalized, countLinesFast(normalized));
    return Promise.resolve(!signal?.aborted);
  }

  return new Promise<boolean>((resolve) => {
    const start = performance.now();
    let rafId = 0;
    let lastIdx = -1;

    const cleanup = () => {
      if (rafId) window.cancelAnimationFrame(rafId);
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      cleanup();
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const frame = (now: number) => {
      if (signal?.aborted) {
        cleanup();
        resolve(false);
        return;
      }
      const progress = Math.min(1, (now - start) / durationMs);
      // Slight ease-out curve gives a natural coding cadence.
      const eased = 1 - Math.pow(1 - progress, 1.15);
      const targetIdx = Math.min(
        boundaries.length - 1,
        Math.max(0, Math.floor(eased * boundaries.length)),
      );
      if (targetIdx > lastIdx) {
        lastIdx = targetIdx;
        const partial = normalized.slice(0, boundaries[targetIdx]);
        onUpdate(partial, countLinesFast(partial));
      }
      if (progress >= 1) {
        cleanup();
        onUpdate(normalized, countLinesFast(normalized));
        resolve(true);
      } else {
        rafId = window.requestAnimationFrame(frame);
      }
    };

    rafId = window.requestAnimationFrame(frame);
  });
}

export interface LiveCodeStreamer {
  push: (rawCode: string, isFinal?: boolean) => void;
  reset: () => void;
  flush: (finalCode?: string) => void;
  stop: () => void;
}

/**
 * Smooths bursty real-LLM SSE Verilog updates into token-boundary steps per animation frame
 * so syntax colors never flicker mid-keyword and code glides into the editor smoothly.
 */
export function createLiveCodeStreamer(
  onUpdate: (partial: string, lines: number) => void,
): LiveCodeStreamer {
  let targetCode = '';
  let boundaries: number[] = [];
  let shownOffset = 0;
  let rafId = 0;

  const schedule = () => {
    if (rafId) return;
    rafId = window.requestAnimationFrame(step);
  };

  const step = () => {
    rafId = 0;
    if (shownOffset >= targetCode.length) return;

    if (prefersReducedMotion()) {
      shownOffset = targetCode.length;
      onUpdate(targetCode, countLinesFast(targetCode));
      return;
    }

    // Find next token boundary strictly after shownOffset; step 1-3 tokens depending on backlog.
    let nextIdx = boundaries.findIndex((b) => b > shownOffset);
    if (nextIdx === -1) {
      shownOffset = targetCode.length;
    } else {
      const remainingTokens = boundaries.length - nextIdx;
      const stride = remainingTokens > 28 ? 4 : remainingTokens > 12 ? 2 : 1;
      const pick = Math.min(boundaries.length - 1, nextIdx + stride - 1);
      shownOffset = boundaries[pick];
    }

    const slice = targetCode.slice(0, shownOffset);
    onUpdate(slice, countLinesFast(slice));

    if (shownOffset < targetCode.length) {
      schedule();
    }
  };

  return {
    push(rawCode: string, isFinal = false) {
      const safe = extractSafeVerilogPrefix(rawCode, isFinal);
      if (safe.length <= targetCode.length && !isFinal) return;
      if (!safe.startsWith(targetCode)) {
        // Code was rewritten from scratch (e.g. new repair pass).
        shownOffset = 0;
      }
      targetCode = safe;
      boundaries = collectVerilogTokenBoundaries(targetCode);
      schedule();
    },
    reset() {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
        rafId = 0;
      }
      targetCode = '';
      boundaries = [];
      shownOffset = 0;
    },
    flush(finalCode?: string) {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
        rafId = 0;
      }
      if (finalCode !== undefined) {
        targetCode = finalCode.replace(/\r\n/g, '\n');
      }
      shownOffset = targetCode.length;
      onUpdate(targetCode, countLinesFast(targetCode));
    },
    stop() {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
        rafId = 0;
      }
    },
  };
}
