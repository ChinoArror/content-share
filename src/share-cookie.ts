export const SHARE_PASSWORD_TTL_SECONDS = 30 * 60;

export function sharePasswordCookieName(slug: string): string {
  const safeSlug = slug.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  return `share_access_${safeSlug || 'unknown'}`;
}

export function shareMediaCookieName(slug: string): string {
  const safeSlug = slug.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  return `share_media_${safeSlug || 'unknown'}`;
}

export function parseCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function serializeSharePasswordCookie(name: string, value: string, maxAge = SHARE_PASSWORD_TTL_SECONDS): string {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${Math.max(0, Math.floor(maxAge))}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function serializeShareMediaCookie(name: string, value: string, maxAge = 600): string {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${Math.max(0, Math.floor(maxAge))}; Path=/api/attachments; HttpOnly; Secure; SameSite=Lax`;
}
