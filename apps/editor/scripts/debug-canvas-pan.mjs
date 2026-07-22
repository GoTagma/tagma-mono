const targets = await fetch('http://127.0.0.1:9222/json').then((response) => response.json());
const page = targets.find(
  (target) => target.type === 'page' && target.url.startsWith('http://127.0.0.1:5173'),
);

if (!page) throw new Error('Tagma page target not found');

const socket = new WebSocket(page.webSocketDebuggerUrl);
const pending = new Map();
let nextId = 1;

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (!message.id) return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

function command(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await command('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'Evaluation failed');
  }
  return result.result.value;
}

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function clickText(text) {
  return evaluate(`(() => {
    const wanted = ${JSON.stringify(text)}.toLowerCase();
    const candidates = [...document.querySelectorAll('button, [role="button"]')];
    const target = candidates.find((element) =>
      (element.textContent ?? '').trim().toLowerCase().includes(wanted),
    );
    if (!target) return null;
    target.click();
    return {
      tag: target.tagName,
      text: (target.textContent ?? '').trim().slice(0, 200),
    };
  })()`);
}

async function report() {
  return evaluate(`(() => {
    const surfaces = [...document.querySelectorAll('[data-canvas-pan-surface]')];
    return {
      title: document.title,
      readyState: document.readyState,
      text: document.body?.innerText?.slice(0, 6000) ?? '',
      errorOverlay: Boolean(document.querySelector('vite-error-overlay')),
      surfaces: surfaces.map((surface) => {
        const rect = surface.getBoundingClientRect();
        return {
          rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
          scrollLeft: surface.scrollLeft,
          scrollTop: surface.scrollTop,
          scrollWidth: surface.scrollWidth,
          scrollHeight: surface.scrollHeight,
          clientWidth: surface.clientWidth,
          clientHeight: surface.clientHeight,
        };
      }),
    };
  })()`);
}

async function dragSurface() {
  const point = await evaluate(`(() => {
    const surface = document.querySelector('[data-canvas-pan-surface]');
    if (!surface) return null;
    surface.scrollLeft = 0;
    surface.scrollTop = 0;
    const rect = surface.getBoundingClientRect();
    const blocked = '[data-task-id], [data-track-resize-edge], button, input, textarea, select';
    for (const yFraction of [0.85, 0.7, 0.55, 0.4]) {
      for (const xFraction of [0.15, 0.3, 0.45, 0.6, 0.75]) {
        const x = rect.left + rect.width * xFraction;
        const y = rect.top + rect.height * yFraction;
        const hit = document.elementFromPoint(x, y);
        if (
          hit &&
          hit.closest('[data-canvas-pan-surface]') === surface &&
          !hit.closest(blocked)
        ) {
          return {
            x,
            y,
            hit: hit.tagName + '.' + [...hit.classList].join('.'),
            before: {
              left: surface.scrollLeft,
              top: surface.scrollTop,
              maxLeft: surface.scrollWidth - surface.clientWidth,
              maxTop: surface.scrollHeight - surface.clientHeight,
            },
          };
        }
      }
    }
    return { error: 'No unblocked visible point belongs to the pan surface' };
  })()`);

  if (!point || point.error) return point;

  await command('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: point.x,
    y: point.y,
  });
  await command('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  for (let step = 1; step <= 5; step++) {
    await command('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x - 16 * step,
      y: point.y - 8 * step,
      button: 'left',
      buttons: 1,
    });
  }
  await command('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x - 80,
    y: point.y - 40,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });
  await pause(100);

  const after = await evaluate(`(() => {
    const surface = document.querySelector('[data-canvas-pan-surface]');
    return surface
      ? {
          left: surface.scrollLeft,
          top: surface.scrollTop,
          maxLeft: surface.scrollWidth - surface.clientWidth,
          maxTop: surface.scrollHeight - surface.clientHeight,
        }
      : null;
  })()`);

  return { ...point, after };
}

await command('Runtime.enable');
const action = process.argv[2] ?? 'status';
let result;

if (action === 'click') {
  result = { clicked: await clickText(process.argv.slice(3).join(' ')) };
  await pause(1200);
  result.report = await report();
} else if (action === 'open-workspace') {
  result = { clicked: await clickText('TagmaMono') };
  await pause(1800);
  result.report = await report();
} else if (action === 'reload') {
  await command('Page.reload', { ignoreCache: true });
  await pause(1800);
  result = await report();
} else if (action === 'drag') {
  result = await dragSurface();
} else {
  result = await report();
}

console.log(JSON.stringify(result, null, 2));
socket.close();
