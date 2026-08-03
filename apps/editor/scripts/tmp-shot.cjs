/* Temporary visual-review harness: opens the editor in a hidden Electron
   window, captures screenshots, saves PNGs to apps/editor/tmp-shots/. */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const BASE = process.env.SHOT_URL || 'http://127.0.0.1:3199';
const OUT = path.join(__dirname, '..', 'tmp-shots');
const WIDTH = parseInt(process.env.SHOT_W || '1600', 10);
const HEIGHT = parseInt(process.env.SHOT_H || '1000', 10);

// Each step: [name, waitMs, jsToRunBeforeCapture]
const STEPS = JSON.parse(process.env.SHOT_STEPS || '[["landing", 6000, ""]]');

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  await app.whenReady();
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    webPreferences: { offscreen: true },
  });
  win.webContents.on('console-message', (_e, _l, msg) => {
    if (/error|warn/i.test(msg)) console.log('[renderer]', msg.slice(0, 300));
  });
  await win.loadURL(BASE);
  for (const [name, waitMs, js] of STEPS) {
    if (js) {
      try {
        await win.webContents.executeJavaScript(js);
      } catch (err) {
        console.log('[js-error]', name, String(err).slice(0, 200));
      }
    }
    await new Promise((r) => setTimeout(r, waitMs));
    const img = await win.webContents.capturePage();
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, img.toPNG());
    console.log('[shot]', file);
  }
  app.exit(0);
}

main().catch((err) => {
  console.error(err);
  app.exit(1);
});
