// Preload (sandboxed): exposes a small, typed-by-convention API to the renderer as window.motionNative.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('motionNative', {
  platform: process.platform,
  /** Port of the in-process agent bridge (ws://127.0.0.1:PORT/ws). 0 if it failed to start. */
  bridgePort: () => ipcRenderer.invoke('bridge:port'),
  /** secret the bridge requires from the app's file:// origin */
  bridgeToken: () => ipcRenderer.invoke('bridge:token'),
  /** opts: {filters?, multi?} -> {path, name, encoding:'utf8'|'base64', data} | null */
  openFile: (opts) => ipcRenderer.invoke('file:open', opts || {}),
  /** opts: {path?, defaultPath?, data, encoding?, filters?} -> saved path | null */
  saveFile: (opts) => ipcRenderer.invoke('file:save', opts || {}),
  /** Saves an export into ~/Movies/Motion (or ~/Videos/Motion) without a dialog. opts: {name, data(base64)} -> path */
  saveExport: (opts) => ipcRenderer.invoke('file:saveExport', opts || {}),
  /** crash-safe autosave in the app data folder */
  autosaveWrite: (text) => ipcRenderer.invoke('autosave:write', text),
  autosaveRead: () => ipcRenderer.invoke('autosave:read'),
  /** figma paste capture folder (MOTION_FIGMA_CAPTURE_DIR) or null; write a capture file into it */
  figmaCaptureDir: () => ipcRenderer.invoke('figma:captureDir'),
  figmaCaptureWrite: (name, text) => ipcRenderer.invoke('figma:captureWrite', name, text),
  /** Always shows the dialog. */
  saveFileAs: (opts) => ipcRenderer.invoke('file:saveAs', opts || {}),
  /** design tokens: read a .json file again / watch it (cb(path, text) on every save) */
  readTextFile: (p) => ipcRenderer.invoke('file:readText', p),
  watchFile: (p) => ipcRenderer.invoke('file:watch', p),
  onFileChanged: (cb) => {
    const listener = (_e, p, data) => cb(p, data);
    ipcRenderer.on('file:changed', listener);
    return () => ipcRenderer.removeListener('file:changed', listener);
  },
  /** app updates (electron/updates/index.cjs, docs/updates.md) */
  updates: {
    /** the renderer started fine: keeps a freshly installed interface (otherwise it is rolled back) */
    appReady: () => ipcRenderer.send('updates:app-ready'),
    state: () => ipcRenderer.invoke('updates:state'),
    check: () => ipcRenderer.invoke('updates:check'),
    /** {channel?: 'stable'|'beta', auto?: boolean} */
    setPrefs: (p) => ipcRenderer.invoke('updates:prefs', p || {}),
    /** tell the updater not to check/install now (e.g. while exporting) */
    setBusy: (reason, on) => ipcRenderer.invoke('updates:busy', reason, !!on),
    restart: () => ipcRenderer.invoke('updates:restart'),
    revertUi: () => ipcRenderer.invoke('updates:revert-ui'),
    onState: (cb) => {
      const listener = (_e, s) => cb(s);
      ipcRenderer.on('updates:state', listener);
      return () => ipcRenderer.removeListener('updates:state', listener);
    },
  },
  /** cb(action) for 'new'|'open'|'save'|'saveAs'|'import'|'export-lottie'; returns unsubscribe. */
  onMenu: (cb) => {
    const listener = (_e, action) => cb(action);
    ipcRenderer.on('menu', listener);
    return () => ipcRenderer.removeListener('menu', listener);
  },
});
