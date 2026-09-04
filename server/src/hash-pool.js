// Hashes many passwords in parallel across worker threads (bcrypt is CPU-bound: ~80 ms per password
// on one core, so 10,000 employees would otherwise take ~14 minutes).
import os from 'node:os';
import { Worker } from 'node:worker_threads';

const SIZE = Math.max(1, Math.min(4, os.cpus().length - 1));
let workers = null;
let seq = 0;

function pool() {
  if (workers) return workers;
  workers = [];
  for (let i = 0; i < SIZE; i++) {
    const w = new Worker(new URL('./hash-worker.js', import.meta.url));
    w.pending = new Map();
    w.on('message', ({ id, hashes }) => {
      const p = w.pending.get(id);
      if (p) {
        w.pending.delete(id);
        p.resolve(hashes);
      }
      if (w.pending.size === 0) w.unref();
    });
    w.on('error', (err) => {
      for (const p of w.pending.values()) p.reject(err);
      w.pending.clear();
    });
    w.unref(); // never keep the process alive just for idle workers
    workers.push(w);
  }
  return workers;
}

/** Returns the bcrypt hashes for the given passwords, in the same order. */
export async function hashMany(passwords) {
  if (passwords.length === 0) return [];
  const ws = pool();
  const per = Math.ceil(passwords.length / ws.length);
  const parts = [];
  for (let i = 0; i < ws.length; i++) {
    const slice = passwords.slice(i * per, (i + 1) * per);
    if (slice.length === 0) continue;
    const w = ws[i];
    const id = ++seq;
    parts.push(
      new Promise((resolve, reject) => {
        w.pending.set(id, { resolve, reject });
        w.ref(); // keep the process alive while work is in flight
        w.postMessage({ id, passwords: slice });
      })
    );
  }
  return (await Promise.all(parts)).flat();
}
