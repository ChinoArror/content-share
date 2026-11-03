import { describe, expect, it } from 'vitest';
import { localOfficeFormat } from './office-preview';

describe('local Office preview formats', () => {
  it.each([
    ['report.DOCX', 'docx'],
    ['budget.xlsx', 'xlsx'],
    ['deck.pptx', 'pptx'],
  ] as const)('accepts %s', (filename, format) => {
    expect(localOfficeFormat(filename)).toBe(format);
  });

  it.each(['legacy.doc', 'legacy.xls', 'legacy.ppt', 'archive.zip', 'file.docx.exe'])(
    'does not advertise unsupported file %s', (filename) => {
      expect(localOfficeFormat(filename)).toBeNull();
    },
  );
});
