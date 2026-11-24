// Keeps the submission API up, like the official example's serve/run_api.sh.
// rc-tunnel revokes the public URL after about a minute without answers, so an
// exited server is restarted after a short delay (2 s by default).
// The server runs in this process group: stopping the group stops both.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function supervise({ script, delayMs = 2000, stopTimeoutMs = 15000, log = line => process.stderr.write(line + '\n'),
  spawnChild = () => spawn(process.execPath, [script], { stdio: 'inherit' }) }) {
  let child, timer, stopping = false, starts = 0;
  const start = () => {
    if (stopping) return;
    starts += 1;
    log(`${new Date().toISOString()} api-supervisor: starting server (start ${starts})`);
    const current = spawnChild();
    child = current;
    let ended = false;
    const onEnd = reason => {
      if (ended) return; ended = true;
      if (child === current) child = undefined;
      if (stopping) return;
      log(`${new Date().toISOString()} api-supervisor: server ${reason}; restarting in ${delayMs} ms`);
      timer = setTimeout(start, delayMs);
    };
    current.once('error', error => onEnd('failed to start: ' + error.message));
    current.once('exit', (code, signal) => onEnd(`exited (code ${code}, signal ${signal})`));
  };
  start();
  return {
    get starts() { return starts; },
    stop() {
      stopping = true; clearTimeout(timer);
      const current = child;
      if (!current || current.exitCode !== null || current.signalCode !== null) return Promise.resolve();
      return new Promise(resolve => {
        const force = setTimeout(() => { try { current.kill('SIGKILL'); } catch {} }, stopTimeoutMs);
        current.once('exit', () => { clearTimeout(force); resolve(); });
        try { current.kill('SIGTERM'); } catch { clearTimeout(force); resolve(); }
      });
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const script = process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs');
  const delayMs = Number(process.env.API_RESTART_DELAY_MS || 2000);
  const supervisor = supervise({ script, delayMs: Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : 2000 });
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await supervisor.stop(); process.exit(0); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
