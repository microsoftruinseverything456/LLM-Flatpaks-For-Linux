// downloadbar-preload.js — bridge for the local download status bar
// (downloadbar.html). The bar is a WebContentsView pinned to the bottom of the
// main window (like the tab strip); main.js owns the download list and pushes
// state here, and the bar sends back dismiss/open commands. Mirrors
// tabbar-preload.js.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('llDL', {
  dismiss: (id) => ipcRenderer.send('ll-dl-dismiss', id),
  open: (id) => ipcRenderer.send('ll-dl-open', id),
  onState: (cb) => {
    ipcRenderer.on('ll-dl-state', (_event, state) => cb(state));
    // Ask main for the current list once the listener exists (covers the race
    // where a download starts before this page finishes loading).
    ipcRenderer.send('ll-dl-ready');
  },
});
