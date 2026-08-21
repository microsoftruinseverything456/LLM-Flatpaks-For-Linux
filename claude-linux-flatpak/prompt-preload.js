// prompt-preload.js — bridge for the native window.prompt() modal (prompt.html).
const { contextBridge, ipcRenderer } = require('electron');

const params = new URLSearchParams(globalThis.location ? globalThis.location.search : '');

contextBridge.exposeInMainWorld('llPromptAPI', {
  token: params.get('token') || '',
  message: params.get('message') || '',
  def: params.get('def') || '',
  // value === null → cancelled; a string → submitted.
  done(token, value) {
    ipcRenderer.send('ll-prompt-done', { token, value });
  },
});
