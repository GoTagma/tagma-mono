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

await command('Runtime.enable');
const state = await evaluate(`({
  title: document.title,
  readyState: document.readyState,
  text: document.body?.innerText?.slice(0, 4000) ?? '',
  html: document.body?.innerHTML?.slice(0, 2000) ?? '',
  localStorage: { ...localStorage },
})`);

console.log(JSON.stringify(state, null, 2));
socket.close();
