// Custom dropdown that replaces native <select>. The listbox is portaled to <body> so it can sit above modals,
// is positioned from the trigger's rect (flipping upward when there is no room below), and follows the
// WAI-ARIA combobox pattern: focus stays on the trigger and aria-activedescendant points at the highlighted option.
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string> {
  value: T;
  options: Array<SelectOption<T>>;
  onChange: (value: T) => void;
  ariaLabel?: string;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
}

const MENU_MAX_HEIGHT = 280;
const ROW_HEIGHT = 32;
const VIEWPORT_MARGIN = 8;
const MENU_GAP = 6;

// Percent position of a value within a range, used for the filled part of a range track (--fill).
export function rangeFill(value: number, min: number, max: number): string {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return `${Math.min(100, Math.max(0, pct))}%`;
}

type MenuPosition = { left: number; width: number; maxHeight: number; top?: number; bottom?: number };

function measure(trigger: HTMLElement, optionCount: number): MenuPosition {
  const rect = trigger.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(rect.width, viewportWidth - VIEWPORT_MARGIN * 2);
  const left = Math.min(Math.max(rect.left, VIEWPORT_MARGIN), Math.max(VIEWPORT_MARGIN, viewportWidth - VIEWPORT_MARGIN - width));
  const wanted = Math.min(MENU_MAX_HEIGHT, optionCount * ROW_HEIGHT + 10);
  const spaceBelow = viewportHeight - rect.bottom - VIEWPORT_MARGIN - MENU_GAP;
  const spaceAbove = rect.top - VIEWPORT_MARGIN - MENU_GAP;
  const flip = spaceBelow < wanted && spaceAbove > spaceBelow;
  const available = flip ? spaceAbove : spaceBelow;
  const maxHeight = Math.max(ROW_HEIGHT * 2, Math.min(MENU_MAX_HEIGHT, available));
  return flip
    ? { left, width, maxHeight, bottom: viewportHeight - rect.top + MENU_GAP }
    : { left, width, maxHeight, top: rect.bottom + MENU_GAP };
}

export function Select<T extends string>({ value, options, onChange, ariaLabel, className = '', placeholder = '', disabled = false }: SelectProps<T>) {
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const listId = `${id}-list`;
  const optionId = (index: number) => `${id}-opt-${index}`;

  const enabledIndexes = options.map((option, index) => (option.disabled ? -1 : index)).filter((index) => index >= 0);

  function reposition() {
    if (triggerRef.current) setPosition(measure(triggerRef.current, options.length));
  }

  function openMenu() {
    if (disabled) return;
    const start = selectedIndex >= 0 && !options[selectedIndex].disabled ? selectedIndex : enabledIndexes[0] ?? -1;
    setActive(start);
    if (triggerRef.current) setPosition(measure(triggerRef.current, options.length));
    setOpen(true);
  }

  function closeMenu() {
    setOpen(false);
    setActive(-1);
  }

  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    closeMenu();
    triggerRef.current?.focus();
  }

  useLayoutEffect(() => {
    if (open) reposition();
    // reposition is recreated per render; the menu only depends on open state and the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      closeMenu();
    };
    const onScroll = (event: Event) => {
      if (menuRef.current && event.target instanceof Node && menuRef.current.contains(event.target)) return;
      reposition();
    };
    const onResize = () => reposition();
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || active < 0) return;
    const node = menuRef.current?.querySelector<HTMLElement>(`#${CSS.escape(optionId(active))}`);
    node?.scrollIntoView({ block: 'nearest' });
    // optionId is derived from the stable id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);

  function step(direction: 1 | -1) {
    if (!enabledIndexes.length) return;
    const current = enabledIndexes.indexOf(active);
    const next = current < 0 ? (direction === 1 ? enabledIndexes[0] : enabledIndexes[enabledIndexes.length - 1]) : enabledIndexes[(current + direction + enabledIndexes.length) % enabledIndexes.length];
    setActive(next);
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
        event.preventDefault();
        openMenu();
      }
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        step(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        step(-1);
        break;
      case 'Home':
        event.preventDefault();
        setActive(enabledIndexes[0] ?? -1);
        break;
      case 'End':
        event.preventDefault();
        setActive(enabledIndexes[enabledIndexes.length - 1] ?? -1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (active >= 0) choose(active);
        else closeMenu();
        break;
      case 'Escape':
        // Close only the listbox; keep an enclosing dialog open.
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
        break;
      case 'Tab':
        closeMenu();
        break;
      default:
        break;
    }
  }

  const menuStyle: CSSProperties | undefined = position
    ? { left: position.left, width: position.width, maxHeight: position.maxHeight, top: position.top, bottom: position.bottom }
    : undefined;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        className={`cs-select-trigger${open ? ' open' : ''}${className ? ` ${className}` : ''}`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        disabled={disabled}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span className={`cs-select-value${selected ? '' : ' placeholder'}`}>{selected ? selected.label : placeholder}</span>
        <ChevronDown size={16} className="cs-select-chevron" aria-hidden="true" />
      </button>
      {open && position && createPortal(
        <div ref={menuRef} id={listId} role="listbox" className="cs-select-menu" aria-label={ariaLabel} style={menuStyle}>
          {options.map((option, index) => {
            const isSelected = index === selectedIndex;
            const classes = ['cs-select-option', isSelected ? 'selected' : '', index === active ? 'active' : ''].filter(Boolean).join(' ');
            return (
              <div
                key={option.value}
                id={optionId(index)}
                role="option"
                aria-selected={isSelected}
                aria-disabled={option.disabled || undefined}
                className={classes}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => { if (!option.disabled && active !== index) setActive(index); }}
                onClick={() => choose(index)}
              >
                <span className="cs-select-label">{option.label}</span>
                {isSelected && <Check size={15} className="cs-select-check" aria-hidden="true" />}
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
