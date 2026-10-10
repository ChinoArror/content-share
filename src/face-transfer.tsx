import React, { DragEvent, useEffect, useRef, useState } from 'react';
import {
  Camera,
  CheckCircle2,
  Download,
  FileUp,
  Pause,
  Play,
  QrCode,
  RotateCcw,
  ScanLine,
} from 'lucide-react';
import { createQRTransferProfile } from '@raptorqr/core/protocol/profiles';
import { createRaptorQPlaybackOrders } from '@raptorqr/core/sender/raptorq_playback';
import { renderQRCodeImageData } from '@raptorqr/core/qr/qr_encoder_browser';
import { useI18n } from './i18n';
import { rangeFill } from './app/select';

type Toast = (text: string, kind?: 'ok' | 'error') => void;
type Mode = 'send' | 'receive';
type ReceivedFile = {
  filename: string;
  mimeType: string;
  size: number;
  url: string;
};

const MAX_FILE_SIZE = 15 * 1024 * 1024;
const profile = createQRTransferProfile(20, 'L');

export function FaceTransfer({ toast }: { toast: Toast }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>('send');

  return (
    <section className="face-transfer">
      <div className="face-transfer-title">
        <div>
          <p>{t('face.localOnly')}</p>
        </div>
        <div className="segmented face-mode" role="tablist" aria-label={t('face.transferMode')}>
          <button type="button" className={mode === 'send' ? 'on' : ''} onClick={() => setMode('send')} role="tab">
            <QrCode size={17} /> {t('face.send')}
          </button>
          <button type="button" className={mode === 'receive' ? 'on' : ''} onClick={() => setMode('receive')} role="tab">
            <ScanLine size={17} /> {t('face.receive')}
          </button>
        </div>
      </div>
      {mode === 'send' ? <SendFile toast={toast} /> : <ReceiveFile toast={toast} />}
    </section>
  );
}

function SendFile({ toast }: { toast: Toast }) {
  const { t } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const [encoding, setEncoding] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [frame, setFrame] = useState(0);
  const [frameCount, setFrameCount] = useState(0);
  const [encodedSize, setEncodedSize] = useState(0);
  const [frameDelay, setFrameDelay] = useState(180);
  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const timerRef = useRef<number | null>(null);
  const packetsRef = useRef<Uint8Array[]>([]);
  const orderRef = useRef<number[]>([]);
  const cursorRef = useRef(0);
  const playingRef = useRef(false);
  const renderRunRef = useRef(0);
  const frameDelayRef = useRef(180);

  useEffect(() => () => stopPlayback(true), []);

  function chooseFile(next: File | null) {
    stopPlayback(true);
    setFrame(0);
    setFrameCount(0);
    setEncodedSize(0);
    if (!next) {
      setFile(null);
      return;
    }
    if (next.size === 0) {
      toast(t('face.emptyFile'), 'error');
      return;
    }
    if (next.size > MAX_FILE_SIZE) {
      toast(t('face.maxSize'), 'error');
      return;
    }
    setFile(next);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    chooseFile(event.dataTransfer.files[0] || null);
  }

  async function encode() {
    if (!file || encoding) return;
    stopPlayback(true);
    setEncoding(true);
    setFrame(0);
    try {
      const data = await file.arrayBuffer();
      const worker = new Worker(new URL('./workers/fountain-encode.worker.ts', import.meta.url), { type: 'module' });
      workerRef.current = worker;
      const result = await new Promise<{
        packets: Uint8Array[];
        sourcePacketIndices: number[];
        repairPacketIndices: number[];
        encodedSize: number;
      }>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error(t('face.encodeTimeout'))), 120_000);
        worker.onmessage = (event) => {
          if (event.data.type === 'encoded') {
            window.clearTimeout(timeout);
            resolve(event.data);
          } else if (event.data.type === 'error') {
            window.clearTimeout(timeout);
            reject(new Error(event.data.message));
          }
        };
        worker.onerror = (event) => {
          window.clearTimeout(timeout);
          reject(new Error(event.message || t('face.encodeFailed')));
        };
        worker.postMessage({
          type: 'encode',
          data,
          filename: file.name,
          mimeType: file.type || 'application/octet-stream',
        }, [data]);
      });
      worker.terminate();
      workerRef.current = null;

      packetsRef.current = result.packets.map((packet) => new Uint8Array(packet));
      const orders = createRaptorQPlaybackOrders(
        result.sourcePacketIndices,
        result.repairPacketIndices,
        'balanced',
      );
      orderRef.current = orders.loopOrder;
      cursorRef.current = 0;
      setFrameCount(orders.loopOrder.length);
      setEncodedSize(result.encodedSize);
      startPlayback();
      toast(t('face.encode'));
    } catch (error) {
      toast(error instanceof Error ? error.message : t('face.encodeFailed'), 'error');
    } finally {
      workerRef.current?.terminate();
      workerRef.current = null;
      setEncoding(false);
    }
  }

  function startPlayback() {
    if (!orderRef.current.length) return;
    playingRef.current = true;
    setPlaying(true);
    const run = ++renderRunRef.current;
    void drawNextFrame(run);
  }

  async function drawNextFrame(run: number) {
    if (!playingRef.current || run !== renderRunRef.current) return;
    const order = orderRef.current;
    const packetIndex = order[cursorRef.current % order.length]!;
    try {
      const image = await renderQRCodeImageData(packetsRef.current[packetIndex]!, profile.version, profile.eccLevel, 5);
      if (!playingRef.current || run !== renderRunRef.current) return;
      const canvas = canvasRef.current;
      const context = canvas?.getContext('2d');
      if (canvas && context) {
        const quiet = 24;
        canvas.width = image.width + quiet * 2;
        canvas.height = image.height + quiet * 2;
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.putImageData(image, quiet, quiet);
      }
      const nextCursor = cursorRef.current + 1;
      if (nextCursor >= order.length) {
        setFrame(order.length);
        orderRef.current = shuffle(order);
        cursorRef.current = 0;
      } else {
        cursorRef.current = nextCursor;
        setFrame(nextCursor);
      }
      timerRef.current = window.setTimeout(() => void drawNextFrame(run), frameDelayRef.current);
    } catch (error) {
      stopPlayback();
      toast(error instanceof Error ? error.message : t('face.qrFailed'), 'error');
    }
  }

  function stopPlayback(clear = false) {
    playingRef.current = false;
    renderRunRef.current++;
    setPlaying(false);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    workerRef.current?.terminate();
    workerRef.current = null;
    if (clear) {
      packetsRef.current = [];
      orderRef.current = [];
      cursorRef.current = 0;
    }
  }

  return (
    <div className="face-grid">
      <div className="panel face-control-panel">
        <div
          className="face-drop"
          onDragOver={(event) => event.preventDefault()}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click(); }}
        >
          <FileUp size={30} />
          <strong>{file ? file.name : t('face.chooseDrop')}</strong>
          <span>{file ? `${formatBytes(file.size)} · ${file.type || t('face.unknownType')}` : t('face.maxLocal')}</span>
          <input ref={inputRef} type="file" hidden onChange={(event) => chooseFile(event.target.files?.[0] || null)} />
        </div>
        <button type="button" className="primary face-main-action" disabled={!file || encoding} onClick={encode}>
          <QrCode size={18} /> {encoding ? t('face.encoding') : frameCount ? t('face.regenerate') : t('face.encode')}
        </button>
      </div>

      <div className="panel face-code-panel">
        {frameCount ? (
          <>
            <canvas ref={canvasRef} className="fountain-code" aria-label="Fountain Code" />
            <div className="face-progress">
              <div>
                <strong>{playing ? t('face.sending') : t('face.paused')}</strong>
                <span>{t('face.frame', { current: frame, total: frameCount })}</span>
              </div>
              <button type="button" className="icon" onClick={() => playing ? stopPlayback() : startPlayback()} title={playing ? t('face.pause') : t('face.resume')} aria-label={playing ? t('face.qrPause') : t('face.qrResume')}>
                {playing ? <Pause size={18} /> : <Play size={18} />}
              </button>
            </div>
            <label className="face-speed">
              <span>{t('face.interval', { value: frameDelay })}</span>
              <input
                type="range"
                min="100"
                max="320"
                step="20"
                value={frameDelay}
                style={{ ['--fill' as any]: rangeFill(frameDelay, 100, 320) }}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  frameDelayRef.current = value;
                  setFrameDelay(value);
                }}
              />
            </label>
            <div className="progress-track"><i style={{ width: `${Math.max(2, frameCount ? (frame / frameCount) * 100 : 0)}%` }} /></div>
            <div className="face-metrics">
              <span>{t('face.sourceFile', { size: formatBytes(file?.size || 0) })}</span>
              <span>{t('face.encodedData', { size: formatBytes(encodedSize) })}</span>
              <span>{t('face.redundancy')}</span>
            </div>
          </>
        ) : (
          <div className="face-empty">
            <QrCode size={46} />
            <strong>{t('face.emptyQr')}</strong>
            <span>{t('face.scanRecovery')}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function ReceiveFile({ toast }: { toast: Toast }) {
  const { t, language } = useI18n();
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState({ received: 0, needed: 0, percent: 0 });
  const [received, setReceived] = useState<ReceivedFile | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const timerRef = useRef<number | null>(null);
  const busyRef = useRef(false);
  const scanningRef = useRef(false);

  useEffect(() => () => {
    stopScanning();
    if (received?.url) URL.revokeObjectURL(received.url);
  }, [received?.url]);

  async function startScanning() {
    stopScanning();
    if (received?.url) URL.revokeObjectURL(received.url);
    setReceived(null);
    setProgress({ received: 0, needed: 0, percent: 0 });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      const video = videoRef.current;
      if (!video) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      video.srcObject = stream;
      await video.play();

      const worker = new Worker(new URL('./workers/fountain-decode.worker.ts', import.meta.url), { type: 'module' });
      workerRef.current = worker;
      worker.onmessage = (event) => {
        const message = event.data;
        if (message.type === 'frame-done') {
          busyRef.current = false;
          return;
        }
        if (message.type === 'progress') {
          setProgress({ received: message.received, needed: message.needed, percent: message.percent });
          return;
        }
        if (message.type === 'complete') {
          const blob = new Blob([message.data], { type: message.mimeType || 'application/octet-stream' });
          setReceived({
            filename: message.filename || 'recovered-file',
            mimeType: message.mimeType || 'application/octet-stream',
            size: blob.size,
            url: URL.createObjectURL(blob),
          });
          toast(t('face.receivedToast'));
          stopScanning();
          return;
        }
        if (message.type === 'error') {
          toast(message.message || t('face.decodeFailed'), 'error');
        }
      };
      worker.onerror = (event) => toast(event.message || t('face.decodeFailed'), 'error');

      scanningRef.current = true;
      setScanning(true);
      scanFrame();
    } catch (error) {
      toast(cameraError(error, language), 'error');
    }
  }

  function scanFrame() {
    if (!scanningRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const worker = workerRef.current;
    if (!busyRef.current && video && canvas && worker && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      const width = Math.min(720, video.videoWidth || 720);
      const height = Math.max(1, Math.round(width * (video.videoHeight || 720) / (video.videoWidth || 1280)));
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (context) {
        context.drawImage(video, 0, 0, width, height);
        const imageData = context.getImageData(0, 0, width, height);
        busyRef.current = true;
        worker.postMessage({ type: 'frame', imageData }, [imageData.data.buffer]);
      }
    }
    timerRef.current = window.setTimeout(scanFrame, 55 + Math.random() * 50);
  }

  function stopScanning() {
    scanningRef.current = false;
    busyRef.current = false;
    setScanning(false);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    workerRef.current?.terminate();
    workerRef.current = null;
  }

  return (
    <div className="face-grid receive-grid">
      <div className="panel face-camera-panel">
        <div className={`camera-stage ${scanning ? 'active' : ''}`}>
          <video ref={videoRef} muted playsInline />
          <canvas ref={canvasRef} hidden />
          {!scanning && !received && (
            <div className="face-empty">
              <Camera size={46} />
              <strong>{t('face.prepareScan')}</strong>
              <span>{t('face.cameraHint')}</span>
            </div>
          )}
          {scanning && <div className="scan-frame" aria-hidden="true"><i /><i /><i /><i /></div>}
        </div>
        <div className="receive-actions">
          <button type="button" className={scanning ? 'soft' : 'primary'} onClick={scanning ? stopScanning : startScanning}>
            {scanning ? <Pause size={18} /> : <ScanLine size={18} />}
            {scanning ? t('face.stopScan') : received ? t('face.continueReceive') : t('face.startCamera')}
          </button>
          {scanning && <span>{t('face.keepQr')}</span>}
        </div>
        {(scanning || progress.received > 0) && (
          <div className="receive-progress">
            <div><strong>{t('face.recognized', { count: progress.received })}</strong><span>{t('face.needed', { count: progress.needed || '…' })}</span></div>
            <div className="progress-track"><i style={{ width: `${progress.percent}%` }} /></div>
            <small>{progress.percent}% · {t('face.repair')}</small>
          </div>
        )}
      </div>

      <div className="panel face-result-panel">
        {received ? (
          <>
            <div className="received-head">
              <CheckCircle2 size={34} />
              <div><strong>{t('face.received')}</strong><span>{received.filename}</span></div>
            </div>
            <FilePreview file={received} />
            <div className="received-meta">
              <span>{formatBytes(received.size)}</span>
              <span>{received.mimeType}</span>
            </div>
            <a className="primary received-download" href={received.url} download={received.filename}>
              <Download size={18} /> {t('face.save')}
            </a>
          </>
        ) : (
          <div className="face-empty">
            <RotateCcw size={42} />
            <strong>{t('face.waiting')}</strong>
            <span>{t('face.waitingHint')}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function FilePreview({ file }: { file: ReceivedFile }) {
  if (file.mimeType.startsWith('image/')) return <img className="received-preview" src={file.url} alt={file.filename} />;
  if (file.mimeType.startsWith('video/')) return <video className="received-preview" src={file.url} controls />;
  if (file.mimeType.startsWith('audio/')) return <audio className="received-audio" src={file.url} controls />;
  if (file.mimeType === 'application/pdf') return <iframe className="received-preview" src={file.url} title={file.filename} />;
  return <div className="received-file-icon"><FileUp size={42} /><span>{file.filename.split('.').pop()?.toUpperCase() || 'FILE'}</span></div>;
}

function cameraError(error: unknown, language: 'zh-CN' | 'en-US' = 'zh-CN') {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError') return language === 'en-US' ? 'Camera permission was denied. Allow access in browser settings.' : '摄像头权限被拒绝，请在浏览器设置中允许访问';
  if (name === 'NotFoundError') return language === 'en-US' ? 'No usable camera was found' : '没有找到可用摄像头';
  if (!window.isSecureContext) return language === 'en-US' ? 'Camera access requires HTTPS or localhost' : '摄像头只能在 HTTPS 或 localhost 中使用';
  return error instanceof Error ? error.message : language === 'en-US' ? 'Unable to start camera' : '无法启动摄像头';
}

function formatBytes(value: number) {
  if (!value) return '0 B';
  const units = ['B', 'KiB', 'MiB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function shuffle(values: number[]) {
  const next = [...values];
  for (let index = next.length - 1; index > 0; index--) {
    const swap = Math.floor(Math.random() * (index + 1));
    [next[index], next[swap]] = [next[swap]!, next[index]!];
  }
  return next;
}
