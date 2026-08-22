import { describe, expect, it } from 'vitest';
import { issueMediaTicket, verifyMediaTicket } from './media-ticket';

describe('media access tickets', () => {
  it('issues a short-lived attachment-scoped ticket', async () => {
    const ticket = await issueMediaTicket('secret', {
      attachmentId: 'att_1',
      actor: 'alice',
      adminPreview: false,
      policyVersion: 'v1',
      nowSeconds: 1_000,
      expiresInSeconds: 300
    });

    await expect(verifyMediaTicket('secret', ticket, 'att_1', 1_100)).resolves.toMatchObject({
      attachmentId: 'att_1',
      actor: 'alice',
      adminPreview: false,
      policyVersion: 'v1'
    });
    await expect(verifyMediaTicket('secret', ticket, 'att_2', 1_100)).resolves.toBeNull();
  });

  it('rejects expired and tampered tickets', async () => {
    const ticket = await issueMediaTicket('secret', {
      attachmentId: 'att_1',
      nowSeconds: 1_000,
      expiresInSeconds: 60
    });

    await expect(verifyMediaTicket('secret', ticket, 'att_1', 1_061)).resolves.toBeNull();
    await expect(verifyMediaTicket('secret', `${ticket.slice(0, -1)}x`, 'att_1', 1_010)).resolves.toBeNull();
  });
});
