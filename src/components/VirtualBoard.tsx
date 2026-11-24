import type { KeyboardEvent } from 'react';
import type { BoardInputs, BoardOutputs } from '../types/contracts';

const bit = (value: number, index: number) => Boolean(value & (1 << index));
const indexes = (length: number) => Array.from({ length }, (_, index) => length - 1 - index);
const TRAFFIC = [{ bit: 2, name: '红灯', color: 'red' }, { bit: 1, name: '黄灯', color: 'yellow' }, { bit: 0, name: '绿灯', color: 'green' }];

function Momentary({ name, pressed, disabled, onPress }: {
  name: string;
  pressed: boolean;
  disabled: boolean;
  onPress: (down: boolean) => void;
}) {
  function keyEvent(event: KeyboardEvent<HTMLButtonElement>, down: boolean) {
    if (![' ', 'Enter'].includes(event.key)) return;
    event.preventDefault();
    if (!event.repeat) onPress(down);
  }

  return <button
    type="button"
    className="board-key"
    aria-label={name}
    data-pressed={pressed}
    disabled={disabled}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      onPress(true);
    }}
    onPointerUp={() => onPress(false)}
    onPointerCancel={() => onPress(false)}
    onKeyDown={(event) => keyEvent(event, true)}
    onKeyUp={(event) => keyEvent(event, false)}
    onClick={(event) => {
      if (event.detail !== 0) return;
      onPress(true);
      onPress(false);
    }}
    onBlur={() => { if (pressed) onPress(false); }}
  >{name}</button>;
}

export function VirtualBoard({ inputs, outputs, onInputsChange, disabled = false, lockDemo = false }: {
  inputs: BoardInputs;
  outputs?: BoardOutputs;
  onInputsChange: (inputs: BoardInputs) => void;
  disabled?: boolean;
  lockDemo?: boolean;
}) {
  const out = outputs ?? { led: 0, traffic: 0, seg: 0 };
  const digits = outputs ? out.seg.toString(16).toUpperCase().padStart(4, '0') : '----';
  return (
    <div className="virtual-board">
      <div className="board-display">
        {lockDemo ? (
          <div className="lock-status" data-open={bit(out.led, 0)}><span className="lamp green" data-on={bit(out.led, 0)} />{bit(out.led, 0) ? '已开锁' : '已锁定'}</div>
        ) : (
          <div className="traffic-lights" aria-label="交通信号灯">
            {TRAFFIC.map((light) => <span role="img" key={light.bit} aria-label={`${light.name}${bit(out.traffic, light.bit) ? '亮' : '灭'}`} className={`lamp ${light.color}`} data-on={bit(out.traffic, light.bit)} />)}
          </div>
        )}
        <output className="seven-seg" aria-label="数码管读数">{digits}</output>
      </div>
      <div className="board-keybank" role="group" aria-label="板卡按键">
        {[0, 1, 2, 3].map((index) => <Momentary key={index} name={`KEY${index}`} pressed={bit(inputs.key, index)} disabled={disabled}
          onPress={(down) => onInputsChange({ ...inputs, key: down ? inputs.key | (1 << index) : inputs.key & ~(1 << index) })} />)}
        <Momentary name="RST" pressed={inputs.rst_n === 0} disabled={disabled} onPress={(down) => onInputsChange({ ...inputs, rst_n: down ? 0 : 1 })} />
      </div>
      <div className="board-row">
        <span>LED[7:0]</span>
        <div className="led-bank" role="group" aria-label="发光二极管">
          {indexes(8).map((index) => <span key={index} role="img" aria-label={`LED${index}${bit(out.led, index) ? '亮' : '灭'}`} data-on={bit(out.led, index)} />)}
        </div>
      </div>
      <div className="board-row switch-row">
        <span>SW[7:0]</span>
        <div className="switch-bank" role="group" aria-label="拨码开关">
          {indexes(8).map((index) => <button key={index} type="button" title={`SW${index}`} aria-label={`SW${index}`} aria-pressed={bit(inputs.sw, index)}
            disabled={disabled} onClick={() => onInputsChange({ ...inputs, sw: inputs.sw ^ (1 << index) })}><span /><small>{index}</small></button>)}
        </div>
      </div>
    </div>
  );
}
