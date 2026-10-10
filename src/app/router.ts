// Minimal History-API router for the logged-in console (/app/<page>[/<sub>]).
// Public pages (/s/, /preview/, /docs, /face-transfer, /sso-callback) are matched in main.tsx and never use this.
import { useEffect, useState } from 'react';

export type AppPage = 'text' | 'file' | 'face' | 'mine' | 'keys' | 'settings' | 'admin';
export type AppRoute = { page: AppPage; sub?: string };

const PAGES: readonly AppPage[] = ['text', 'file', 'face', 'mine', 'keys', 'settings', 'admin'];
const NAV_EVENT = 'cs:navigate';
const DEFAULT_ROUTE: AppRoute = { page: 'text' };

export function isAppPath(pathname: string): boolean {
  return pathname === '/app' || pathname.startsWith('/app/');
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** `/app/<page>[/<sub>]`. Returns null for paths outside the console; `/app` and unknown pages map to Publish text. */
export function parseAppRoute(pathname: string): AppRoute | null {
  if (!isAppPath(pathname)) return null;
  const parts = pathname.split('/').filter(Boolean);
  const page = parts[1] as AppPage | undefined;
  if (!page || !(PAGES as readonly string[]).includes(page)) return { ...DEFAULT_ROUTE };
  const sub = parts[2] ? safeDecode(parts[2]) : undefined;
  return sub ? { page, sub } : { page };
}

export function appPath(route: AppRoute): string {
  return `/app/${route.page}${route.sub ? `/${encodeURIComponent(route.sub)}` : ''}`;
}

function currentRoute(): AppRoute {
  return parseAppRoute(location.pathname) ?? { ...DEFAULT_ROUTE };
}

export function navigate(route: AppRoute, options: { replace?: boolean } = {}): void {
  const target = appPath(route);
  if (location.pathname === target && !options.replace) return;
  if (options.replace) history.replaceState(null, '', target);
  else history.pushState(null, '', target);
  window.dispatchEvent(new Event(NAV_EVENT));
}

/** Current console route; re-renders on back/forward and on navigate(). */
export function useAppRoute(): AppRoute {
  const [route, setRoute] = useState<AppRoute>(currentRoute);
  useEffect(() => {
    const sync = () => {
      const next = currentRoute();
      setRoute((prev) => (prev.page === next.page && prev.sub === next.sub ? prev : next));
    };
    window.addEventListener('popstate', sync);
    window.addEventListener(NAV_EVENT, sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener(NAV_EVENT, sync);
    };
  }, []);
  return route;
}
