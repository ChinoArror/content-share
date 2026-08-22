import { describe, expect, it } from 'vitest';
import { compactAuditValue, middleEllipsis } from './admin-display';

describe('admin display helpers', () => {
  it('keeps the beginning and end of long values', () => {
    expect(compactAuditValue('Mozilla/5.0 very long browser signature', 22)).toMatch(/^Mozilla\/5\.0.*….*signature$/);
  });

  it('does not alter short values', () => {
    expect(middleEllipsis('short', 22)).toBe('short');
  });

  it('handles empty audit values consistently', () => {
    expect(compactAuditValue(null)).toBe('-');
    expect(compactAuditValue('')).toBe('-');
  });
});
