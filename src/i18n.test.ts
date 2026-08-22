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
});
