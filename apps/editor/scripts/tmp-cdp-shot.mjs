// Temporary visual-review harness: drives headless Chrome over CDP (Bun-only,
// no deps), waits for the SPA to become ready, runs scripted steps and saves
// PNGs to apps/editor/tmp-shots/. Delete together with tmp-shots/.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHROME =
  process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = parseInt(process.env.CDP_PORT || '9223', 10);
const BASE = process.env.SHOT_URL || 'http://127.0.0.1:3199/';
const OUT = path.resolve(process.env.SHOT_OUT || 'tmp-shots');
const W = parseInt(process.env.SHOT_W || '1600', 10);
const H = parseInt(process.env.SHOT_H || '1000', 10);
// Each step: [name, waitMsBeforeCapture, jsToRunFirst]
const STEPS = JSON.parse(process.env.SHOT_STEPS || '[["landing", 1000, ""]]');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitDevtools() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error('chrome devtools endpoint never came up');
}

let msgId = 0;
const pending = new Map();
let ws;
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }
    }, 30000);
  });
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true });
  if (r?.exceptionDetails) {
    console.log('[js-error]', JSON.stringify(r.exceptionDetails).slice(0, 300));
  }
  return r?.result?.value;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const profile = path.join(OUT, 'cdp-profile');
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-features=Translate',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      `--window-size=${W},${H}`,
      '--hide-scrollbars',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const cleanup = () => {
    try {
      chrome.kill('SIGKILL');
    } catch {}
  };
  process.on('exit', cleanup);

  try {
    await waitDevtools();
    const target = await fetch(
      `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(BASE)}`,
      { method: 'PUT' },
    ).then((r) => r.json());
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = rej;
    });
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id).resolve(m.result ?? m.error);
        pending.delete(m.id);
      }
    };
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: W,
      height: H,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // Wait until the SPA has real chrome rendered (more than a loading label).
    const readyExpr = `document.querySelectorAll('button').length > 5 && !/Loading \\.\\./.test(document.body.innerText || '')`;
    let ready = false;
    for (let i = 0; i < 90; i++) {
      if ((await evaluate(readyExpr)) === true) {
        ready = true;
        break;
      }
      await sleep(500);
    }
    console.log('[ready]', ready);

    for (const [name, waitMs, js] of STEPS) {
      if (js) await evaluate(js);
      await sleep(waitMs);
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(OUT, `${name}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      console.log('[shot]', file);
    }
  } finally {
    cleanup();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
