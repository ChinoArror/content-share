import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createScheduler, flushPendingCommits } from './feedback';

describe('feedback scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires the commit once after the duration', () => {
    const s = createScheduler();
    const commit = vi.fn();
    s.schedule(1, 5000, { run: commit, flushOnExit: true });

    vi.advanceTimersByTime(4999);
    expect(commit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(commit).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_000);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(s.has(1)).toBe(false);
  });

  it('undo before expiry prevents the commit', () => {
    const s = createScheduler();
    const commit = vi.fn();
    s.schedule(1, 5000, { run: commit, flushOnExit: true });

    vi.advanceTimersByTime(2000);
    expect(s.cancel(1)).toBe(true);
    expect(s.cancel(1)).toBe(false);

    vi.advanceTimersByTime(10_000);
    expect(commit).not.toHaveBeenCalled();
  });

  it('flushAll runs pending commits immediately, exactly once', () => {
    const s = createScheduler();
    const a = vi.fn();
    const b = vi.fn();
    s.schedule(1, 5000, { run: a, flushOnExit: true });
    s.schedule(2, 8000, { run: b, flushOnExit: true });

    s.flushAll();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(s.size()).toBe(0);

    vi.advanceTimersByTime(20_000);
    s.flushAll();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('flushAll leaves notice timers alone', () => {
    const s = createScheduler();
    const dismiss = vi.fn();
    s.schedule(1, 5000, { run: dismiss });

    s.flushAll();
    expect(dismiss).not.toHaveBeenCalled();
    expect(s.has(1)).toBe(true);
  });

  it('reports a failing commit to onError', async () => {
    const s = createScheduler();
    const error = new Error('boom');
    const onError = vi.fn();
    s.schedule(1, 5000, {
      run: () => Promise.reject(error),
      flushOnExit: true,
      onError,
    });

    vi.advanceTimersByTime(5000);
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error);
  });

  it('reports a synchronous throw to onError', () => {
    const s = createScheduler();
    const onError = vi.fn();
    s.schedule(1, 100, {
      run: () => {
        throw new Error('sync');
      },
      onError,
    });

    s.flush(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('pause and resume keep the remaining time', () => {
    const s = createScheduler();
    const commit = vi.fn();
    s.schedule(1, 5000, { run: commit, flushOnExit: true });

    vi.advanceTimersByTime(2000);
    s.pause(1);
    expect(s.remaining(1)).toBe(3000);

    vi.advanceTimersByTime(60_000);
    expect(commit).not.toHaveBeenCalled();

    s.resume(1);
    vi.advanceTimersByTime(2999);
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('flush runs a task now and only once', () => {
    const s = createScheduler();
    const commit = vi.fn();
    s.schedule(1, 5000, { run: commit, flushOnExit: true });

    expect(s.flush(1)).toBe(true);
    expect(s.flush(1)).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('clear cancels everything without running it', () => {
    const s = createScheduler();
    const commit = vi.fn();
    s.schedule(1, 5000, { run: commit, flushOnExit: true });
    s.clear();

    vi.advanceTimersByTime(10_000);
    expect(commit).not.toHaveBeenCalled();
    expect(s.size()).toBe(0);
  });

  it('flushPendingCommits is safe with no provider mounted', () => {
    expect(() => flushPendingCommits()).not.toThrow();
  });
});
