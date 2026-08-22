import { describe, expect, it } from 'vitest';
import { buildCalendarDays, formatDateTimeLocal, parseDateTimeLocal, shiftMonth } from './expiry-date-picker';

describe('expiry date picker values', () => {
  it('round-trips a local datetime without converting it to UTC', () => {
    const value = parseDateTimeLocal('2026-08-21T09:07');
    expect(value).not.toBeNull();
    expect(formatDateTimeLocal(value!)).toBe('2026-08-21T09:07');
  });

  it('creates a complete calendar grid for the selected month', () => {
    const days = buildCalendarDays(2026, 7);
    expect(days).toHaveLength(42);
    expect(days.some((day) => day.currentMonth && day.day === 1)).toBe(true);
    expect(days.some((day) => day.currentMonth && day.day === 31)).toBe(true);
  });

  it('moves across year boundaries', () => {
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
  });
});
