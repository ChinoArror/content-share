import { describe, expect, it } from 'vitest';
import {
  adminKeyActions,
  compactAuditValue,
  middleEllipsis,
  normalizeVisibility,
  quotaGiBToBytes,
  auditNullLabel,
  mergeKeyFingerprint,
  visibilitySegmentMetrics,
  withAllowedVisibility,
} from './admin-display';

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

  it('normalizes public visibility when public publishing is unavailable', () => {
    expect(normalizeVisibility('public', false)).toBe('private');
    expect(normalizeVisibility('internal', false)).toBe('internal');
    expect(normalizeVisibility('public', true)).toBe('public');
  });

  it('builds a submit payload that cannot publish public content without permission', () => {
    const payload = withAllowedVisibility({ title: 'draft', visibility: 'public', content: 'body' }, false);
    expect(payload).toEqual({ title: 'draft', visibility: 'private', content: 'body' });
    expect(withAllowedVisibility({ visibility: 'public' }, true).visibility).toBe('public');
  });

  it('converts GiB quota values to finite integer bytes', () => {
    expect(quotaGiBToBytes('0.1')).toBe(107374182);
    expect(Number.isInteger(quotaGiBToBytes('0.1'))).toBe(true);
    expect(quotaGiBToBytes('')).toBe(null);
    expect(quotaGiBToBytes('-1')).toBe(null);
    expect(quotaGiBToBytes('nope')).toBe(null);
  });

  it('keeps API key action buttons available for both lock states', () => {
    expect(adminKeyActions(false)).toEqual(expect.arrayContaining(['rotate', 'lock', 'revoke']));
    expect(adminKeyActions(true)).toEqual(expect.arrayContaining(['rotate', 'unlock', 'revoke']));
    expect(adminKeyActions(false)).not.toContain('unlock');
    expect(adminKeyActions(true)).not.toContain('lock');
  });

  it('sizes visibility segments to the permissions that are actually available', () => {
    expect(visibilitySegmentMetrics(3, 1)).toEqual({ count: 3, index: 1 });
    expect(visibilitySegmentMetrics(2, 1)).toEqual({ count: 2, index: 1 });
    expect(visibilitySegmentMetrics(0, 9)).toEqual({ count: 1, index: 0 });
  });

  it('does not label unused or unlocked audit timestamps as permanent', () => {
    expect(auditNullLabel('last_used_at', 'zh-CN')).toBe('从未使用');
    expect(auditNullLabel('locked_at', 'zh-CN')).toBe('未锁定');
    expect(auditNullLabel('last_used_at', 'en-US')).toBe('Never used');
    expect(auditNullLabel('locked_at', 'en-US')).toBe('Not locked');
  });

  it('merges API key prefix and suffix into one display fingerprint', () => {
    expect(mergeKeyFingerprint('sw_live_', '7f42')).toBe('sw_live_...7f42');
    expect(mergeKeyFingerprint('', '')).toBe('-');
  });
});
