import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, X } from 'lucide-react';
import { useI18n } from './i18n';

type CalendarDay = {
  key: string;
  year: number;
  month: number;
  day: number;
  currentMonth: boolean;
};

type YearMonth = { year: number; month: number };

type ExpiryDatePickerProps = {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  className?: string;
};

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function parseDateTimeLocal(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), 0, 0);
  if (Number.isNaN(date.getTime())
    || date.getFullYear() !== Number(match[1])
    || date.getMonth() !== Number(match[2]) - 1
    || date.getDate() !== Number(match[3])
    || date.getHours() !== Number(match[4])
    || date.getMinutes() !== Number(match[5])) return null;
  return date;
}

export function formatDateTimeLocal(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function shiftMonth(year: number, month: number, offset: number): YearMonth {
  const date = new Date(Date.UTC(year, month + offset, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() };
}

export function buildCalendarDays(year: number, month: number): CalendarDay[] {
  const first = new Date(Date.UTC(year, month, 1));
  const start = new Date(Date.UTC(year, month, 1 - first.getUTCDay()));
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + index));
    const currentMonth = date.getUTCFullYear() === year && date.getUTCMonth() === month;
    return {
      key: `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`,
      year: date.getUTCFullYear(),
      month: date.getUTCMonth(),
      day: date.getUTCDate(),
      currentMonth
    };
  });
}

function monthLabel(year: number, month: number, language: 'zh-CN' | 'en-US'): string {
  return language === 'en-US' ? new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long' }).format(new Date(year, month, 1)) : `${year}年${month + 1}月`;
}

function displayValue(value: string, language: 'zh-CN' | 'en-US'): string {
  const date = parseDateTimeLocal(value);
  return date
    ? new Intl.DateTimeFormat(language === 'en-US' ? 'en-US' : 'zh-CN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
    : language === 'en-US' ? 'Choose expiry time' : '选择过期时间';
}

function withDateTime(date: Date, hour: number, minute: number): Date {
  const next = new Date(date);
  next.setHours(hour, minute, 0, 0);
  return next;
}

export function ExpiryDatePicker({ value, onChange, label = '过期日期', className = '' }: ExpiryDatePickerProps) {
  const { language } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = parseDateTimeLocal(value);
  const fallback = selected || new Date();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'days' | 'month-year'>('days');
  const [view, setView] = useState<YearMonth>({ year: fallback.getFullYear(), month: fallback.getMonth() });

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const days = useMemo(() => buildCalendarDays(view.year, view.month), [view.year, view.month]);
  const yearOptions = useMemo(() => Array.from({ length: 11 }, (_, index) => fallback.getFullYear() - 5 + index), [fallback.getFullYear()]);
  const hour = selected?.getHours() ?? fallback.getHours();
  const minute = selected?.getMinutes() ?? fallback.getMinutes();

  function chooseDate(day: CalendarDay) {
    const date = new Date(day.year, day.month, day.day, hour, minute, 0, 0);
    onChange(formatDateTimeLocal(date));
  }

  function chooseTime(nextHour: number, nextMinute: number) {
    onChange(formatDateTimeLocal(withDateTime(selected || fallback, nextHour, nextMinute)));
  }

  function chooseToday() {
    onChange(formatDateTimeLocal(new Date()));
    setOpen(false);
  }

  return (
    <div className={`field date-picker-field ${className}`} ref={rootRef}>
      <span>{label === '过期日期' ? (language === 'en-US' ? 'Expiry date' : label) : label}</span>
      <div className="date-picker">
        <button
          type="button"
          className="ui-date-trigger"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => {
            if (!open) {
              const next = parseDateTimeLocal(value) || new Date();
              setView({ year: next.getFullYear(), month: next.getMonth() });
              setMode('days');
            }
            setOpen(!open);
          }}
        >
          <CalendarDays size={16} />
          <span>{displayValue(value, language)}</span>
        </button>
        {open && <div className="date-picker-popover ui-modal-scroll" role="dialog" aria-label={language === 'en-US' ? 'Choose expiry time' : '选择过期时间'}>
          <div className="date-picker-header">
            <button type="button" className="icon" aria-label={language === 'en-US' ? 'Previous month' : '上个月'} title={language === 'en-US' ? 'Previous month' : '上个月'} onClick={() => setView(shiftMonth(view.year, view.month, -1))}><ChevronLeft size={16} /></button>
            <button type="button" className="date-picker-title" onClick={() => setMode(mode === 'days' ? 'month-year' : 'days')}>{monthLabel(view.year, view.month, language)}</button>
            <button type="button" className="icon" aria-label={language === 'en-US' ? 'Next month' : '下个月'} title={language === 'en-US' ? 'Next month' : '下个月'} onClick={() => setView(shiftMonth(view.year, view.month, 1))}><ChevronRight size={16} /></button>
          </div>
          {mode === 'days' ? <>
            <div className="date-picker-weekdays">{(language === 'en-US' ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] : ['日', '一', '二', '三', '四', '五', '六']).map((day) => <span key={day}>{day}</span>)}</div>
            <div className="date-picker-grid">
              {days.map((day) => {
                const active = selected?.getFullYear() === day.year && selected.getMonth() === day.month && selected.getDate() === day.day;
                return <button key={day.key} type="button" className={`date-picker-day${day.currentMonth ? '' : ' outside'}${active ? ' selected' : ''}`} onClick={() => chooseDate(day)}>{day.day}</button>;
              })}
            </div>
          </> : <div className="date-picker-month-year">
            <div className="date-picker-years">{yearOptions.map((year) => <button key={year} type="button" className={year === view.year ? 'selected' : ''} onClick={() => setView({ year, month: view.month })}>{year}</button>)}</div>
            <div className="date-picker-months">{Array.from({ length: 12 }, (_, month) => <button key={month} type="button" className={month === view.month ? 'selected' : ''} onClick={() => { setView({ year: view.year, month }); setMode('days'); }}>{month + 1}月</button>)}</div>
          </div>}
          <div className="date-picker-time">
            <Clock3 size={15} />
            <select aria-label={language === 'en-US' ? 'Hour' : '小时'} value={hour} onChange={(event) => chooseTime(Number(event.target.value), minute)}>{Array.from({ length: 24 }, (_, value) => <option key={value} value={value}>{language === 'en-US' ? `${pad(value)} h` : `${pad(value)} 时`}</option>)}</select>
            <select aria-label={language === 'en-US' ? 'Minute' : '分钟'} value={minute} onChange={(event) => chooseTime(hour, Number(event.target.value))}>{Array.from({ length: 60 }, (_, value) => <option key={value} value={value}>{language === 'en-US' ? `${pad(value)} min` : `${pad(value)} 分`}</option>)}</select>
          </div>
          <div className="date-picker-footer">
            <button type="button" className="soft" onClick={() => { onChange(''); setOpen(false); }}><X size={14} /> {language === 'en-US' ? 'Clear' : '清除'}</button>
            <button type="button" className="primary" onClick={chooseToday}><Check size={14} /> {language === 'en-US' ? 'Today' : '今天'}</button>
          </div>
        </div>}
      </div>
    </div>
  );
}
