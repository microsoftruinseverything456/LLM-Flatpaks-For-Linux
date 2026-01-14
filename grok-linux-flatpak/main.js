const { app, BrowserWindow, shell, clipboard, session, Notification, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

let win = null;

// Strong “don’t open multiple windows” guards
let creatingPromise = null;          // in-flight creation promise (dedupes rapid calls)
let isWindowCreationStarted = false; // belt + suspenders
let networkLockdownInstalled = false;

// Rerun / exit-gate state
let isRelaunching = false;
const RELAUNCH_GRACE_MS = 6000;

// ---------------- Restore-on-rerun state ----------------
function stateFilePath() {
  return path.join(app.getPath('userData'), 'restore-state.json');
}

function writeRestoreUrl(url) {
  try {
    fs.writeFileSync(stateFilePath(), JSON.stringify({ restoreUrl: url, ts: Date.now() }), 'utf8');
  } catch {}
}

function readRestoreUrl() {
  try {
    const raw = fs.readFileSync(stateFilePath(), 'utf8');
    const data = JSON.parse(raw);
    return typeof data?.restoreUrl === 'string' ? data.restoreUrl : null;
  } catch {
    return null;
  }
}

function clearRestoreUrl() {
  try {
    fs.unlinkSync(stateFilePath());
  } catch {}
}

// ---------------- Exit gate token (one-shot) ----------------
function relaunchTokenFilePath() {
  return path.join(app.getPath('userData'), 'relaunch-token.json');
}

function writeRelaunchToken(data) {
  try {
    const payload =
      typeof data === 'string'
        ? { token: data, ts: Date.now(), allowedLaunches: 0 }
        : { token: data.token, ts: Date.now(), allowedLaunches: data.allowedLaunches ?? 0 };

    fs.writeFileSync(relaunchTokenFilePath(), JSON.stringify(payload), 'utf8');
  } catch {}
}

function readRelaunchToken() {
  try {
    const raw = fs.readFileSync(relaunchTokenFilePath(), 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data.token !== 'string' || typeof data.ts !== 'number') return null;
    return data;
  } catch {
    return null;
  }
}

function clearRelaunchToken() {
  try {
    fs.unlinkSync(relaunchTokenFilePath());
  } catch {}
}

function consumeOneAllowedLaunchIfPresent() {
  const info = readRelaunchToken();
  if (!info) return false;

  const age = Date.now() - info.ts;
  if (age > RELAUNCH_GRACE_MS) {
    clearRelaunchToken();
    return false;
  }

  if ((info.allowedLaunches ?? 0) <= 0) return false;

  try {
    fs.writeFileSync(
      relaunchTokenFilePath(),
      JSON.stringify({ ...info, allowedLaunches: (info.allowedLaunches ?? 0) - 1 }),
      'utf8'
    );
  } catch {}

  return true;
}

// Gate rule:
// - If token is fresh AND allowedLaunches > 0: allow exactly one launch through (consume it)
// - Otherwise, if token is fresh: block launch (prevents multi-window spam during shutdown)
// - If token stale: clear it and allow
function shouldBlockThisLaunchDueToExitGate() {
  const info = readRelaunchToken();
  if (!info) return false;

  const age = Date.now() - info.ts;
  if (age > RELAUNCH_GRACE_MS) {
    clearRelaunchToken();
    return false;
  }

  if ((info.allowedLaunches ?? 0) > 0) {
    consumeOneAllowedLaunchIfPresent();
    return false;
  }

  return true;
}

// ---------------- Domain policy ----------------
const ALLOWED_HOSTS = [
  'grok.com',
  'x.ai',
  'cloudflare.com',
  'xai.com',
  'cloudflareinsights.com',
  'grokipedia.com',
  'grokusercontent.com'
];

function isAllowed(urlString) {
  try {
    const u = new URL(urlString);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return ALLOWED_HOSTS.some(a => host === a || host.endsWith(`.${a}`));
  } catch {
    return false;
  }
}

function shouldOpenExternally(targetUrl) {
  try {
    const u = new URL(targetUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return !isAllowed(targetUrl);
  } catch {
    return false;
  }
}

function safeGetCurrentUrl() {
  try {
    if (!win || win.isDestroyed()) return null;
    const url = win.webContents.getURL();
    if (!url || !isAllowed(url)) return null;
    return url;
  } catch {
    return null;
  }
}

// ---------------- Focus / bring-forward helpers ----------------
function focusExistingWindow() {
  if (!win || win.isDestroyed()) return false;

  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();

  return true;
}

function notifyBringForward() {
  if (!Notification.isSupported() || !win || win.isDestroyed()) return;

  const n = new Notification({
    title: 'Grok',
    body: 'Already running — click to bring it forward'
  });

  n.on('click', () => focusExistingWindow());
  n.show();
}

// ---------------- Remove menus (keyboard shortcuts only) ----------------
function installNoMenuOnce() {
  if (installNoMenuOnce.done) return;
  installNoMenuOnce.done = true;

  Menu.setApplicationMenu(null);

  app.on('browser-window-created', (_e, w) => {
    try {
      w.setMenu(null);
      w.setMenuBarVisibility(false);
      w.setAutoHideMenuBar(true);
    } catch {}
  });
}

// ---------------- Network lockdown (install once per app lifetime) ----------------
function installNetworkLockdownOnce() {
  if (networkLockdownInstalled) return;
  networkLockdownInstalled = true;

  const filter = { urls: ['*://*/*'] };

  session.defaultSession.webRequest.onBeforeRequest(filter, (details, cb) => {
    try {
      const u = new URL(details.url);

      if (u.protocol !== 'http:' && u.protocol !== 'https:') return cb({ cancel: false });

      if (!isAllowed(details.url)) {
        console.log('[BLOCKED]', details.url);
        return cb({ cancel: true });
      }

      return cb({ cancel: false });
    } catch {
      return cb({ cancel: true });
    }
  });
}

// ---------------- Window-scoped keyboard shortcuts (no app menu needed) ----------------
function registerWindowShortcuts(w) {
  if (!w || w.isDestroyed()) return;

  w.webContents.on('before-input-event', (event, input) => {
    const key = (input.key || '').toLowerCase();
    const ctrlOrCmd = !!(input.control || input.meta);

    if (ctrlOrCmd && key === 'q') {
      event.preventDefault();
      app.quit();
      return;
    }

    if (ctrlOrCmd && key === 'w') {
      event.preventDefault();
      w.close();
      return;
    }

    if (ctrlOrCmd && !input.shift && key === 'r') {
      event.preventDefault();
      w.reload();
      return;
    }

    if (ctrlOrCmd && input.shift && key === 'r') {
      event.preventDefault();
      w.webContents.reloadIgnoringCache();
      return;
    }

    if (ctrlOrCmd && input.shift && key === 'i') {
      event.preventDefault();
      w.webContents.toggleDevTools();
      return;
    }

    if (input.key === 'F11') {
      event.preventDefault();
      w.setFullScreen(!w.isFullScreen());
      return;
    }
  });
}

// Focused relaunch gesture: save URL + quit (no reopen)
// Gate allows exactly one subsequent launch through (and blocks spam).
function saveUrlAndExitWithGate() {
  if (isRelaunching) return;
  isRelaunching = true;

  const url = safeGetCurrentUrl();
  if (url) writeRestoreUrl(url);

  writeRelaunchToken({
    token: crypto.randomBytes(16).toString('hex'),
    allowedLaunches: 1
  });

  // Short delay so the just-launched process fails to take over as primary.
  setTimeout(() => app.exit(0), 600);
}

// ---------------- Create (exactly one) window, safely ----------------
async function createWindowOnce() {
  if (focusExistingWindow()) return win;
  if (creatingPromise) return creatingPromise;
  if (isWindowCreationStarted) return creatingPromise;

  isWindowCreationStarted = true;

  creatingPromise = (async () => {
    installNoMenuOnce();
    installNetworkLockdownOnce();

    const restoreUrl = readRestoreUrl();
    const startUrl = restoreUrl && isAllowed(restoreUrl) ? restoreUrl : 'https://grok.com/';

    win = new BrowserWindow({
      width: 1200,
      height: 800,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true
      },
      icon: path.join(__dirname, 'assets/icons/build/icons/64x64.png')
    });

    win.setMenu(null);
    win.setMenuBarVisibility(false);
    win.setAutoHideMenuBar(true);

    if (startUrl !== 'https://grok.com/') {
      win.webContents.once('did-finish-load', clearRestoreUrl);
      win.webContents.once('did-fail-load', clearRestoreUrl);
    }

    registerWindowShortcuts(win);

    win.once('ready-to-show', () => {
      if (!win || win.isDestroyed()) return;

      // Once UI is up, end any lingering gate.
      clearRelaunchToken();

      win.show();
      win.focus();
    });

    win.webContents.on('context-menu', (_e, p) => {
      const template = [
        { label: 'Cut', role: 'cut', enabled: p.isEditable && p.editFlags.canCut },
        { label: 'Copy', role: 'copy', enabled: !!p.selectionText?.length },
        { label: 'Paste', role: 'paste', enabled: p.isEditable && p.editFlags.canPaste },
        { label: 'Select All', role: 'selectAll' }
      ];

      if (p.linkURL) {
        template.push(
          { type: 'separator' },
          { label: 'Copy Link Address', click: () => clipboard.writeText(p.linkURL) }
        );
      }

      Menu.buildFromTemplate(template).popup({ window: win, x: p.x, y: p.y });
    });

    win.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const u = new URL(url);
        if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(url);
      } catch {}
      return { action: 'deny' };
    });

    win.webContents.on('will-navigate', (e, url) => {
      if (shouldOpenExternally(url)) {
        e.preventDefault();
        shell.openExternal(url);
      }
    });

    win.webContents.on('will-redirect', (e, url) => {
      if (shouldOpenExternally(url)) {
        e.preventDefault();
        shell.openExternal(url);
      }
    });

    await win.loadURL(startUrl);

    win.on('closed', () => {
      win = null;
      creatingPromise = null;
      isWindowCreationStarted = false;
    });

    return win;
  })();

  try {
    return await creatingPromise;
  } catch (err) {
    creatingPromise = null;
    isWindowCreationStarted = false;
    throw err;
  }
}

// ---------------- Startup gate (one-shot) ----------------
if (shouldBlockThisLaunchDueToExitGate()) {
  app.exit(0);
}

// ---------------- Single instance lock ----------------
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', async () => {
    // If focused/visible, interpret as rerun gesture: save URL + quit (no reopen)
    if (win && !win.isDestroyed() && win.isVisible() && win.isFocused() && !win.isMinimized()) {
      saveUrlAndExitWithGate();
      return;
    }

    await createWindowOnce();
    notifyBringForward();
  });

  app.whenReady().then(() => {
    createWindowOnce();
  });

  app.on('activate', () => {
    createWindowOnce();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
