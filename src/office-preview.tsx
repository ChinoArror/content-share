import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useI18n } from './i18n';
import { classifyShareResourceError, ShareResourceRequestError, type ShareResourceFailure } from './share-resource';
import docxWasmUrl from '../node_modules/@silurus/ooxml/dist/docx_parser_bg.wasm?url';
import pptxWasmUrl from '../node_modules/@silurus/ooxml/dist/pptx_parser_bg.wasm?url';
import xlsxWasmUrl from '../node_modules/@silurus/ooxml/dist/xlsx_parser_bg.wasm?url';

export function localOfficeFormat(filename: string): 'docx' | 'pptx' | 'xlsx' | null {
  const extension = filename.split('.').pop()?.toLowerCase();
  return extension === 'docx' || extension === 'pptx' || extension === 'xlsx' ? extension : null;
}

type Viewer = { load(source: ArrayBuffer): Promise<void>; destroy(): void };

// Fallback when no loadBuffer is supplied. The app's pages pass loadBuffer so Office bytes take the same path as the PDF viewer.
async function fetchOfficeBytes(url: string, password: string): Promise<ArrayBuffer> {
  const headers = new Headers();
  if (password) headers.set('x-share-password', password);
  const response = await fetch(url, { credentials: 'include', headers });
  if (!response.ok) throw new ShareResourceRequestError(classifyShareResourceError(response.status));
  return response.arrayBuffer();
}

export function OfficePreview({ filename, previewUrl, password = '', loadBuffer, onPasswordRequired }: {
  filename: string;
  previewUrl: string;
  password?: string;
  loadBuffer?: () => Promise<ArrayBuffer>;
  onPasswordRequired?: () => void;
}) {
  const { t } = useI18n();
  const format = localOfficeFormat(filename);
  const host = useRef<HTMLDivElement>(null);
  // Refs keep inline loaders and callbacks from restarting the viewer on every parent render.
  const loadRef = useRef(loadBuffer);
  loadRef.current = loadBuffer;
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [failure, setFailure] = useState<ShareResourceFailure>('unavailable');

  // The viewers (XLSX zoom bar) render their own <input type=range>. Our global range style paints
  // the filled track from --fill, so keep --fill in step with each slider's value, including
  // changes made by the viewer's own -/+ buttons, wheel zoom or keyboard.
  useEffect(() => {
    const container = host.current;
    if (!container) return undefined;
    let frame = 0;
    const sync = () => {
      frame = 0;
      container.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach((input) => {
        const min = Number(input.min || 0);
        const max = Number(input.max || 100);
        const value = Number(input.value);
        const pct = max > min ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0;
        input.style.setProperty('--fill', `${pct}%`);
      });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(sync); };
    const events = ['input', 'change', 'click', 'wheel', 'keyup', 'pointerup'] as const;
    events.forEach((name) => container.addEventListener(name, schedule, { passive: true, capture: true }));
    const observer = new MutationObserver(schedule);
    observer.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ['value', 'min', 'max'] });
    const timer = window.setInterval(schedule, 400);
    schedule();
    return () => {
      events.forEach((name) => container.removeEventListener(name, schedule, { capture: true }));
      observer.disconnect();
      window.clearInterval(timer);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [status]);

  useEffect(() => {
    const container = host.current;
    if (!format || !container) return undefined;
    let cancelled = false;
    let viewer: Viewer | null = null;
    container.replaceChildren();
    setStatus('loading');

    void (async () => {
      try {
        const bytes = await (loadRef.current ? loadRef.current() : fetchOfficeBytes(previewUrl, password));
        if (cancelled) return;
        if (format === 'docx') {
          const { DocxScrollViewer } = await import('@silurus/ooxml/docx');
          if (cancelled) return;
          viewer = new DocxScrollViewer(container, { refitOnResize: true, wasmUrl: docxWasmUrl });
        } else if (format === 'pptx') {
          const { PptxScrollViewer } = await import('@silurus/ooxml/pptx');
          if (cancelled) return;
          viewer = new PptxScrollViewer(container, { refitOnResize: true, wasmUrl: pptxWasmUrl });
        } else {
          const { XlsxViewer } = await import('@silurus/ooxml/xlsx');
          if (cancelled) return;
          viewer = new XlsxViewer(container, { wasmUrl: xlsxWasmUrl });
        }
        await viewer.load(bytes);
        if (!cancelled) setStatus('ready');
      } catch (error) {
        if (cancelled) return;
        setFailure(error instanceof ShareResourceRequestError ? error.failure : 'unavailable');
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      viewer?.destroy();
      container.replaceChildren();
    };
  }, [format, previewUrl, password, attempt]);

  if (!format) return null;
  return (
    <div className="office-preview">
      {status === 'loading' && <div className="office-preview-status" role="status">{t('preview.loading')}</div>}
      {status === 'error' && (
        <div className="office-preview-status" role="alert">
          <p>{t('preview.officeLoadFailed')}</p>
          {failure === 'password' && onPasswordRequired ? (
            <button type="button" className="soft" onClick={onPasswordRequired}>{t('preview.resourceReenterPassword')}</button>
          ) : (
            <button type="button" className="soft" onClick={() => setAttempt((value) => value + 1)}><RefreshCw size={16} /> {t('preview.retry')}</button>
          )}
        </div>
      )}
      <div ref={host} className="office-preview-host" role="region" aria-label={filename} />
    </div>
  );
}
