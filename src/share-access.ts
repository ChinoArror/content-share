export type ShareAccessPresentation = 'login' | 'permission' | 'password' | 'generic';

export function classifyShareAccessError(code?: string, message = ''): ShareAccessPresentation {
  if (code === 'LOGIN_REQUIRED') return 'login';
  if (code === 'INTERNAL_ACCESS_PERMISSION_REQUIRED') return 'permission';
  if (code === 'PASSWORD_REQUIRED_OR_INCORRECT' || /password|密码/i.test(message)) return 'password';
  return 'generic';
}
