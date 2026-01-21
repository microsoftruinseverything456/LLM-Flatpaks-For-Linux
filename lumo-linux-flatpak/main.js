// main.js
const { app, BrowserWindow, shell, clipboard, session, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

let win = null;
let creatingPromise = null;
let networkLockdownInstalled = false;

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

// ---------------- Domain policy ----------------
const ALLOWED_HOSTS = [
  'proton.me'
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

// ---------------- Terminal-only logging helper ----------------
function logIfTerminal(msg) {
  try {
    if (process?.stdout?.isTTY) console.log(msg);
  } catch {}
}

function logBlockedUrl(detailsUrl, why = '') {
  try {
    if (!process?.stdout?.isTTY) return;
    const u = new URL(detailsUrl);
    const reason = why ? ` (${why})` : '';
    console.log(`[blocked] ${u.origin}${u.pathname}${u.search}${reason}`);
  } catch {
    // If URL parsing fails, still log raw
    logIfTerminal(`[blocked] ${String(detailsUrl)}`);
  }
}

// ---------------- Minimal UI: no menus ----------------
function installNoMenuOnce() {
  if (installNoMenuOnce.done) return;
  installNoMenuOnce.done = true;

  // Remove default application menu
  Menu.setApplicationMenu(null);

  // Ensure any created windows have no menu bar
  app.on('browser-window-created', (_e, w) => {
    try {
      w.setMenu(null);
      w.setMenuBarVisibility(false);
      w.setAutoHideMenuBar(true);
    } catch {}
  });
}

// ---------------- Network lockdown (once) ----------------
function installNetworkLockdownOnce() {
  if (networkLockdownInstalled) return;
  networkLockdownInstalled = true;

  const filter = { urls: ['*://*/*'] };

  session.defaultSession.webRequest.onBeforeRequest(filter, (details, cb) => {
    try {
      const u = new URL(details.url);

      // Allow non-http(s) internal schemes (devtools, file, etc.)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return cb({ cancel: false });

      if (!isAllowed(details.url)) {
        logBlockedUrl(details.url, 'domain not allowed');
        return cb({ cancel: true });
      }

      return cb({ cancel: false });
    } catch {
      logBlockedUrl(details.url, 'invalid url');
      return cb({ cancel: true });
    }
  });
}

// ---------------- Keyboard shortcuts (no menu needed) ----------------
let lastFocusAt = 0;
function registerWindowShortcuts(w) {
  // Convoluted fix for ctrl+w transferring from other windows
  if (!w || w.isDestroyed()) return;
  w.on('focus', () => { lastFocusAt = Date.now(); });
  w.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const fw = BrowserWindow.getFocusedWindow();
    if (!fw || fw.id !== w.id) return;
    const key = (input.key || '').toLowerCase();
    const ctrlOrCmd = !!(input.control || input.meta);
    if (ctrlOrCmd && (key === 'w' || key === 'q')) {
      const msSinceFocus = Date.now() - lastFocusAt;
      if (msSinceFocus >= 0 && msSinceFocus < 250) return;
    }

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

// ---------------- Focus helper ----------------
function focusExistingWindow() {
  if (!win || win.isDestroyed()) return false;

  try {
    // If we previously hid it, put it back in the taskbar and show it.
    win.setSkipTaskbar(false);
    if (!win.isVisible()) win.show();
  } catch {}

  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return true;
}

// ---------------- Create window (deduped) ----------------
let hidingToBackground = false;

// ---------------- Create window (deduped) ----------------
async function createWindowOnce() {
  if (focusExistingWindow()) return win;
  if (creatingPromise) return creatingPromise;

  creatingPromise = (async () => {
    installNoMenuOnce();
    installNetworkLockdownOnce();

    try {
      session.defaultSession.setSpellCheckerLanguages(['en-US']);
    } catch {}

    const restoreUrl = readRestoreUrl();
    const startUrl =
      restoreUrl && isAllowed(restoreUrl)
        ? restoreUrl
        : 'https://lumo.proton.me/';

    win = new BrowserWindow({
      width: 1200,
      height: 800,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        spellcheck: true
      },
      icon: path.join(__dirname, 'assets/icons/build/icons/64x64.png')
    });

    // No menu bar
    win.setMenu(null);
    win.setMenuBarVisibility(false);
    win.setAutoHideMenuBar(true);

    // Any real close = hard reset (no restore next launch)
    win.on('close', () => {
      clearRestoreUrl();
    });

    // If we restored, clear marker once load outcome is known
    if (startUrl !== 'https://lumo.proton.me/') {
      win.webContents.once('did-finish-load', clearRestoreUrl);
      win.webContents.once('did-fail-load', clearRestoreUrl);
    }

    // Keyboard shortcuts
    let lastFocusAt = 0;
    win.on('focus', () => {
      lastFocusAt = Date.now();
    });

    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;

      const fw = BrowserWindow.getFocusedWindow();
      if (!fw || fw.id !== win.id) return;

      const key = (input.key || '').toLowerCase();
      const ctrlOrCmd = !!(input.control || input.meta);

      // Prevent cross-window Ctrl+W/Q bleed
      if (ctrlOrCmd && (key === 'w' || key === 'q')) {
        const msSinceFocus = Date.now() - lastFocusAt;
        if (msSinceFocus >= 0 && msSinceFocus < 250) return;
      }

      // Ctrl+Q = quit + reset
      if (ctrlOrCmd && key === 'q') {
        event.preventDefault();
        clearRestoreUrl();
        app.quit();
        return;
      }

      // Ctrl+W = same as Ctrl+Q
      if (ctrlOrCmd && key === 'w') {
        event.preventDefault();
        clearRestoreUrl();
        app.quit();
        return;
      }

      if (ctrlOrCmd && !input.shift && key === 'r') {
        event.preventDefault();
        win.reload();
        return;
      }

      if (ctrlOrCmd && input.shift && key === 'r') {
        event.preventDefault();
        win.webContents.reloadIgnoringCache();
        return;
      }

      if (ctrlOrCmd && input.shift && key === 'i') {
        event.preventDefault();
        win.webContents.toggleDevTools();
        return;
      }

      if (input.key === 'F11') {
        event.preventDefault();
        win.setFullScreen(!win.isFullScreen());
        return;
      }
    });

    win.once('ready-to-show', () => {
      if (!win || win.isDestroyed()) return;
      win.setSkipTaskbar(false);
      win.show();
      win.focus();
    });

    // Context menu (unchanged)
    win.webContents.on('context-menu', (_e, p) => {
      const template = [];

      const misspelled =
        typeof p.misspelledWord === 'string' ? p.misspelledWord : '';
      const suggestions = Array.isArray(p.dictionarySuggestions)
        ? p.dictionarySuggestions
        : [];

      if (misspelled && suggestions.length) {
        suggestions.slice(0, 8).forEach((s) => {
          template.push({
            label: s,
            click: () => {
              try {
                if (win && !win.isDestroyed()) {
                  win.webContents.replaceMisspelling(s);
                }
              } catch {}
            }
          });
        });

        template.push({ type: 'separator' });

        template.push({
          label: 'Add to Dictionary',
          click: () => {
            try {
              session.defaultSession.addWordToSpellCheckerDictionary(
                misspelled
              );
            } catch {}
          }
        });

        template.push({ type: 'separator' });
      }

      template.push(
        { label: 'Cut', role: 'cut', enabled: p.isEditable && p.editFlags.canCut },
        { label: 'Copy', role: 'copy', enabled: !!p.selectionText?.length },
        {
          label: 'Paste',
          role: 'paste',
          enabled: p.isEditable && p.editFlags.canPaste
        },
        { label: 'Select All', role: 'selectAll' }
      );

      if (p.linkURL) {
        template.push(
          { type: 'separator' },
          {
            label: 'Copy Link Address',
            click: () => clipboard.writeText(p.linkURL)
          }
        );
      }

      Menu.buildFromTemplate(template).popup({
        window: win,
        x: p.x,
        y: p.y
      });
    });

    // External navigation handling
    win.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const u = new URL(url);
        if (u.protocol === 'http:' || u.protocol === 'https:') {
          shell.openExternal(url);
        }
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
    });

    return win;
  })();

  try {
    return await creatingPromise;
  } catch (e) {
    creatingPromise = null;
    throw e;
  }
}

// ---------------- Single instance lock ----------------
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', async () => {
    // If focused/visible, interpret as “hide-to-background” gesture.
    if (win && !win.isDestroyed() && win.isVisible() && win.isFocused() && !win.isMinimized()) {
      const url = safeGetCurrentUrl();
      if (url) writeRestoreUrl(url); // optional; keep if you still like crash-safe restore

      try {
        // Make it truly “disappear” (no taskbar entry) while still running.
        win.setSkipTaskbar(true);
        win.hide();
        win.blur();
      } catch {}

      return;
    }

    // Otherwise, focus existing or create.
    await createWindowOnce();
  });

  app.whenReady().then(() => {
    createWindowOnce();
  });

  // macOS dock click should focus or recreate
  app.on('activate', () => {
    createWindowOnce();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
