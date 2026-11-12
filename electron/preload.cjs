// Preload (sandboxed): exposes a small, typed-by-convention API to the renderer as window.motionNative.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('motionNative', {
  platform: process.platform,
  /** Port of the in-process agent bridge (ws://127.0.0.1:PORT/ws). 0 if it failed to start. */
  bridgePort: () => ipcRenderer.invoke('bridge:port'),
  /** opts: {filters?, multi?} -> {path, name, encoding:'utf8'|'base64', data} | null */
  openFile: (opts) => ipcRenderer.invoke('file:open', opts || {}),
  /** opts: {path?, defaultPath?, data, encoding?, filters?} -> saved path | null */
  saveFile: (opts) => ipcRenderer.invoke('file:save', opts || {}),
  /** Saves an export into ~/Movies/Motion (or ~/Videos/Motion) without a dialog. opts: {name, data(base64)} -> path */
  saveExport: (opts) => ipcRenderer.invoke('file:saveExport', opts || {}),
  /** crash-safe autosave in the app data folder */
  autosaveWrite: (text) => ipcRenderer.invoke('autosave:write', text),
  autosaveRead: () => ipcRenderer.invoke('autosave:read'),
  /** Always shows the dialog. */
  saveFileAs: (opts) => ipcRenderer.invoke('file:saveAs', opts || {}),
  /** cb(action) for 'new'|'open'|'save'|'saveAs'|'import'|'export-lottie'; returns unsubscribe. */
  onMenu: (cb) => {
    const listener = (_e, action) => cb(action);
    ipcRenderer.on('menu', listener);
    return () => ipcRenderer.removeListener('menu', listener);
  },
});
