// bot-driver.js - gets a bot's decision without ever freezing the page.
//
// decide(task) -> Promise<{ action, rng } | null>, where `task` comes from controller.botTask().
// The decision runs in a Web Worker (bot-worker.js). If workers are unavailable, the worker
// errors, or an answer takes longer than `timeoutMs`, the driver switches for good to a
// synchronous fallback on the main thread (after yielding once so the page can paint).
// A null result means "the bot failed"; the controller's failure cap deals with it.

import { getBot } from '../bots/index.js';

export function createBotDecider({ timeoutMs = 15000, useWorker = true } = {}) {
  let worker = null;
  let mode = 'idle'; // 'idle' | 'worker' | 'sync'
  let nextId = 1;
  const pending = new Map(); // id -> { task, resolve, timer }

  function syncDecide(task) {
    try {
      const rng = { s: task.rng.s };
      const action = getBot(task.level).chooseAction(task.view, rng);
      return { action, rng };
    } catch {
      return null;
    }
  }

  function settle(id, value) {
    const p = pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(id);
    p.resolve(value);
  }

  /** Give up on the worker: answer everything still waiting on the main thread. */
  function fallBack() {
    mode = 'sync';
    if (worker) { try { worker.terminate(); } catch { /* ignore */ } worker = null; }
    for (const [id, p] of [...pending]) settle(id, syncDecide(p.task));
  }

  function start() {
    if (!useWorker || typeof Worker !== 'function') { mode = 'sync'; return; }
    try {
      worker = new Worker(new URL('./bot-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = (e) => {
        const m = e.data || {};
        if (m.error) settle(m.id, null);
        else settle(m.id, { action: m.action, rng: m.rng });
      };
      worker.onerror = () => fallBack();
      worker.onmessageerror = () => fallBack();
      mode = 'worker';
    } catch {
      mode = 'sync';
    }
  }

  return {
    get mode() { return mode; },
    decide(task) {
      if (mode === 'idle') start();
      if (mode === 'sync') return new Promise((resolve) => setTimeout(() => resolve(syncDecide(task)), 0));
      return new Promise((resolve) => {
        const id = nextId++;
        const timer = setTimeout(() => fallBack(), timeoutMs);
        pending.set(id, { task, resolve, timer });
        try {
          worker.postMessage({ id, level: task.level, view: task.view, rng: task.rng });
        } catch {
          fallBack();
        }
      });
    },
    /** Forget every request in flight (a session ended); late answers are ignored. */
    cancelAll() {
      for (const [, p] of pending) clearTimeout(p.timer);
      pending.clear();
    },
  };
}
