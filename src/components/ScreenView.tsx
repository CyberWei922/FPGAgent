import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Gamepad2,
  Grid2x2,
  RotateCcw,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useI18n } from '../services/i18n';
import type { BoardInputs, BoardOutputs } from '../types/contracts';
import { OLED_TINT_CONFIG, OledScreen, type OledTint } from './OledScreen';
import { ClockControls, type ClockSpeed } from './TopBar';
import { VirtualBoard } from './VirtualBoard';

export type ScreenKeyLayout = 'dpad' | 'classic';

type KeyTarget = { kind: 'key'; index: number } | { kind: 'rst' };

const COMMON_KEY_CODES: Record<string, KeyTarget> = {
  Digit1: { kind: 'key', index: 0 },
  Numpad1: { kind: 'key', index: 0 },
  Digit2: { kind: 'key', index: 1 },
  Numpad2: { kind: 'key', index: 1 },
  Digit3: { kind: 'key', index: 2 },
  Numpad3: { kind: 'key', index: 2 },
  Digit4: { kind: 'key', index: 3 },
  Numpad4: { kind: 'key', index: 3 },
  KeyR: { kind: 'rst' },
};

const DPAD_KEY_CODES: Record<string, KeyTarget> = {
  KeyW: { kind: 'key', index: 0 },
  ArrowUp: { kind: 'key', index: 0 },
  KeyS: { kind: 'key', index: 1 },
  ArrowDown: { kind: 'key', index: 1 },
  KeyA: { kind: 'key', index: 2 },
  ArrowLeft: { kind: 'key', index: 2 },
  KeyD: { kind: 'key', index: 3 },
  ArrowRight: { kind: 'key', index: 3 },
};

const DPAD_ARROW_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

function isEditableTarget(node: EventTarget | null): boolean {
  if (!(node instanceof HTMLElement)) return false;
  if (node.isContentEditable) return true;
  const tag = node.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return Boolean(node.closest('input, textarea, select, [contenteditable="true"], [role="textbox"], dialog[open]'));
}

function resolveScreenKey(
  event: globalThis.KeyboardEvent,
  layout: ScreenKeyLayout,
): { id: string; target: KeyTarget } | null {
  if (layout === 'dpad' && event.code && DPAD_KEY_CODES[event.code]) {
    return { id: event.code, target: DPAD_KEY_CODES[event.code] };
  }
  if (event.code && COMMON_KEY_CODES[event.code]) {
    return { id: event.code, target: COMMON_KEY_CODES[event.code] };
  }
  const lower = event.key.toLowerCase();
  if (layout === 'dpad') {
    if (lower === 'w' || event.key === 'ArrowUp') return { id: `k:${event.key}`, target: { kind: 'key', index: 0 } };
    if (lower === 's' || event.key === 'ArrowDown') return { id: `k:${event.key}`, target: { kind: 'key', index: 1 } };
    if (lower === 'a' || event.key === 'ArrowLeft') return { id: `k:${event.key}`, target: { kind: 'key', index: 2 } };
    if (lower === 'd' || event.key === 'ArrowRight') return { id: `k:${event.key}`, target: { kind: 'key', index: 3 } };
  }
  if (lower === '1') return { id: 'k:1', target: { kind: 'key', index: 0 } };
  if (lower === '2') return { id: 'k:2', target: { kind: 'key', index: 1 } };
  if (lower === '3') return { id: 'k:3', target: { kind: 'key', index: 2 } };
  if (lower === '4') return { id: 'k:4', target: { kind: 'key', index: 3 } };
  if (lower === 'r') return { id: 'k:r', target: { kind: 'rst' } };
  return null;
}

const bit = (value: number, index: number) => Boolean(value & (1 << index));

function KeyButton({
  className,
  ariaLabel,
  title,
  pressed,
  disabled,
  onPress,
  children,
}: {
  className?: string;
  ariaLabel: string;
  title: string;
  pressed: boolean;
  disabled: boolean;
  onPress: (down: boolean) => void;
  children: ReactNode;
}) {
  function onKey(event: KeyboardEvent<HTMLButtonElement>, down: boolean) {
    if (![' ', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    if (!event.repeat) onPress(down);
  }

  return (
    <button
      type="button"
      className={className ? `screen-key-btn ${className}` : 'screen-key-btn'}
      aria-label={ariaLabel}
      title={title}
      data-pressed={pressed}
      disabled={disabled}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        onPress(true);
      }}
      onPointerUp={() => onPress(false)}
      onPointerCancel={() => onPress(false)}
      onKeyDown={(event) => onKey(event, true)}
      onKeyUp={(event) => onKey(event, false)}
      onClick={(event) => {
        if (event.detail !== 0) return;
        onPress(true);
        onPress(false);
      }}
      onBlur={() => {
        if (pressed) onPress(false);
      }}
    >
      {children}
    </button>
  );
}

const TINT_ORDER: OledTint[] = ['white', 'green', 'ice'];

export function ScreenView({
  screenBuffer,
  hasScreenOutput,
  compiled,
  filename,
  cycle,
  inputs,
  outputs,
  onInputsChange,
  speed,
  running,
  onSpeed,
  onToggle,
  onStep,
  keyLayout,
  onKeyLayoutChange,
}: {
  screenBuffer?: number[];
  hasScreenOutput: boolean;
  compiled: boolean;
  filename?: string;
  cycle?: number;
  inputs: BoardInputs;
  outputs?: BoardOutputs;
  onInputsChange: (inputs: BoardInputs) => void;
  speed: ClockSpeed;
  running: boolean;
  onSpeed: (speed: ClockSpeed) => void;
  onToggle: () => void;
  onStep: () => void;
  keyLayout: ScreenKeyLayout;
  onKeyLayoutChange: (layout: ScreenKeyLayout) => void;
}) {
  const { locale, L } = useI18n();
  const [tint, setTint] = useState<OledTint>('white');

  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;
  const onInputsChangeRef = useRef(onInputsChange);
  onInputsChangeRef.current = onInputsChange;

  const keyboardHeldRef = useRef(new Map<string, KeyTarget>());
  const pointerHeldRef = useRef({ keyMask: 0, rst: false });

  const syncPressedInputs = useCallback(() => {
    let keyMask = pointerHeldRef.current.keyMask;
    let rstPressed = pointerHeldRef.current.rst;
    for (const target of keyboardHeldRef.current.values()) {
      if (target.kind === 'key') keyMask |= 1 << target.index;
      else rstPressed = true;
    }
    const nextRstN: 0 | 1 = rstPressed ? 0 : 1;
    const prev = inputsRef.current;
    if (prev.key === keyMask && prev.rst_n === nextRstN) return;
    onInputsChangeRef.current({ ...prev, key: keyMask, rst_n: nextRstN });
  }, []);

  const releaseAllKeyboard = useCallback(() => {
    if (keyboardHeldRef.current.size === 0) return;
    keyboardHeldRef.current.clear();
    syncPressedInputs();
  }, [syncPressedInputs]);

  useEffect(() => {
    if (!compiled) {
      keyboardHeldRef.current.clear();
      pointerHeldRef.current = { keyMask: 0, rst: false };
      return;
    }

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isEditableTarget(event.target) || isEditableTarget(document.activeElement)) return;
      const resolved = resolveScreenKey(event, keyLayout);
      if (!resolved) return;
      if (keyLayout === 'dpad' && DPAD_ARROW_KEYS.has(event.key)) {
        event.preventDefault();
      }
      if (event.repeat || keyboardHeldRef.current.has(resolved.id)) return;
      keyboardHeldRef.current.set(resolved.id, resolved.target);
      syncPressedInputs();
    };

    const handleKeyUp = (event: globalThis.KeyboardEvent) => {
      const resolved = resolveScreenKey(event, keyLayout);
      if (!resolved) return;
      if (!keyboardHeldRef.current.delete(resolved.id)) return;
      syncPressedInputs();
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (isEditableTarget(event.target)) releaseAllKeyboard();
    };

    const handleVisibilityChange = () => {
      if (document.hidden) releaseAllKeyboard();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', releaseAllKeyboard);
    document.addEventListener('focusin', handleFocusIn);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', releaseAllKeyboard);
      document.removeEventListener('focusin', handleFocusIn);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      releaseAllKeyboard();
    };
  }, [compiled, keyLayout, releaseAllKeyboard, syncPressedInputs]);

  function setPointerKey(index: number, down: boolean) {
    pointerHeldRef.current.keyMask = down
      ? pointerHeldRef.current.keyMask | (1 << index)
      : pointerHeldRef.current.keyMask & ~(1 << index);
    syncPressedInputs();
  }

  function setPointerRst(down: boolean) {
    pointerHeldRef.current.rst = down;
    syncPressedInputs();
  }

  const disabled = !compiled;

  return (
    <div className="wb-screen-view">
      <div className="schematic-subheader">
        <div className="schematic-title">
          <h2>{L('单色 OLED 屏幕', 'Monochrome OLED')}</h2>
          <span className="file-chip mono">16×8 · 128×64</span>
          {filename && <span className="file-chip mono">{filename}</span>}
          {cycle !== undefined && <span className="instrument-meta mono">CLK ↑ {cycle}</span>}
        </div>

        <div className="screen-subheader-right">
          <div className="oled-tint-picker" role="group" aria-label={L('单色屏荧光色', 'Monochrome phosphor tint')}>
            {TINT_ORDER.map((id) => {
              const cfg = OLED_TINT_CONFIG[id];
              const active = tint === id;
              return (
                <button
                  key={id}
                  type="button"
                  className={`oled-tint-dot${active ? ' active' : ''}`}
                  aria-pressed={active}
                  title={L(`单色屏：${cfg.labelZh}`, `Monochrome: ${cfg.labelEn}`)}
                  aria-label={L(`单色屏：${cfg.labelZh}`, `Monochrome: ${cfg.labelEn}`)}
                  onClick={() => setTint(id)}
                >
                  <span style={{ background: cfg.lit }} />
                </button>
              );
            })}
          </div>

          <ClockControls
            speed={speed}
            running={running}
            disabled={disabled}
            showFast
            onSpeed={onSpeed}
            onToggle={onToggle}
            onStep={onStep}
          />
        </div>
      </div>

      <div className="screen-stage">
        <div className="screen-stage-inner">
          <div className="oled-chassis">
            <OledScreen
              buffer={hasScreenOutput ? screenBuffer : undefined}
              tint={tint}
              ariaLabel={L('16×8 单色 OLED 屏幕 (128×64 像素)', '16×8 Monochrome OLED Screen (128×64 px)')}
            />
          </div>

          {!compiled ? (
            <p className="screen-idle-note">
              {L(
                '当前尚未载入电路。可从左侧「案例」运行贪吃蛇，或选择带 OLED 屏幕的板卡生成新电路。',
                'No circuit loaded yet. Run the Snake demo from Demos or select an OLED board to generate one.',
              )}
            </p>
          ) : !hasScreenOutput ? (
            <p className="screen-idle-note">
              {L(
                '当前电路未驱动 screen_x/y/data/cmd 端口，屏幕保持待机黑屏。',
                'The active circuit does not drive screen_x/y/data/cmd ports; OLED remains idle.',
              )}
            </p>
          ) : null}

          <section className="screen-controls-dock" aria-label={L('屏幕按键控制区', 'Screen Key Controls')}>
            <div className="screen-controls-head">
              <span className="screen-controls-title">
                {keyLayout === 'dpad'
                  ? L('方向键控制（KEY0–KEY3）', 'D-Pad Controls (KEY0–KEY3)')
                  : L('经典四按键（KEY0–KEY3）', 'Classic Keys (KEY0–KEY3)')}
              </span>
              <div className="screen-layout-switch" role="group" aria-label={L('按键排布切换', 'Key layout switch')}>
                <button
                  type="button"
                  aria-pressed={keyLayout === 'dpad'}
                  onClick={() => onKeyLayoutChange('dpad')}
                >
                  <Gamepad2 size={12} />
                  <span>{L('方向键', 'D-Pad')}</span>
                </button>
                <button
                  type="button"
                  aria-pressed={keyLayout === 'classic'}
                  onClick={() => onKeyLayoutChange('classic')}
                >
                  <Grid2x2 size={12} />
                  <span>{L('经典排布', 'Classic')}</span>
                </button>
              </div>
            </div>

            {keyLayout === 'dpad' ? (
              <div className="screen-dpad-row">
                <div className="dpad-cluster" role="group" aria-label={L('上下左右方向键', 'Directional pad')}>
                  <div className="dpad-spacer" aria-hidden="true" />
                  <KeyButton
                    className="dpad-btn"
                    ariaLabel={L('上 · KEY0（快捷键 W / ↑）', 'Up · KEY0 (W / Up)')}
                    title={L('上 · KEY0（键盘 W / ↑ / 1）', 'Up · KEY0 (W / ArrowUp / 1)')}
                    pressed={bit(inputs.key, 0)}
                    disabled={disabled}
                    onPress={(down) => setPointerKey(0, down)}
                  >
                    <ArrowUp size={16} strokeWidth={2.3} />
                    <span className="dpad-meta">
                      <kbd>W</kbd>
                      <small>K0</small>
                    </span>
                  </KeyButton>
                  <div className="dpad-spacer" aria-hidden="true" />

                  <KeyButton
                    className="dpad-btn"
                    ariaLabel={L('左 · KEY2（快捷键 A / ←）', 'Left · KEY2 (A / Left)')}
                    title={L('左 · KEY2（键盘 A / ← / 3）', 'Left · KEY2 (A / ArrowLeft / 3)')}
                    pressed={bit(inputs.key, 2)}
                    disabled={disabled}
                    onPress={(down) => setPointerKey(2, down)}
                  >
                    <ArrowLeft size={16} strokeWidth={2.3} />
                    <span className="dpad-meta">
                      <kbd>A</kbd>
                      <small>K2</small>
                    </span>
                  </KeyButton>
                  <KeyButton
                    className="dpad-btn"
                    ariaLabel={L('下 · KEY1（快捷键 S / ↓）', 'Down · KEY1 (S / Down)')}
                    title={L('下 · KEY1（键盘 S / ↓ / 2）', 'Down · KEY1 (S / ArrowDown / 2)')}
                    pressed={bit(inputs.key, 1)}
                    disabled={disabled}
                    onPress={(down) => setPointerKey(1, down)}
                  >
                    <ArrowDown size={16} strokeWidth={2.3} />
                    <span className="dpad-meta">
                      <kbd>S</kbd>
                      <small>K1</small>
                    </span>
                  </KeyButton>
                  <KeyButton
                    className="dpad-btn"
                    ariaLabel={L('右 · KEY3（快捷键 D / →）', 'Right · KEY3 (D / Right)')}
                    title={L('右 · KEY3（键盘 D / → / 4）', 'Right · KEY3 (D / ArrowRight / 4)')}
                    pressed={bit(inputs.key, 3)}
                    disabled={disabled}
                    onPress={(down) => setPointerKey(3, down)}
                  >
                    <ArrowRight size={16} strokeWidth={2.3} />
                    <span className="dpad-meta">
                      <kbd>D</kbd>
                      <small>K3</small>
                    </span>
                  </KeyButton>
                </div>

                <div className="dpad-side-actions">
                  <KeyButton
                    className="rst-btn"
                    ariaLabel={L('硬件复位 RST（快捷键 R）', 'Reset RST (shortcut R)')}
                    title={L('低电平复位 rst_n=0（键盘 R）', 'Active-low reset rst_n=0 (key R)')}
                    pressed={inputs.rst_n === 0}
                    disabled={disabled}
                    onPress={setPointerRst}
                  >
                    <RotateCcw size={15} strokeWidth={2.1} />
                    <span>RST</span>
                    <kbd>R</kbd>
                  </KeyButton>
                </div>
              </div>
            ) : (
              <div className="screen-classic-keys" role="group" aria-label={L('经典四按键', 'Classic board keys')}>
                {[0, 1, 2, 3].map((index) => (
                  <KeyButton
                    key={index}
                    className="classic-key-btn"
                    ariaLabel={L(`KEY${index}（快捷键 ${index + 1}）`, `KEY${index} (key ${index + 1})`)}
                    title={L(`KEY${index}（键盘 ${index + 1}）`, `KEY${index} (key ${index + 1})`)}
                    pressed={bit(inputs.key, index)}
                    disabled={disabled}
                    onPress={(down) => setPointerKey(index, down)}
                  >
                    <span>KEY{index}</span>
                    <kbd>{index + 1}</kbd>
                  </KeyButton>
                ))}
                <KeyButton
                  className="classic-key-btn"
                  ariaLabel={L('硬件复位 RST（快捷键 R）', 'Reset RST (key R)')}
                  title={L('硬件复位 RST（键盘 R）', 'Reset RST (key R)')}
                  pressed={inputs.rst_n === 0}
                  disabled={disabled}
                  onPress={setPointerRst}
                >
                  <span>RST</span>
                  <kbd>R</kbd>
                </KeyButton>
              </div>
            )}

            <p className="screen-key-hint">
              {keyLayout === 'dpad' ? (
                locale === 'en' ? (
                  <>
                    Keyboard: <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> or <kbd>↑</kbd><kbd>←</kbd><kbd>↓</kbd><kbd>→</kbd> → KEY0–KEY3 · <kbd>R</kbd> Reset
                  </>
                ) : (
                  <>
                    键盘映射：<kbd>W</kbd><kbd>S</kbd><kbd>A</kbd><kbd>D</kbd> 或 <kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd> 对应 KEY0–KEY3 · <kbd>R</kbd> 复位
                  </>
                )
              ) : locale === 'en' ? (
                <>
                  Keyboard: <kbd>1</kbd>–<kbd>4</kbd> → KEY0–KEY3 · <kbd>R</kbd> Reset
                </>
              ) : (
                <>
                  键盘映射：<kbd>1</kbd>–<kbd>4</kbd> 对应 KEY0–KEY3 · <kbd>R</kbd> 复位
                </>
              )}
            </p>
          </section>

          <section className="screen-board-dock" aria-label={L('虚拟 FPGA 板卡', 'Virtual FPGA Board')}>
            <div className="screen-board-dock-head">
              <h2>{L('虚拟板卡', 'Virtual Board')}</h2>
              {cycle !== undefined && <span className="instrument-meta mono">CLK ↑ {cycle}</span>}
            </div>
            <VirtualBoard
              inputs={inputs}
              outputs={outputs}
              onInputsChange={onInputsChange}
              disabled={!compiled}
            />
          </section>
        </div>
      </div>
    </div>
  );
}
