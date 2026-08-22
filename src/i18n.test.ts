import { describe, expect, it } from 'vitest';
import { getInitialLanguage, normalizeLanguage, translate } from './i18n';

describe('i18n', () => {
  it('normalizes supported and unsupported language values', () => {
    expect(normalizeLanguage('en-US')).toBe('en-US');
    expect(normalizeLanguage('en')).toBe('en-US');
    expect(normalizeLanguage('zh-CN')).toBe('zh-CN');
    expect(normalizeLanguage('fr-FR')).toBe('zh-CN');
  });

  it('prefers stored language and falls back to browser language', () => {
    const storage = { getItem: (key: string) => key === 'content-share-language' ? 'en-US' : null } as Storage;
    expect(getInitialLanguage(storage, 'zh-CN')).toBe('en-US');
    expect(getInitialLanguage(null, 'en-GB')).toBe('en-US');
    expect(getInitialLanguage(null, 'zh-TW')).toBe('zh-CN');
  });

  it('translates and interpolates messages', () => {
    expect(translate('en-US', 'nav.publishText')).toBe('Publish text');
    expect(translate('zh-CN', 'nav.publishText')).toBe('发布文本');
    expect(translate('en-US', 'upload.remaining', { count: 3 })).toBe('3 files remaining');
    expect(translate('en-US', 'missing.key')).toBe('missing.key');
  });

  it('formats structured quota accounting in both languages', () => {
    const values = { used: '70 B', reserved: '20 B', requested: '11 B', quota: '100 B' };

    expect(translate('en-US', 'error.STORAGE_QUOTA_EXCEEDED')).toBe('Storage quota exceeded');
    expect(translate('en-US', 'error.storageQuotaDetails', values)).toBe(
      'Used 70 B, reserved 20 B, requested 11 B, quota 100 B'
    );
    expect(translate('zh-CN', 'error.storageQuotaDetails', values)).toBe(
      '已用 70 B，预留 20 B，本次请求 11 B，配额 100 B'
    );
  });
});
