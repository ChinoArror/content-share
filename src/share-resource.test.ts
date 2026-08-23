import { describe, expect, it } from 'vitest';
import { classifyShareResourceError, shareResourceMode } from './share-resource';

describe('share resource mode', () => {
  it('keeps public or ticketed resources on the direct URL path', () => {
    expect(shareResourceMode('', '')).toBe('direct');
    expect(shareResourceMode('secret', 'media-ticket')).toBe('direct');
  });

  it('uses a protected blob for a password resource without a media ticket', () => {
    expect(shareResourceMode('secret', '')).toBe('protected-blob');
    expect(shareResourceMode('secret')).toBe('protected-blob');
  });
});

describe('share resource errors', () => {
  it('classifies authentication failures as requiring the password page again', () => {
    expect(classifyShareResourceError(401)).toBe('password');
    expect(classifyShareResourceError(403)).toBe('password');
    expect(classifyShareResourceError(409, 'PASSWORD_ATTACHMENT_RELOAD_REQUIRED')).toBe('password');
    expect(classifyShareResourceError(409, 'PASSWORD_REQUIRED_OR_INCORRECT')).toBe('password');
  });

  it('keeps unrelated resource failures separate from password failures', () => {
    expect(classifyShareResourceError(404)).toBe('unavailable');
    expect(classifyShareResourceError(500, 'R2_READ_FAILED')).toBe('unavailable');
  });
});
