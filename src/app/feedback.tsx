import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, Loader2, Undo2, X } from 'lucide-react';
import './feedback.css';

/* ------------------------------------------------------------------ */
/* Pure scheduling (no React / DOM)                                    */
/* ------------------------------------------------------------------ */

export interface SchedulerHost {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

export interface ScheduledTask {
  /** Runs once when the timer expires, or immediately on flush(). */
  run: () => unknown;
  /** Included in flushAll(). Undoable commits set this; notice timers do not. */
  flushOnExit?: boolean;
  /** Receives sync throws and async rejections from run(). */
  onError?: (error: unknown) => void;
}

export interface Scheduler {
  schedule(id: number, durationMs: number, task: ScheduledTask): void;
  /** Removes the task without running it. Returns false if nothing was pending. */
  cancel(id: number): boolean;
  pause(id: number): void;
  resume(id: number): void;
  /** Milliseconds left, or null when no task is pending under this id. */
  remaining(id: number): number | null;
  has(id: number): boolean;
  /** Runs one task now, exactly once. Returns false if nothing was pending. */
  flush(id: number): boolean;
  /** Runs every pending task marked flushOnExit, exactly once each. */
  flushAll(): void;
  /** Cancels every pending task without running it. */
  clear(): void;
  size(): number;
}

interface Entry {
  task: ScheduledTask;
  remaining: number;
  startedAt: number;
  handle: unknown;
  armed: boolean;
  paused: boolean;
}

const defaultHost: SchedulerHost = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as PromiseLike<unknown>).then === 'function';
}

export function createScheduler(host: Partial<SchedulerHost> = {}): Scheduler {
  const h: SchedulerHost = { ...defaultHost, ...host };
  const entries = new Map<number, Entry>();

  const report = (task: ScheduledTask, error: unknown) => {
    if (task.onError) task.onError(error);
    else console.error('[feedback] scheduled task failed', error);
  };

  const disarm = (e: Entry) => {
    if (e.armed) {
      h.clearTimer(e.handle);
      e.armed = false;
    }
  };

  const execute = (id: number): boolean => {
    const e = entries.get(id);
    if (!e) return false;
    // Remove before running so a task can only ever run once.
    entries.delete(id);
    disarm(e);
    try {
      const out = e.task.run();
      if (isPromiseLike(out)) out.then(undefined, (error: unknown) => report(e.task, error));
    } catch (error) {
      report(e.task, error);
    }
    return true;
  };

  const arm = (id: number, e: Entry) => {
    e.startedAt = h.now();
    e.handle = h.setTimer(() => {
      execute(id);
    }, e.remaining);
    e.armed = true;
  };

  return {
    schedule(id, durationMs, task) {
      const existing = entries.get(id);
      if (existing) disarm(existing);
      const e: Entry = {
        task,
        remaining: Math.max(0, durationMs),
        startedAt: 0,
        handle: undefined,
        armed: false,
        paused: false,
      };
      entries.set(id, e);
      arm(id, e);
    },
    cancel(id) {
      const e = entries.get(id);
      if (!e) return false;
      disarm(e);
      entries.delete(id);
      return true;
    },
    pause(id) {
      const e = entries.get(id);
      if (!e || e.paused) return;
      e.remaining = Math.max(0, e.remaining - (h.now() - e.startedAt));
      disarm(e);
      e.paused = true;
    },
    resume(id) {
      const e = entries.get(id);
      if (!e || !e.paused) return;
      e.paused = false;
      arm(id, e);
    },
    remaining(id) {
      const e = entries.get(id);
      if (!e) return null;
      return e.paused ? e.remaining : Math.max(0, e.remaining - (h.now() - e.startedAt));
    },
    has(id) {
      return entries.has(id);
    },
    flush(id) {
      return execute(id);
    },
    flushAll() {
      for (const id of Array.from(entries.keys())) {
        const e = entries.get(id);
        if (e?.task.flushOnExit) execute(id);
      }
    },
    clear() {
      for (const e of entries.values()) disarm(e);
      entries.clear();
    },
    size() {
      return entries.size;
    },
  };
}

/** Every mounted provider registers its scheduler here so pagehide can flush them. */
const activeSchedulers = new Set<Scheduler>();

/** Runs every pending undoable commit now (once each). Safe with no provider mounted. */
export function flushPendingCommits(): void {
  for (const s of Array.from(activeSchedulers)) s.flushAll();
}

export function errorMessageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return '未知错误';
}

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type FeedbackTone = 'success' | 'error' | 'info' | 'warning';

export interface FeedbackAction {
  label: string;
  onClick: () => void;
}

export interface FeedbackLabels {
  undo: string;
  undone: string;
  close: string;
  working: string;
  failed: string;
}

export const DEFAULT_FEEDBACK_LABELS: FeedbackLabels = {
  undo: '撤销',
  undone: '已撤销',
  close: '关闭',
  working: '处理中…',
  failed: '操作失败',
};

export interface NotifyInput {
  title: string;
  detail?: string;
  tone?: 'success' | 'error' | 'info';
  actions?: FeedbackAction[];
}

type ResultDetail<T> = string | ((result: T) => string | undefined);
type ResultActions<T> = FeedbackAction[] | ((result: T) => FeedbackAction[]);

export interface RunOptions<T> {
  title: string;
  detail?: string;
  successTitle?: string;
  successDetail?: ResultDetail<T>;
  errorTitle?: string;
  actions?: ResultActions<T>;
}

export interface ConfirmUndoableOptions {
  title: string;
  detail?: string;
  commit: () => Promise<unknown> | unknown;
  successTitle?: string;
  onUndo?: () => void;
  onCommitted?: () => void;
  onError?: (error: unknown) => void;
}

export interface ActionFeedbackApi {
  notify: (input: NotifyInput) => number;
  toast: (text: string, kind?: 'ok' | 'error') => number;
  run: <T>(options: RunOptions<T>, action: () => Promise<T>) => Promise<T>;
  confirmUndoable: (options: ConfirmUndoableOptions) => { undo: () => void };
}

export interface FeedbackProviderProps {
  children: ReactNode;
  /** Notice and undo countdown length. Driven by the theme setting feedbackDurationMs. */
  durationMs?: number;
  labels?: Partial<FeedbackLabels>;
}

/* ------------------------------------------------------------------ */
/* Motion preference (independent of theme.tsx)                        */
/* ------------------------------------------------------------------ */

const REDUCE_QUERY = '(prefers-reduced-motion: reduce)';

function readReduceMotion(): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.documentElement;
  if (el.dataset.noMotion === '1' || el.dataset.reduceMotion === '1') return true;
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(REDUCE_QUERY).matches;
}

export function useMotionPref(): boolean {
  const [reduce, setReduce] = useState(readReduceMotion);
  useEffect(() => {
    const sync = () => setReduce(readReduceMotion());
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-no-motion', 'data-reduce-motion'],
    });
    const mq = typeof window.matchMedia === 'function' ? window.matchMedia(REDUCE_QUERY) : null;
    mq?.addEventListener?.('change', sync);
    sync();
    return () => {
      observer.disconnect();
      mq?.removeEventListener?.('change', sync);
    };
  }, []);
  return reduce;
}

/* ------------------------------------------------------------------ */
/* Provider state                                                      */
/* ------------------------------------------------------------------ */

const MAX_VISIBLE = 4;
const EXIT_MS = 170;
const STEP_MS = 250;
const UNDONE_MS = 2000;

/**
 * phase:
 *  - open       notice with countdown bar (dismisses on timer)
 *  - countdown  undoable operation waiting to commit (has Undo button)
 *  - running    operation in flight (indeterminate bar, no close)
 *  - closing    exit animation, removed after EXIT_MS
 */
type Phase = 'open' | 'countdown' | 'running' | 'closing';

interface CardState {
  id: number;
  phase: Phase;
  tone: FeedbackTone;
  title: string;
  detail?: string;
  actions: FeedbackAction[];
  paused: boolean;
  durationMs: number;
  /** Bumped whenever a countdown restarts, so the bar remounts and animates again. */
  cycle: number;
}

/** Keeps the newest card; drops the oldest card that is not pending. */
function trimCards(list: CardState[], onDrop: (id: number) => void): CardState[] {
  const next = [...list];
  while (next.length > MAX_VISIBLE) {
    const idx = next.findIndex((c, i) => i < next.length - 1 && c.phase !== 'countdown' && c.phase !== 'running');
    if (idx < 0) break;
    onDrop(next[idx].id);
    next.splice(idx, 1);
  }
  return next;
}

const FeedbackContext = createContext<ActionFeedbackApi | null>(null);

export function FeedbackProvider({ children, durationMs = 5000, labels }: FeedbackProviderProps) {
  const resolvedLabels = useMemo<FeedbackLabels>(() => ({ ...DEFAULT_FEEDBACK_LABELS, ...labels }), [labels]);
  const cfg = useRef({ durationMs, labels: resolvedLabels });
  cfg.current = { durationMs, labels: resolvedLabels };

  const [sched] = useState<Scheduler>(() => createScheduler());
  const [items, setItems] = useState<CardState[]>([]);
  const idRef = useRef(0);
  const undoHandlers = useRef(new Map<number, () => void>());
  const reduce = useMotionPref();

  const update = useCallback((id: number, fn: (card: CardState) => CardState) => {
    setItems((prev) => prev.map((c) => (c.id === id ? fn(c) : c)));
  }, []);

  const beginClose = useCallback((id: number) => {
    update(id, (c) => (c.phase === 'closing' ? c : { ...c, phase: 'closing', paused: false }));
  }, [update]);

  /** Starts (or restarts) a notice countdown that closes the card when it ends. */
  const armNotice = useCallback((id: number, ms: number) => {
    sched.schedule(id, ms, { run: () => beginClose(id) });
    update(id, (c) => ({ ...c, phase: 'open', paused: false, durationMs: ms, cycle: c.cycle + 1 }));
  }, [sched, beginClose, update]);

  const addCard = useCallback((card: Omit<CardState, 'id' | 'paused' | 'cycle'>): number => {
    const id = ++idRef.current;
    setItems((prev) => trimCards(
      [...prev, { ...card, id, paused: false, cycle: 0 }],
      (dropped) => {
        sched.cancel(dropped);
        undoHandlers.current.delete(dropped);
      },
    ));
    return id;
  }, [sched]);

  const removeCard = useCallback((id: number) => {
    sched.cancel(id);
    undoHandlers.current.delete(id);
    setItems((prev) => prev.filter((c) => c.id !== id));
  }, [sched]);

  /** Shows the final result on an existing card and starts its notice countdown. */
  const finish = useCallback((id: number, patch: Partial<CardState>) => {
    update(id, (c) => ({ ...c, ...patch, phase: 'open', paused: false }));
    armNotice(id, cfg.current.durationMs);
  }, [update, armNotice]);

  /** Runs an action on an existing card: running -> success or error notice. Never throws. */
  const settle = useCallback(async <T,>(
    id: number,
    action: () => Promise<T> | T,
    o: { title: string; detail?: string; successTitle?: string; successDetail?: ResultDetail<T>; errorTitle?: string; actions?: ResultActions<T> },
  ): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> => {
    let value: T;
    try {
      value = await action();
    } catch (error) {
      finish(id, {
        tone: 'error',
        title: o.errorTitle ?? cfg.current.labels.failed,
        detail: errorMessageOf(error),
        actions: [],
      });
      return { ok: false, error };
    }
    const detail = typeof o.successDetail === 'function' ? o.successDetail(value) : o.successDetail;
    const actions = typeof o.actions === 'function' ? o.actions(value) : (o.actions ?? []);
    finish(id, {
      tone: 'success',
      title: o.successTitle ?? o.title,
      detail: detail ?? o.detail,
      actions,
    });
    return { ok: true, value };
  }, [finish]);

  const notify = useCallback((input: NotifyInput): number => {
    const id = addCard({
      phase: 'open',
      tone: input.tone ?? 'info',
      title: input.title,
      detail: input.detail,
      actions: input.actions ?? [],
      durationMs: cfg.current.durationMs,
    });
    armNotice(id, cfg.current.durationMs);
    return id;
  }, [addCard, armNotice]);

  const toast = useCallback((text: string, kind?: 'ok' | 'error'): number => {
    return notify({ title: text, tone: kind === 'error' ? 'error' : 'success' });
  }, [notify]);

  const run = useCallback(async <T,>(options: RunOptions<T>, action: () => Promise<T>): Promise<T> => {
    const id = addCard({
      phase: 'running',
      tone: 'info',
      title: options.title,
      detail: options.detail ?? cfg.current.labels.working,
      actions: [],
      durationMs: cfg.current.durationMs,
    });
    const res = await settle(id, action, options);
    if (!res.ok) throw res.error;
    return res.value;
  }, [addCard, settle]);

  const confirmUndoable = useCallback((options: ConfirmUndoableOptions): { undo: () => void } => {
    const dur = cfg.current.durationMs;
    const id = addCard({
      phase: 'countdown',
      tone: 'warning',
      title: options.title,
      detail: options.detail,
      actions: [],
      durationMs: dur,
    });

    const commitNow = async () => {
      update(id, (c) => ({ ...c, phase: 'running', tone: 'info', paused: false, cycle: c.cycle + 1 }));
      undoHandlers.current.delete(id);
      const res = await settle(id, () => options.commit(), {
        title: options.title,
        detail: options.detail,
        successTitle: options.successTitle,
      });
      if (res.ok) options.onCommitted?.();
      else options.onError?.(res.error);
    };

    sched.schedule(id, dur, { flushOnExit: true, run: commitNow });

    const undo = () => {
      // cancel() is false once the commit has started, so a late Undo is a no-op.
      if (!sched.cancel(id)) return;
      undoHandlers.current.delete(id);
      options.onUndo?.();
      update(id, (c) => ({
        ...c,
        phase: 'open',
        tone: 'info',
        title: cfg.current.labels.undone,
        detail: undefined,
        actions: [],
        paused: false,
        durationMs: UNDONE_MS,
        cycle: c.cycle + 1,
      }));
      sched.schedule(id, UNDONE_MS, { run: () => beginClose(id) });
    };
    undoHandlers.current.set(id, undo);
    return { undo };
  }, [addCard, settle, sched, update, beginClose]);

  const closeCard = useCallback((id: number) => {
    // Notices only: running the timer task closes the card through the normal exit path.
    if (!sched.flush(id)) beginClose(id);
  }, [sched, beginClose]);

  const undoCard = useCallback((id: number) => {
    undoHandlers.current.get(id)?.();
  }, []);

  const hoverCard = useCallback((id: number, hovering: boolean) => {
    if (hovering) sched.pause(id);
    else sched.resume(id);
    update(id, (c) => (c.paused === hovering ? c : { ...c, paused: hovering }));
  }, [sched, update]);

  useEffect(() => {
    activeSchedulers.add(sched);
    const onPageHide = () => sched.flushAll();
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      // Unmount: commit pending undoable operations rather than silently dropping them.
      sched.flushAll();
      sched.clear();
      activeSchedulers.delete(sched);
      undoHandlers.current.clear();
    };
  }, [sched]);

  const api = useMemo<ActionFeedbackApi>(
    () => ({ notify, toast, run, confirmUndoable }),
    [notify, toast, run, confirmUndoable],
  );

  return (
    <FeedbackContext.Provider value={api}>
      {children}
      {typeof document !== 'undefined'
        ? createPortal(
          <FeedbackViewport
            items={items}
            sched={sched}
            labels={resolvedLabels}
            reduce={reduce}
            onClose={closeCard}
            onUndo={undoCard}
            onHover={hoverCard}
            onRemoved={removeCard}
          />,
          document.body,
        )
        : null}
    </FeedbackContext.Provider>
  );
}

export function useFeedback(): ActionFeedbackApi {
  const value = useContext(FeedbackContext);
  if (!value) throw new Error('useFeedback must be used within FeedbackProvider');
  return value;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

interface ViewportProps {
  items: CardState[];
  sched: Scheduler;
  labels: FeedbackLabels;
  reduce: boolean;
  onClose: (id: number) => void;
  onUndo: (id: number) => void;
  onHover: (id: number, hovering: boolean) => void;
  onRemoved: (id: number) => void;
}

function FeedbackViewport({ items, sched, labels, reduce, onClose, onUndo, onHover, onRemoved }: ViewportProps) {
  return (
    <div
      className="cs-fb-viewport"
      data-motion={reduce ? 'reduce' : undefined}
      aria-live="polite"
      aria-relevant="additions text"
    >
      {items.map((item) => (
        <FeedbackCard
          key={item.id}
          item={item}
          sched={sched}
          labels={labels}
          reduce={reduce}
          onClose={onClose}
          onUndo={onUndo}
          onHover={onHover}
          onRemoved={onRemoved}
        />
      ))}
    </div>
  );
}

interface CardProps {
  item: CardState;
  sched: Scheduler;
  labels: FeedbackLabels;
  reduce: boolean;
  onClose: (id: number) => void;
  onUndo: (id: number) => void;
  onHover: (id: number, hovering: boolean) => void;
  onRemoved: (id: number) => void;
}

function FeedbackCard({ item, sched, labels, reduce, onClose, onUndo, onHover, onRemoved }: CardProps) {
  const { id, phase, tone, title, detail, actions, paused, durationMs, cycle } = item;

  useEffect(() => {
    if (phase !== 'closing') return;
    if (reduce) {
      onRemoved(id);
      return;
    }
    const timer = setTimeout(() => onRemoved(id), EXIT_MS);
    return () => clearTimeout(timer);
  }, [phase, reduce, id, onRemoved]);

  const Icon = phase === 'running'
    ? Loader2
    : tone === 'success'
      ? CheckCircle2
      : tone === 'error'
        ? AlertCircle
        : tone === 'warning'
          ? AlertTriangle
          : Info;

  const undoable = phase === 'countdown';
  const showClose = phase === 'open';

  return (
    <div
      className="cs-fb-card"
      data-tone={tone}
      data-phase={phase}
      data-paused={paused ? '1' : undefined}
      role={tone === 'error' ? 'alert' : undefined}
      onMouseEnter={() => onHover(id, true)}
      onMouseLeave={() => onHover(id, false)}
    >
      <div className="cs-fb-head">
        <Icon
          className={phase === 'running' ? 'cs-fb-icon cs-fb-spin' : 'cs-fb-icon'}
          size={16}
          aria-hidden="true"
        />
        <span className="cs-fb-title">{title}</span>
        <span className="cs-fb-side">
          {undoable ? (
            <button type="button" className="cs-fb-undo" onClick={() => onUndo(id)}>
              <Undo2 size={13} aria-hidden="true" />
              {labels.undo}
            </button>
          ) : null}
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              className="cs-fb-action"
              onClick={() => {
                action.onClick();
                onClose(id);
              }}
            >
              {action.label}
            </button>
          ))}
          {showClose ? (
            <button
              type="button"
              className="cs-fb-close"
              aria-label={labels.close}
              title={labels.close}
              onClick={() => onClose(id)}
            >
              <X size={14} aria-hidden="true" />
            </button>
          ) : null}
        </span>
      </div>
      {detail ? <p className="cs-fb-detail">{detail}</p> : null}
      {phase === 'running' ? (
        <div className="cs-fb-track" aria-hidden="true">
          <i className="cs-fb-indet" />
        </div>
      ) : phase === 'closing' ? null : (
        <CountdownBar
          key={`${id}:${cycle}`}
          id={id}
          durationMs={durationMs}
          paused={paused}
          reduce={reduce}
          sched={sched}
        />
      )}
    </div>
  );
}

function CountdownBar({ id, durationMs, paused, reduce, sched }: {
  id: number;
  durationMs: number;
  paused: boolean;
  reduce: boolean;
  sched: Scheduler;
}) {
  const [fraction, setFraction] = useState(1);

  useEffect(() => {
    if (!reduce) return;
    const tick = () => {
      const left = sched.remaining(id);
      setFraction(left === null ? 0 : Math.max(0, Math.min(1, left / durationMs)));
    };
    tick();
    const timer = setInterval(tick, STEP_MS);
    return () => clearInterval(timer);
  }, [reduce, id, durationMs, sched]);

  if (reduce) {
    // No sweep animation: the bar steps down every 250ms so the time still visibly runs.
    return (
      <div className="cs-fb-track" aria-hidden="true">
        <i className="cs-fb-fill cs-fb-stepped" style={{ transform: `scaleX(${fraction})` }} />
      </div>
    );
  }

  return (
    <div className="cs-fb-track" aria-hidden="true">
      <i
        className="cs-fb-fill cs-fb-sweep"
        style={{
          ['--fb-dur' as string]: `${durationMs}ms`,
          animationPlayState: paused ? 'paused' : 'running',
        }}
      />
    </div>
  );
}
