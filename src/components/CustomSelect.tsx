import { Check, ChevronDown, Search, Settings2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { localizeModelOwnedBy, useI18n } from '../services/i18n';
import type { LLMModelOption } from '../types/contracts';

interface PopoverPos {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  maxHeight: number;
}

export function CustomModelSelect({
  id,
  ariaLabel,
  options,
  value,
  onChange,
  variant = 'field',
  placeholder,
  title,
  quotaNotice,
  footerAction,
}: {
  id?: string;
  ariaLabel?: string;
  options: LLMModelOption[];
  value: string;
  onChange: (modelId: string) => void;
  variant?: 'field' | 'inline';
  placeholder?: string;
  title?: string;
  quotaNotice?: { remaining?: number; limit?: number };
  footerAction?: { label: string; onClick: () => void };
}) {
  const { locale, L } = useI18n();
  const resolvedPlaceholder = placeholder ?? L('选择模型', 'Select model');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pos, setPos] = useState<PopoverPos | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selectedOption = options.find((item) => item.id === value);
  const displayLabel = selectedOption
    ? variant === 'field' && selectedOption.label && selectedOption.label !== selectedOption.id
      ? `${selectedOption.label} (${selectedOption.id})`
      : selectedOption.label ?? selectedOption.id
    : value || resolvedPlaceholder;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (item) =>
        item.id.toLowerCase().includes(q) ||
        (item.label?.toLowerCase().includes(q) ?? false) ||
        (item.ownedBy?.toLowerCase().includes(q) ?? false),
    );
  }, [options, query]);

  const showSearch = options.length > 6;

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;

    const updatePosition = () => {
      if (!triggerRef.current) return;
      const rect = triggerRef.current.getBoundingClientRect();
      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;
      const desiredWidth = variant === 'field' ? rect.width : Math.min(280, Math.max(220, rect.width + 64));
      const left = Math.max(10, Math.min(rect.left, viewportW - desiredWidth - 10));
      const spaceBelow = viewportH - rect.bottom - 12;
      const spaceAbove = rect.top - 12;
      const preferUp = variant === 'inline' ? spaceAbove >= 140 || spaceAbove > spaceBelow : spaceBelow < 210 && spaceAbove > spaceBelow;

      if (preferUp) {
        setPos({
          bottom: viewportH - rect.top + 6,
          left,
          width: desiredWidth,
          maxHeight: Math.min(260, Math.max(120, spaceAbove - 8)),
        });
      } else {
        setPos({
          top: rect.bottom + 6,
          left,
          width: desiredWidth,
          maxHeight: Math.min(260, Math.max(120, spaceBelow - 8)),
        });
      }
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, variant, options.length]);

  useEffect(() => {
    if (!open) {
      setQuery('');
      return;
    }
    if (showSearch) {
      window.setTimeout(() => searchRef.current?.focus(), 0);
    }

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, showSearch]);

  return (
    <div
      ref={rootRef}
      className={variant === 'field' ? 'custom-select-field' : 'model-select-wrap custom-select-inline'}
      title={title ?? displayLabel}
    >
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={variant === 'field' ? 'custom-select-trigger' : 'inline-model-btn'}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="custom-select-value">{displayLabel}</span>
        <ChevronDown size={variant === 'field' ? 15 : 12} className={`custom-select-arrow${open ? ' open' : ''}`} />
      </button>

      {open && pos && (
        <div
          ref={menuRef}
          className="custom-select-menu"
          role="listbox"
          aria-label={ariaLabel ?? L('模型列表', 'Model list')}
          style={{
            position: 'fixed',
            top: pos.top,
            bottom: pos.bottom,
            left: pos.left,
            width: pos.width,
          }}
        >
          {quotaNotice && (
            <div
              className={`custom-select-quota${quotaNotice.remaining === 0 ? ' exhausted' : ''}`}
              role="status"
            >
              <span className="custom-select-quota-label">{L('今日剩余次数', 'Remaining today')}</span>
              <strong className="custom-select-quota-value">
                {quotaNotice.remaining !== undefined
                  ? quotaNotice.limit !== undefined
                    ? L(`${quotaNotice.remaining} / ${quotaNotice.limit} 次`, `${quotaNotice.remaining} / ${quotaNotice.limit}`)
                    : L(`${quotaNotice.remaining} 次`, `${quotaNotice.remaining}`)
                  : quotaNotice.limit !== undefined
                    ? L(`限 ${quotaNotice.limit} 次/日`, `${quotaNotice.limit}/day`)
                    : L('站点默认', 'Site Default')}
              </strong>
            </div>
          )}

          {showSearch && (
            <div className="custom-select-search">
              <Search size={13} />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={L('筛选模型…', 'Filter models…')}
                aria-label={L('筛选模型', 'Filter models')}
              />
            </div>
          )}

          <div className="custom-select-list" style={{ maxHeight: pos.maxHeight }}>
            {filtered.length === 0 ? (
              <div className="custom-select-empty">{L('无匹配模型', 'No matching models')}</div>
            ) : (
              filtered.map((item) => {
                const selected = item.id === value;
                const primary = item.label && item.label !== item.id ? item.label : item.id;
                const secondary =
                  item.label && item.label !== item.id
                    ? item.id
                    : localizeModelOwnedBy(item.ownedBy, locale);
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={`custom-select-option${selected ? ' selected' : ''}`}
                    onClick={() => {
                      onChange(item.id);
                      setOpen(false);
                    }}
                  >
                    <span className="custom-select-option-copy">
                      <span className="custom-select-option-label">{primary}</span>
                      {secondary && <span className="custom-select-option-meta">{secondary}</span>}
                    </span>
                    {selected && <Check size={14} className="custom-select-check" />}
                  </button>
                );
              })
            )}
          </div>

          {footerAction && (
            <div className="custom-select-footer">
              <button
                type="button"
                className="custom-select-footer-btn"
                onClick={() => {
                  setOpen(false);
                  footerAction.onClick();
                }}
              >
                <Settings2 size={13} />
                <span>{footerAction.label}</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
