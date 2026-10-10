import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import type { UiSettings } from '../ui-settings';
import { useTheme } from './theme';
import './adobe-pdf-viewer.css';

const SDK_SRC = 'https://acrobatservices.adobe.com/view-sdk/viewer.js';
const READY_EVENT = 'adobe_dc_view_sdk.ready';
const SDK_TIMEOUT_MS = 15000;
const CONFIG_URL = '/api/public/pdf-embed-config';

let sdkPromise: Promise<any> | null = null;
let clientIdPromise: Promise<string | null> | null = null;
let runCounter = 0;

export function loadAdobeSdk(): Promise<any> {
  const ready = typeof window === 'undefined' ? undefined : (window as any).AdobeDC;
  if (ready) return Promise.resolve(ready);
  if (!sdkPromise) {
    sdkPromise = new Promise<any>((resolve, reject) => {
      const script = document.createElement('script');
      let settled = false;
      let timer = 0;
      const finish = () => {
        document.removeEventListener(READY_EVENT, onReady);
        window.clearTimeout(timer);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        finish();
        script.remove();
        sdkPromise = null;
        reject(error);
      };
      const onReady = () => {
        if (settled) return;
        settled = true;
        finish();
        const adobe = (window as any).AdobeDC;
        if (adobe) resolve(adobe);
        else {
          sdkPromise = null;
          reject(new Error('Adobe PDF SDK did not expose AdobeDC'));
        }
      };
      document.addEventListener(READY_EVENT, onReady);
      timer = window.setTimeout(() => fail(new Error('Adobe PDF SDK load timed out')), SDK_TIMEOUT_MS);
      script.src = SDK_SRC;
      script.async = true;
      script.onerror = () => fail(new Error('Adobe PDF SDK failed to load'));
      document.head.appendChild(script);
    });
  }
  return sdkPromise;
}

export function getPdfEmbedClientId(): Promise<string | null> {
  if (!clientIdPromise) {
    clientIdPromise = fetch(CONFIG_URL, { credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) return null;
        const data = (await response.json()) as { client_id?: unknown };
        return typeof data.client_id === 'string' && data.client_id.trim() ? data.client_id.trim() : null;
      })
      .catch(() => null);
  }
  return clientIdPromise;
}

type AdobePdfViewerProps = {
  fileName: string;
  loadBuffer: () => Promise<ArrayBuffer>;
  allowDownload: boolean;
  fallback: ReactNode;
  onError?: (error: unknown) => void;
  onFallback?(): void;
};

type Phase = 'loading' | 'ready' | 'fallback';

// Adobe sizes the viewer from its container when previewFile runs, so wait for a painted frame first.
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, 100);
    window.requestAnimationFrame(() => {
      window.clearTimeout(timer);
      resolve();
    });
  });
}

export function AdobePdfViewer({ fileName, loadBuffer, allowDownload, fallback, onError, onFallback }: AdobePdfViewerProps) {
  const { t, language } = useI18n();
  const reactId = useId();
  const frameId = `adobe-pdf-${reactId.toLowerCase().replace(/[^a-z0-9-]/g, '')}`;
  const hostRef = useRef<HTMLDivElement>(null);
  const loadRef = useRef(loadBuffer);
  const errorRef = useRef(onError);
  const fallbackRef = useRef(onFallback);
  loadRef.current = loadBuffer;
  errorRef.current = onError;
  fallbackRef.current = onFallback;
  const [phase, setPhase] = useState<Phase>('loading');

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let cancelled = false;
    host.innerHTML = '';
    setPhase('loading');
    // Each run gets its own target node so a StrictMode re-run never shares a viewer with a stale one.
    const target = document.createElement('div');
    target.id = `${frameId}-${++runCounter}`;
    target.className = 'adobe-pdf-target';
    host.appendChild(target);

    (async () => {
      const clientId = await getPdfEmbedClientId();
      if (cancelled) return;
      if (!clientId) {
        setPhase('fallback');
        fallbackRef.current?.();
        return;
      }
      const AdobeDC = await loadAdobeSdk();
      if (cancelled) return;
      const buffer = await loadRef.current();
      if (cancelled) return;
      await nextFrame();
      if (cancelled) return;
      const view = new AdobeDC.View({ clientId, divId: target.id, locale: language === 'en-US' ? 'en-US' : 'zh-CN' });
      await view.previewFile(
        { content: { promise: Promise.resolve(buffer) }, metaData: { fileName } },
        {
          embedMode: 'SIZED_CONTAINER',
          showDownloadPDF: allowDownload,
          showPrintPDF: allowDownload,
          showAnnotationTools: false,
          showFullScreen: true,
          focusOnRendering: false
        }
      );
      if (!cancelled) setPhase('ready');
    })().catch((error) => {
      if (cancelled) return;
      errorRef.current?.(error);
      setPhase('fallback');
      fallbackRef.current?.();
    });

    return () => {
      cancelled = true;
      host.innerHTML = '';
    };
  }, [frameId, fileName, allowDownload, language]);

  if (phase === 'fallback') return <>{fallback}</>;
  return (
    <div className="adobe-pdf-wrap">
      <div id={frameId} ref={hostRef} className="adobe-pdf-frame" />
      {phase === 'loading' && (
        <div className="adobe-pdf-loading query-loading" role="status">
          <span>{t('preview.pdfLoading')}</span>
        </div>
      )}
    </div>
  );
}

type PdfPreviewProps = {
  fileName: string;
  loadBuffer: () => Promise<ArrayBuffer>;
  allowDownload: boolean;
  renderPdfJs: () => ReactNode;
  variant: 'page' | 'embedded';
};

// Viewer chooser: Adobe by default (per-account setting), classic pdf.js when chosen or when Adobe cannot load.
export function PdfPreview({ fileName, loadBuffer, allowDownload, renderPdfJs, variant }: PdfPreviewProps) {
  const { t } = useI18n();
  const { settings, update } = useTheme();
  const [adobeFailed, setAdobeFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const adobe = settings.pdfViewer === 'adobe';
  // What is actually on screen: the saved choice, unless Adobe fell back automatically this time.
  const showAdobe = adobe && !adobeFailed;

  const choose = (next: UiSettings['pdfViewer']) => {
    if (next === 'adobe' && adobeFailed) {
      // Re-selecting Adobe after an automatic fallback retries it with a fresh viewer.
      setAdobeFailed(false);
      setAttempt((n) => n + 1);
    }
    if (next !== settings.pdfViewer) update({ pdfViewer: next });
  };

  const classic = !showAdobe;
  return (
    <div className={`pdf-preview pdf-preview-${variant}`}>
      <div className="pdf-viewer-bar">
        <span className="pdf-viewer-label">{t('pdf.viewer')}</span>
        <div className="pdf-viewer-controls">
          {adobe && adobeFailed && <span className="pdf-fallback-note" role="status">{t('pdf.fallbackNote')}</span>}
          <div className="pdf-switch" role="group" aria-label={t('pdf.viewer')}>
            <button type="button" className={showAdobe ? 'on' : ''} aria-pressed={showAdobe} onClick={() => choose('adobe')}>
              {t('pdf.adobe')}
            </button>
            <button type="button" className={showAdobe ? '' : 'on'} aria-pressed={!showAdobe} onClick={() => choose('pdfjs')}>
              {t('pdf.classic')}
            </button>
          </div>
        </div>
      </div>
      <div className={`pdf-preview-body${classic ? ' is-classic' : ''}`}>
        {adobe ? (
          <AdobePdfViewer
            key={attempt}
            fileName={fileName}
            loadBuffer={loadBuffer}
            allowDownload={allowDownload}
            fallback={renderPdfJs()}
            onFallback={() => setAdobeFailed(true)}
          />
        ) : (
          renderPdfJs()
        )}
      </div>
    </div>
  );
}
