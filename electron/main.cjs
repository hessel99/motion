// Electron main process for Motion.
//   electron . --dev   -> loads the vite dev server at http://localhost:5173
//   electron .         -> loads dist/index.html
// Starts the agent bridge (bridge/server.mjs) in-process and exposes its port to the renderer.
const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');

const isDev = process.argv.includes('--dev');
const DEV_URL = process.env.MOTION_DEV_URL || 'http://localhost:5173';

// Smooth rendering: GPU raster + zero-copy uploads. Vsync stays on.
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-zero-copy');

/** @type {BrowserWindow | null} */
let win = null;
let bridge = null;
let bridgeReady = null;

function startBridge() {
  if (bridgeReady) return bridgeReady;
  bridgeReady = (async () => {
    const mod = await import(pathToFileURL(path.join(__dirname, '..', 'bridge', 'server.mjs')).href);
    const preferred = Number(process.env.MOTION_BRIDGE_PORT || 7823);
    try {
      bridge = await mod.startBridge({ port: preferred });
    } catch (e) {
      if (e && e.code === 'EADDRINUSE') bridge = await mod.startBridge({ port: 0 }); // another instance owns 7823
      else throw e;
    }
    return bridge.port;
  })().catch((e) => {
    console.error('[motion] bridge failed to start:', e);
    return 0;
  });
  return bridgeReady;
}

const TEXT_EXT = new Set(['.json', '.svg', '.txt', '.csv', '.lottie.json']);

const OPEN_FILTERS = [
  { name: 'All supported', extensions: ['motion', 'aep', 'json', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp'] },
  { name: 'Motion project', extensions: ['motion'] },
  { name: 'After Effects project', extensions: ['aep'] },
  { name: 'Lottie', extensions: ['json'] },
  { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
  { name: 'SVG', extensions: ['svg'] },
  { name: 'All files', extensions: ['*'] },
];

async function readForRenderer(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const buf = await fs.readFile(filePath);
  const isText = TEXT_EXT.has(ext);
  return {
    path: filePath,
    name: path.basename(filePath),
    encoding: isText ? 'utf8' : 'base64',
    data: isText ? buf.toString('utf8') : buf.toString('base64'),
  };
}

async function writeFromRenderer(filePath, data, encoding) {
  const buf = encoding === 'base64' ? Buffer.from(String(data), 'base64') : Buffer.from(String(data ?? ''), 'utf8');
  await fs.writeFile(filePath, buf);
  return filePath;
}

async function saveDialog(opts) {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: opts.defaultPath,
    filters: opts.filters || [{ name: 'Motion project', extensions: ['motion'] }],
  });
  return r.canceled || !r.filePath ? null : r.filePath;
}

ipcMain.handle('bridge:port', () => startBridge());

// opts: {filters?, multi?} -> {path, name, encoding:'utf8'|'base64', data} | array when multi | null if cancelled
ipcMain.handle('file:open', async (_e, opts = {}) => {
  const r = await dialog.showOpenDialog(win, {
    properties: opts.multi ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: opts.filters || OPEN_FILTERS,
  });
  if (r.canceled || !r.filePaths.length) return null;
  if (opts.multi) return Promise.all(r.filePaths.map(readForRenderer));
  return readForRenderer(r.filePaths[0]);
});

// opts: {path?, defaultPath?, data, encoding?:'utf8'|'base64', filters?} -> saved path | null
// Writes straight to opts.path when given (plain "Save"), otherwise asks.
ipcMain.handle('file:save', async (_e, opts = {}) => {
  const target = opts.path || (await saveDialog(opts));
  if (!target) return null;
  return writeFromRenderer(target, opts.data, opts.encoding);
});

ipcMain.handle('file:saveAs', async (_e, opts = {}) => {
  const target = await saveDialog(opts);
  if (!target) return null;
  return writeFromRenderer(target, opts.data, opts.encoding);
});

// crash-safe autosave of the open project (no size limit, unlike browser storage)
const autosavePath = () => path.join(app.getPath('userData'), 'autosave.motion');
let autosaveChain = Promise.resolve(true);
let autosaveSeq = 0;
ipcMain.handle('autosave:write', (_e, text) => {
  if (typeof text !== 'string' || text.length > 512 * 1024 * 1024) return false;
  // serialize writes; unique tmp name per write; atomic rename never leaves a half written file
  autosaveChain = autosaveChain.catch(() => false).then(async () => {
    const tmp = `${autosavePath()}.${process.pid}.${++autosaveSeq}.tmp`;
    await fs.writeFile(tmp, text, 'utf8');
    await fs.rename(tmp, autosavePath());
    return true;
  });
  return autosaveChain.catch(() => false);
});
ipcMain.handle('autosave:read', async () => {
  try { return await fs.readFile(autosavePath(), 'utf8'); } catch { return null; }
});

// exports requested by tools/agents go to a fixed folder (no arbitrary paths): ~/Movies/Motion (mac) or ~/Videos/Motion
ipcMain.handle('file:saveExport', async (_e, opts = {}) => {
  const base = app.getPath('videos');
  const dir = path.join(base, 'Motion');
  await fs.mkdir(dir, { recursive: true });
  const safe = String(opts.name || 'export').replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'export';
  let target = path.join(dir, safe);
  // never overwrite: add a counter
  for (let i = 1; require('node:fs').existsSync(target) && i < 1000; i++) target = path.join(dir, safe.replace(/(\.[^.]+)?$/, ` (${i})$1`));
  return writeFromRenderer(target, opts.data, opts.encoding || 'base64');
});

function sendMenu(action) {
  if (win && !win.isDestroyed()) win.webContents.send('menu', action);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New', accelerator: 'CmdOrCtrl+N', click: () => sendMenu('new') },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => sendMenu('open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => sendMenu('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendMenu('saveAs') },
        { type: 'separator' },
        { label: 'Import…', accelerator: 'CmdOrCtrl+I', click: () => sendMenu('import') },
        { label: 'Export Lottie…', accelerator: 'CmdOrCtrl+E', click: () => sendMenu('export-lottie') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      // Note: undo/redo are left to the renderer (its own history), only clipboard roles here.
      submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'delete' }, { role: 'selectAll' }],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: '#1a1a1c',
    show: false,
    title: 'Motion',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.once('ready-to-show', () => win && win.show());
  // the renderer blocks unload while there are unsaved changes: ask natively
  win.webContents.on('will-prevent-unload', (e) => {
    if (process.env.MOTION_TEST) { e.preventDefault(); return; } // automated tests: never block on a dialog
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question', buttons: ['Close without saving', 'Cancel'], defaultId: 1, cancelId: 1,
      message: 'You have unsaved changes', detail: 'An autosave copy is kept and restored next time, but the project file itself is not saved.',
    });
    if (choice === 0) e.preventDefault(); // ignore beforeunload and close
  });
  win.on('closed', () => { win = null; });

  // External links open in the system browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) win.loadURL(DEV_URL);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

app.whenReady().then(() => {
  startBridge();
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  if (bridge) bridge.close().catch(() => {});
});
