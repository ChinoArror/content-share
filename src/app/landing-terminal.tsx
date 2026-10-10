import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import './landing-terminal.css';

export type TerminalLine = { kind: 'cmd' | 'out' | 'comment'; text: string };

type Phase = 'typing' | 'processing' | 'done';
type Pos = { line: number; chars: number; phase: Phase };
type Step = { next: Pos; delay: number | null };

const START_DELAY_MS = 200;
const OUT_WAIT_MS = 450;
const OUT_REVEAL_PAUSE_MS = 250;
const LINE_PAUSE_MS = 180;
const RESUME_DELAY_MS = 150;

const TOKEN_SOURCE =
  /("(?:[^"\\]|\\.)*"?|'[^']*'?)|(https?:\/\/[^\s'"]+)|((?<![\w-])--?[A-Za-z][\w-]*)/.source;

export const DEFAULT_LANDING_LINES = (baseUrl: string): TerminalLine[] => [
  { kind: 'comment', text: '# Publish markdown from your terminal' },
  { kind: 'cmd', text: `curl -X POST ${baseUrl}/api/cli/upload-text \\` },
  { kind: 'cmd', text: '  -H "Authorization: Bearer <API_KEY>" \\' },
  { kind: 'cmd', text: '  -H "Content-Type: application/json" \\' },
  { kind: 'cmd', text: `  -d '{"title":"note","content":"# hello","format":"markdown","visibility":"public"}'` },
  { kind: 'out', text: `{"ok":true,"url":"${baseUrl}/s/k3f9x2a"}` },
  { kind: 'cmd', text: '' },
];

function prefersReduced(): boolean {
  const html = document.documentElement;
  if (html.dataset.reduceMotion === '1' || html.dataset.noMotion === '1') return true;
  return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

function enterPhase(line: TerminalLine): Phase {
  return line.kind === 'out' ? 'processing' : 'typing';
}

function endPos(lines: TerminalLine[]): Pos {
  const last = Math.max(0, lines.length - 1);
  return { line: last, chars: lines[last]?.text.length ?? 0, phase: 'done' };
}

function typeDelay(kind: TerminalLine['kind'], ch: string): number {
  if (kind === 'comment') return 9 + Math.random() * 6;
  const base = 14 + Math.random() * 14;
  return /[\s.,;:=/|{}()[\]]/.test(ch) ? base + 45 : base;
}

/** One scheduler step: type a character, reveal output, or advance to the next line. */
function step(p: Pos, lines: TerminalLine[]): Step {
  const line = lines[p.line];
  if (p.phase === 'done' || !line) return { next: { ...p, phase: 'done' }, delay: null };
  if (p.phase === 'processing') {
    return { next: { ...p, chars: line.text.length, phase: 'typing' }, delay: OUT_REVEAL_PAUSE_MS };
  }
  if (p.chars < line.text.length) {
    const chars = p.chars + 1;
    return { next: { ...p, chars }, delay: typeDelay(line.kind, line.text.charAt(chars - 1)) };
  }
  const nextLine = lines[p.line + 1];
  if (!nextLine) return { next: { ...p, phase: 'done' }, delay: null };
  return {
    next: { line: p.line + 1, chars: 0, phase: enterPhase(nextLine) },
    delay: nextLine.kind === 'out' ? OUT_WAIT_MS : LINE_PAUSE_MS,
  };
}

/** A command line shows the prompt unless the previous command line ends with a backslash. */
function hasPrompt(lines: TerminalLine[], i: number): boolean {
  if (lines[i].kind !== 'cmd') return false;
  const prev = lines[i - 1];
  return !(prev && prev.kind === 'cmd' && prev.text.trimEnd().endsWith('\\'));
}

function highlight(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = new RegExp(TOKEN_SOURCE, 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const cls = m[1] ? 'tl-str' : m[2] ? 'tl-url' : 'tl-flag';
    out.push(<span key={m.index} className={cls}>{m[0]}</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function LandingTerminal({
  lines,
  title = 'zsh — content.aryuki.com',
  ariaLabel,
  className,
}: {
  lines: TerminalLine[];
  title?: string;
  ariaLabel: string;
  className?: string;
}): JSX.Element {
  // Restart only when the content changes, not when the caller passes a new array with the same lines.
  const key = JSON.stringify(lines);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stable = useMemo(() => lines, [key]);
  const lastIdx = stable.length - 1;

  const cardRef = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  const [inView, setInView] = useState(false);
  const [ready, setReady] = useState(false);
  const [full, setFull] = useState(false);
  const [pos, setPos] = useState<Pos>({ line: 0, chars: 0, phase: 'typing' });
  const [copied, setCopied] = useState(false);

  const go = ready && inView;
  const started = full || go;
  const cur = full ? endPos(stable) : pos;
  const activeLine = cur.phase === 'done' ? lastIdx : cur.line;

  // Reduced motion: show everything at once.
  useEffect(() => {
    const sync = () => setFull(prefersReduced());
    sync();
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    mq?.addEventListener?.('change', sync);
    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-reduce-motion', 'data-no-motion'] });
    return () => {
      mq?.removeEventListener?.('change', sync);
      mo.disconnect();
    };
  }, []);

  // Wait for load, fonts and two frames, then 350ms of idle.
  useEffect(() => {
    let cancelled = false;
    let raf1 = 0;
    let raf2 = 0;
    let idle: number | undefined;
    const afterFonts = () => {
      if (cancelled) return;
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          idle = window.setTimeout(() => {
            if (!cancelled) setReady(true);
          }, 350);
        });
      });
    };
    const begin = () => {
      if (cancelled) return;
      const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
      if (fonts?.ready) fonts.ready.then(afterFonts, afterFonts);
      else afterFonts();
    };
    if (document.readyState === 'complete') begin();
    else window.addEventListener('load', begin, { once: true });
    return () => {
      cancelled = true;
      window.removeEventListener('load', begin);
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.clearTimeout(idle);
    };
  }, []);

  // Start only once the terminal is at least 30% visible.
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    if (!('IntersectionObserver' in window)) {
      setInView(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting && e.intersectionRatio >= 0.3)) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold: 0.3 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Typing scheduler. Restarts when the content changes; pauses while the tab is hidden.
  useEffect(() => {
    if (!go || full || stable.length === 0) return;
    let p: Pos = { line: 0, chars: 0, phase: enterPhase(stable[0]) };
    let timer: number | undefined;
    let paused = document.hidden;

    const run = () => {
      timer = undefined;
      if (document.hidden) {
        paused = true;
        return;
      }
      const s = step(p, stable);
      p = s.next;
      setPos(p);
      if (s.delay !== null) timer = window.setTimeout(run, s.delay);
    };
    const onVisibility = () => {
      if (!document.hidden && paused) {
        paused = false;
        if (timer === undefined) timer = window.setTimeout(run, RESUME_DELAY_MS);
      }
    };

    setPos(p);
    timer = window.setTimeout(run, START_DELAY_MS);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [go, full, stable]);

  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const copyText = useMemo(
    () => stable.filter((l) => l.kind === 'cmd' && l.text.trim()).map((l) => l.text).join('\n'),
    [stable],
  );
  const fullText = useMemo(() => stable.map((l) => l.text).join('\n'), [stable]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyText);
    } catch {
      return;
    }
    setCopied(true);
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={`tl-root${className ? ` ${className}` : ''}`}>
      <div className="tl-card" ref={cardRef} role="region" aria-label={ariaLabel}>
        <div className="tl-chrome">
          <div className="tl-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div className="tl-title">{title}</div>
          <button
            type="button"
            className="tl-copy"
            onClick={copy}
            aria-label={copied ? 'Copied' : 'Copy command'}
            title={copied ? 'Copied' : 'Copy command'}
            data-copied={copied ? '1' : undefined}
          >
            {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          </button>
        </div>
        <div className="tl-body">
          <pre className="tl-sr">{fullText}</pre>
          <div className="tl-stage" aria-hidden="true">
            {stable.map((line, i) => {
              const typed = !started ? 0 : i < cur.line ? line.text.length : i === cur.line ? cur.chars : 0;
              const shown = line.text.slice(0, typed);
              const rest = line.text.slice(typed);
              const visible = started && i <= cur.line;
              const isActive = started && i === activeLine && cur.phase !== 'processing';
              const solid = cur.phase === 'typing' && typed < line.text.length;
              const busy = started && i === cur.line && cur.phase === 'processing';
              const lead =
                line.kind === 'cmd' && hasPrompt(stable, i) ? (
                  <span className={`tl-prompt${visible ? '' : ' tl-hidden'}`}>{'❯'}</span>
                ) : (
                  <span className="tl-gutter" />
                );
              return (
                <div key={i} className={`tl-line is-${line.kind}`}>
                  {lead}
                  <span className="tl-typed">{line.kind === 'cmd' ? highlight(shown) : shown}</span>
                  {isActive && <span className={`tl-caret${solid ? ' is-solid' : ''}`} />}
                  <span className="tl-rest">{rest || '​'}</span>
                  {busy && <span className="tl-busy" />}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
