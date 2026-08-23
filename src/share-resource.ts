export type ShareResourceMode = 'direct' | 'protected-blob';
export type ShareResourceFailure = 'password' | 'unavailable';

export function shareResourceMode(password: string, mediaTicket?: string | null): ShareResourceMode {
  return password.length > 0 && !mediaTicket ? 'protected-blob' : 'direct';
}

export function classifyShareResourceError(status: number, code = ''): ShareResourceFailure {
  if (status === 401 || status === 403 || code === 'PASSWORD_ATTACHMENT_RELOAD_REQUIRED' || code === 'PASSWORD_REQUIRED_OR_INCORRECT') {
    return 'password';
  }
  return 'unavailable';
}
