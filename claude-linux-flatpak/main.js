// main.js
const { app, BrowserWindow, shell, clipboard, session, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

let win = null;
let creatingPromise = null;
let networkLockdownInstalled = false;
let quittingFromGesture = false;

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
  'claude.ai',
  'anthropic.com',
  'cloudflare.com',
  'claudeusercontent.com',
  'cloudflareinsights.com'
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

// ---------------- Focus helper ----------------
function focusExistingWindow() {
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return true;
}

// ---------------- Create window (deduped) ----------------
async function createWindowOnce() {
  if (focusExistingWindow()) return win;
  if (creatingPromise) return creatingPromise;

  creatingPromise = (async () => {
    installNoMenuOnce();
    installNetworkLockdownOnce();

    // Optional: pick a language list (or omit to use OS defaults)
    try {
      session.defaultSession.setSpellCheckerLanguages(['en-US']);
    } catch {}

    const restoreUrl = readRestoreUrl();
    const startUrl = restoreUrl && isAllowed(restoreUrl) ? restoreUrl : 'https://claude.ai/';

    win = new BrowserWindow({
      width: 1200,
      height: 800,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        // enable spellchecker so misspelling suggestions appear in context-menu params
        spellcheck: true
      },
      icon: path.join(__dirname, 'assets/icons/build/icons/64x64.png')
    });

    // Ensure no menu bar
    win.setMenu(null);
    win.setMenuBarVisibility(false);
    win.setAutoHideMenuBar(true);

    // Clear restore file after first definitive load outcome
    if (startUrl !== 'https://claude.ai/') {
      win.webContents.once('did-finish-load', clearRestoreUrl);
      win.webContents.once('did-fail-load', clearRestoreUrl);
    }

    registerWindowShortcuts(win);

    win.once('ready-to-show', () => {
      if (!win || win.isDestroyed()) return;
      win.show();
      win.focus();
    });

    // Context menu:
    // - spell corrections when right-clicking a misspelled word
    // - minimal edit actions
    win.webContents.on('context-menu', (_e, p) => {
      const template = [];

      // --- Spellcheck suggestions (when right-clicking a misspelled word) ---
      // Electron provides `misspelledWord` and `dictionarySuggestions` in `p`
      const misspelled = typeof p.misspelledWord === 'string' ? p.misspelledWord : '';
      const suggestions = Array.isArray(p.dictionarySuggestions) ? p.dictionarySuggestions : [];

      if (misspelled && suggestions.length) {
        // add up to 8 suggestions to keep it tidy
        suggestions.slice(0, 8).forEach((s) => {
          template.push({
            label: s,
            click: () => {
              try {
                if (win && !win.isDestroyed()) win.webContents.replaceMisspelling(s);
              } catch {}
            }
          });
        });

        template.push({ type: 'separator' });

        template.push({
          label: 'Add to Dictionary',
          click: () => {
            try {
              session.defaultSession.addWordToSpellCheckerDictionary(misspelled);
            } catch {}
          }
        });

        template.push({ type: 'separator' });
      }

      // --- Minimal edit menu ---
      template.push(
        { label: 'Cut', role: 'cut', enabled: p.isEditable && p.editFlags.canCut },
        { label: 'Copy', role: 'copy', enabled: !!p.selectionText?.length },
        { label: 'Paste', role: 'paste', enabled: p.isEditable && p.editFlags.canPaste },
        { label: 'Select All', role: 'selectAll' }
      );

      if (p.linkURL) {
        template.push(
          { type: 'separator' },
          { label: 'Copy Link Address', click: () => clipboard.writeText(p.linkURL) }
        );
      }

      Menu.buildFromTemplate(template).popup({ window: win, x: p.x, y: p.y });
    });

    // Never open new windows inside Electron; send them to system browser.
    win.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const u = new URL(url);
        if (u.protocol === 'http:' || u.protocol === 'https:') shell.openExternal(url);
      } catch {}
      return { action: 'deny' };
    });

    // Keep in-app navigation only to allowed domains.
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
    // If we’re already in the middle of quitting from the gesture,
    // do nothing (keeps behavior stable).
    if (quittingFromGesture) return;

    // If focused/visible, interpret as rerun gesture: save URL + quit.
    if (win && !win.isDestroyed() && win.isVisible() && win.isFocused() && !win.isMinimized()) {
      const url = safeGetCurrentUrl();
      if (url) writeRestoreUrl(url);

      quittingFromGesture = true;
      app.quit();
      return;
    }

    // Otherwise, focus or create.
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
