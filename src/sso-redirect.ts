type LocationParts = Pick<Location, 'pathname' | 'search' | 'hash'>;

export function currentReturnTo(locationParts: LocationParts): string {
  const pathname = locationParts.pathname.startsWith('/') ? locationParts.pathname : '/';
  return `${pathname}${locationParts.search || ''}${locationParts.hash || ''}`;
}

export function buildSsoLoginUrl(ssoUrl: string, appId: string, origin: string, locationParts: LocationParts): string {
  const callback = `${origin.replace(/\/+$/, '')}/sso-callback?return_to=${encodeURIComponent(currentReturnTo(locationParts))}`;
  return `${ssoUrl.replace(/\/+$/, '')}/login?app_id=${encodeURIComponent(appId)}&redirect=${encodeURIComponent(callback)}`;
}

export function safeReturnTo(value: string | null | undefined, origin: string): string {
  if (!value) return '/';
  try {
    const base = new URL(origin).origin;
    const target = new URL(value, base);
    if (target.origin !== base || !target.pathname.startsWith('/') || target.searchParams.has('token')) return '/';
    return `${target.pathname}${target.search}${target.hash}` || '/';
  } catch {
    return '/';
  }
}
