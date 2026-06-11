// preload.js — isolated world bridge
const { contextBridge, ipcRenderer } = require('electron');

// ---------------- window.prompt() bridge ----------------
// Exposes a SYNCHRONOUS prompt to the page's main world. main.js reassigns
// window.prompt to call this (Electron doesn't implement prompt() itself).
//
// run() opens a native modal in the main process, then blocks this renderer by
// polling until the user answers. Only this renderer blocks — the main process
// stays free so the modal renders and accepts input. A short spin between polls
// keeps us from flooding the main process with IPC; it ends as soon as the user
// responds (or after a safety cap).
contextBridge.exposeInMainWorld('__llPrompt', {
  run(message, def) {
    let token;
    try {
      token = ipcRenderer.sendSync('ll-prompt-open', { message, def });
    } catch {
      return null;
    }
    if (!token) return null;

    const deadline = Date.now() + 10 * 60 * 1000; // matches main.js safety net
    for (;;) {
      let res;
      try {
        res = ipcRenderer.sendSync('ll-prompt-poll', token);
      } catch {
        return null;
      }
      if (res && res.done) return res.value == null ? null : String(res.value);
      if (Date.now() > deadline) return null;
      const until = Date.now() + 40;
      while (Date.now() < until) { /* brief synchronous wait */ }
    }
  },
});
