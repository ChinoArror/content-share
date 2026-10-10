import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Crop, ImageOff, ImagePlus, Minus, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { rangeFill } from './select';
import './background-editor.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BackgroundCrop = {
  scale: number;
  offsetX: number;
  offsetY: number;
  previewWidth: number;
  previewHeight: number;
};

export type BackgroundSource = { url?: string; data?: string };

export type BackgroundCropResult = {
  cropped_data: string;
  crop: BackgroundCrop;
  original_data?: string;
};

export type BackgroundItem = {
  url: string;
  original_url: string | null;
  opacity: number;
  crop: BackgroundCrop | null;
  updated_at: string;
};

export type BackgroundRestore = { deadline: string };

export type BackgroundEditorLabels = {
  title: string;
  zoom: string;
  zoomOut: string;
  zoomIn: string;
  dragHint: string;
  cancel: string;
  save: string;
  saving: string;
  customBackground: string;
  noBackground: string;
  restoreUntil: string;
  upload: string;
  adjust: string;
  delete: string;
  restore: string;
  close: string;
  /** Optional: shown when the source image fails to load. */
  loadError?: string;
};

export const DEFAULT_BG_LABELS: BackgroundEditorLabels = {
  title: '背景图裁剪',
  zoom: '缩放',
  zoomOut: '缩小',
  zoomIn: '放大',
  dragHint: '拖动图片调整位置',
  cancel: '取消',
  save: '保存裁剪',
  saving: '保存中...',
  customBackground: '自定义背景',
  noBackground: '未设置背景',
  restoreUntil: '可恢复至',
  upload: '上传',
  adjust: '调整',
  delete: '删除',
  restore: '恢复',
  close: '关闭',
  loadError: '图片加载失败',
};

export type BackgroundEditorState = {
  sourceUrl?: string;
  sourceData?: string;
  /** Already-decoded image; avoids decoding again on save. */
  image?: HTMLImageElement;
  naturalWidth: number;
  naturalHeight: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  aspectRatio: number;
};

export const BG_ASPECT_RATIO = 16 / 9;
export const BG_OUT_WIDTH = 1600;
export const BG_OUT_HEIGHT = 900;
const MIN_SCALE = 1;
const MAX_SCALE = 3;
const KEY_NUDGE = 8;
const WHEEL_STEP = 0.05;
const BUTTON_STEP = 0.1;

// ---------------------------------------------------------------------------
// Pure crop math (see authcenter-avatar-crop SKILL.md, "Crop Math")
// ---------------------------------------------------------------------------

export function getPreviewLayout(
  editor: Pick<BackgroundEditorState, 'naturalWidth' | 'naturalHeight' | 'scale'>,
  previewWidth: number,
  previewHeight: number,
) {
  const coverScale = Math.max(previewWidth / editor.naturalWidth, previewHeight / editor.naturalHeight) * editor.scale;
  const width = editor.naturalWidth * coverScale;
  const height = editor.naturalHeight * coverScale;
  const maxOffsetX = Math.max(0, (width - previewWidth) / 2);
  const maxOffsetY = Math.max(0, (height - previewHeight) / 2);
  return { width, height, maxOffsetX, maxOffsetY };
}

export function clampEditor<T extends BackgroundEditorState>(editor: T, previewWidth: number, previewHeight: number): T {
  const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, editor.scale));
  const next = { ...editor, scale };
  const { maxOffsetX, maxOffsetY } = getPreviewLayout(next, previewWidth, previewHeight);
  return {
    ...next,
    offsetX: Math.min(maxOffsetX, Math.max(-maxOffsetX, next.offsetX)),
    offsetY: Math.min(maxOffsetY, Math.max(-maxOffsetY, next.offsetY)),
  };
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image could not be loaded'));
    img.src = src;
  });
}

/**
 * Renders the visible crop to a 1600x900 canvas. Uses WebP (q .9) when the
 * browser can encode it, otherwise PNG. Only called on save, never while dragging.
 */
export async function cropToDataUrl(
  editor: BackgroundEditorState,
  outW = BG_OUT_WIDTH,
  outH = BG_OUT_HEIGHT,
  previewWidth: number,
  previewHeight: number,
): Promise<string> {
  if (!(previewWidth > 0 && previewHeight > 0)) throw new Error('Preview is not ready');
  const image = editor.image ?? (await loadImage(editor.sourceData || editor.sourceUrl || ''));
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Unable to crop image');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const baseScale = Math.max(outW / image.naturalWidth, outH / image.naturalHeight) * editor.scale;
  const width = image.naturalWidth * baseScale;
  const height = image.naturalHeight * baseScale;
  const x = (outW - width) / 2 + editor.offsetX * (outW / previewWidth);
  const y = (outH - height) / 2 + editor.offsetY * (outH / previewHeight);
  ctx.drawImage(image, x, y, width, height);
  const webp = canvas.toDataURL('image/webp', 0.9);
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png');
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('File could not be read'));
    reader.readAsDataURL(file);
  });
}

function roundScale(value: number) {
  return Math.round(value * 100) / 100;
}

function formatDeadline(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

// ---------------------------------------------------------------------------
// Crop modal
// ---------------------------------------------------------------------------

type ModalProps = {
  open: boolean;
  source: BackgroundSource | null;
  initialCrop?: BackgroundCrop | null;
  saving: boolean;
  labels: BackgroundEditorLabels;
  onCancel: () => void;
  onSave: (result: BackgroundCropResult) => void;
};

export function BackgroundCropModal(props: ModalProps) {
  if (!props.open || !props.source || typeof document === 'undefined') return null;
  const src = props.source.data || props.source.url;
  if (!src) return null;
  // Keyed by source so every open starts from fresh editor state.
  return <CropEditor key={src} {...props} source={props.source} src={src} />;
}

function CropEditor({ src, source, initialCrop, saving, labels, onCancel, onSave }: Omit<ModalProps, 'source'> & { src: string; source: BackgroundSource }) {
  const [editor, setEditor] = useState<BackgroundEditorState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [frame, setFrame] = useState({ w: 0, h: 0 });
  const [dragging, setDragging] = useState(false);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const dragRef = useRef<{ id: number; x: number; y: number; ox: number; oy: number } | null>(null);
  // Width the current offsets are expressed against (for proportional re-mapping on resize/recrop).
  const offsetBaseWidthRef = useRef(0);
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const savingRef = useRef(saving);
  savingRef.current = saving;

  // Lock page scroll while open.
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const prevHtml = html.style.overflow;
    const prevBody = body.style.overflow;
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    return () => {
      html.style.overflow = prevHtml;
      body.style.overflow = prevBody;
    };
  }, []);

  // Escape cancels.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !savingRef.current) onCancelRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Load the image once per source. The parent keys this component by src, and initialCrop/source
  // are read on purpose only at load time, so parent re-renders never reset the editor.
  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      const base = initialCrop ? initialCrop.previewWidth : 0;
      offsetBaseWidthRef.current = base;
      setEditor({
        sourceUrl: source.url,
        sourceData: source.data,
        image: img,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        scale: initialCrop ? initialCrop.scale : 1,
        offsetX: initialCrop ? initialCrop.offsetX : 0,
        offsetY: initialCrop ? initialCrop.offsetY : 0,
        aspectRatio: BG_ASPECT_RATIO,
      });
    };
    img.onerror = () => {
      if (!cancelled) setLoadFailed(true);
    };
    img.src = src;
    return () => {
      cancelled = true;
      img.onload = null;
      img.onerror = null;
    };
  }, [src]);

  // Measure the preview frame (the frame element is always rendered).
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const apply = (w: number, h: number) => {
      sizeRef.current = { w, h };
      setFrame((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    };
    const rect = el.getBoundingClientRect();
    apply(rect.width, rect.height);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) apply(box.width, box.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Re-map offsets proportionally when the frame size becomes known or changes, then re-clamp.
  useEffect(() => {
    if (!editor || frame.w <= 0 || frame.h <= 0) return;
    const base = offsetBaseWidthRef.current;
    const ratio = base > 0 ? frame.w / base : 1;
    offsetBaseWidthRef.current = frame.w;
    if (ratio === 1 && base > 0) return;
    setEditor((prev) => prev && clampEditor({ ...prev, offsetX: prev.offsetX * ratio, offsetY: prev.offsetY * ratio }, frame.w, frame.h));
  }, [editor, frame.w, frame.h]);

  // Wheel zooms; must be non-passive to preventDefault.
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const delta = event.deltaY < 0 ? WHEEL_STEP : event.deltaY > 0 ? -WHEEL_STEP : 0;
      if (!delta) return;
      const { w, h } = sizeRef.current;
      setEditor((prev) => prev && clampEditor({ ...prev, scale: roundScale(prev.scale + delta) }, w, h));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  function setScale(next: number) {
    const { w, h } = sizeRef.current;
    setEditor((prev) => prev && clampEditor({ ...prev, scale: roundScale(next) }, w, h));
  }

  function nudge(dx: number, dy: number) {
    const { w, h } = sizeRef.current;
    setEditor((prev) => prev && clampEditor({ ...prev, offsetX: prev.offsetX + dx, offsetY: prev.offsetY + dy }, w, h));
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!editor || event.button > 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, ox: editor.offsetX, oy: editor.offsetY };
    setDragging(true);
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    const { w, h } = sizeRef.current;
    setEditor((prev) => prev && clampEditor({ ...prev, offsetX: drag.ox + dx, offsetY: drag.oy + dy }, w, h));
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.id !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!editor) return;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-KEY_NUDGE, 0],
      ArrowRight: [KEY_NUDGE, 0],
      ArrowUp: [0, -KEY_NUDGE],
      ArrowDown: [0, KEY_NUDGE],
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    nudge(move[0], move[1]);
  }

  async function save() {
    if (!editor || saving) return;
    const { w, h } = sizeRef.current;
    if (!(w > 0 && h > 0)) return;
    setSaveError('');
    try {
      const cropped = await cropToDataUrl(editor, BG_OUT_WIDTH, BG_OUT_HEIGHT, w, h);
      const crop: BackgroundCrop = {
        scale: editor.scale,
        offsetX: editor.offsetX,
        offsetY: editor.offsetY,
        previewWidth: w,
        previewHeight: h,
      };
      onSave({ cropped_data: cropped, crop, ...(source.data ? { original_data: source.data } : {}) });
    } catch (error) {
      setSaveError((error as Error).message || 'Crop failed');
    }
  }

  const layout = editor && frame.w > 0 ? getPreviewLayout(editor, frame.w, frame.h) : null;
  const busy = saving;
  const ready = editor !== null;

  return createPortal(
    <div
      className="modal modal-root bg-crop-root"
      data-theme={document.documentElement.classList.contains('dark') ? 'dark' : 'light'}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <section
        className="dialog modal-shell bg-crop-modal"
        onMouseDown={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
        onTouchMove={(event) => event.stopPropagation()}
      >
        <button type="button" className="icon modal-close" onClick={onCancel} disabled={busy} aria-label={labels.close} title={labels.close}>
          <X size={18} />
        </button>
        <div className="ui-modal-scroll modal-shell-scroll bg-crop-scroll">
          <div className="modal-shell-title">
            <h2>{labels.title}</h2>
          </div>

          <div
            ref={frameRef}
            className={`bg-crop-frame${dragging ? ' is-dragging' : ''}`}
            tabIndex={0}
            role="group"
            aria-label={labels.dragHint}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onLostPointerCapture={endDrag}
            onKeyDown={onKeyDown}
          >
            {ready && layout && (
              <img
                className="bg-crop-image"
                src={src}
                alt=""
                draggable={false}
                style={{
                  width: layout.width,
                  height: layout.height,
                  transform: `translate(-50%, -50%) translate(${editor.offsetX}px, ${editor.offsetY}px)`,
                }}
              />
            )}
            {loadFailed && <span className="bg-crop-status">{labels.loadError ?? DEFAULT_BG_LABELS.loadError}</span>}
          </div>

          <div className="bg-crop-controls">
            <div className="bg-zoom-row">
              <span className="bg-zoom-label">{labels.zoom}</span>
              <button type="button" className="soft bg-zoom-btn" onClick={() => setScale((editor?.scale ?? 1) - BUTTON_STEP)} disabled={!ready || busy || (editor?.scale ?? 1) <= MIN_SCALE} aria-label={labels.zoomOut} title={labels.zoomOut}>
                <Minus size={16} />
              </button>
              <input
                type="range"
                className="bg-zoom-range"
                min={MIN_SCALE}
                max={MAX_SCALE}
                step={0.01}
                value={editor?.scale ?? 1}
                disabled={!ready || busy}
                aria-label={labels.zoom}
                style={{ '--fill': rangeFill(editor?.scale ?? 1, MIN_SCALE, MAX_SCALE) } as React.CSSProperties}
                onChange={(event) => setScale(Number(event.target.value))}
              />
              <button type="button" className="soft bg-zoom-btn" onClick={() => setScale((editor?.scale ?? 1) + BUTTON_STEP)} disabled={!ready || busy || (editor?.scale ?? 1) >= MAX_SCALE} aria-label={labels.zoomIn} title={labels.zoomIn}>
                <Plus size={16} />
              </button>
              <span className="bg-zoom-value">{(editor?.scale ?? 1).toFixed(2)}×</span>
            </div>
            <p className="bg-crop-hint">{labels.dragHint}</p>
          </div>

          {saveError && <p className="bg-crop-error" role="alert">{saveError}</p>}

          <div className="bg-crop-footer">
            <button type="button" className="soft" onClick={onCancel} disabled={busy}>
              {labels.cancel}
            </button>
            <button type="button" className="primary" onClick={() => void save()} disabled={!ready || busy}>
              {busy ? labels.saving : labels.save}
            </button>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Area card (presentational)
// ---------------------------------------------------------------------------

export function BackgroundAreaCard({
  item,
  restore,
  busy,
  labels,
  onPickFile,
  onAdjust,
  onDelete,
  onRestore,
}: {
  item: BackgroundItem | null;
  restore: BackgroundRestore | null;
  busy: boolean;
  labels: BackgroundEditorLabels;
  onPickFile: (file: File) => void;
  onAdjust: () => void;
  onDelete: () => void;
  onRestore: () => void;
}) {
  return (
    <div className="bg-area-card">
      <div className="bg-area-thumb">
        {item?.url ? <img src={item.url} alt="" /> : <ImageOff size={22} aria-hidden="true" />}
      </div>
      <div className="bg-area-meta">
        <p className="bg-area-title">{item ? labels.customBackground : labels.noBackground}</p>
        {restore && (
          <p className="bg-area-restore">
            {labels.restoreUntil} {formatDeadline(restore.deadline)}
          </p>
        )}
      </div>
      <div className="bg-area-actions">
        <label className="soft bg-upload-label">
          <ImagePlus size={16} aria-hidden="true" />
          <span>{labels.upload}</span>
          <input
            type="file"
            accept="image/*"
            className="bg-file-input"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file) onPickFile(file);
            }}
          />
        </label>
        <button type="button" className="soft" onClick={onAdjust} disabled={!item}>
          <Crop size={16} aria-hidden="true" />
          <span>{labels.adjust}</span>
        </button>
        <button type="button" className="soft" onClick={onDelete} disabled={!item}>
          <Trash2 size={16} aria-hidden="true" />
          <span>{labels.delete}</span>
        </button>
        <button type="button" className="soft" onClick={onRestore} disabled={!restore || busy}>
          <RotateCcw size={16} aria-hidden="true" />
          <span>{labels.restore}</span>
        </button>
      </div>
    </div>
  );
}
