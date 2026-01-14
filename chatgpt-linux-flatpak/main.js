const { app, BrowserWindow, Menu, shell, clipboard, session, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

let win;

// ---------------- Restore-on-rerun state ----------------
function stateFilePath() {
  return path.join(app.getPath('userData'), 'restore-state.json');
}

function writeRestoreUrl(url) {
  try {
    fs.writeFileSync(
      stateFilePath(),
      JSON.stringify({ restoreUrl: url, ts: Date.now() }),
      'utf8'
    );
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
  'chatgpt.com',
  'openai.com',
  'oaiusercontent.com',
  'oaistatic.com',
  'challenges.cloudflare.com'
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

function isHttpUrl(u) {
  return u.protocol === 'http:' || u.protocol === 'https:';
}

function shouldOpenExternally(targetUrl) {
  try {
    const u = new URL(targetUrl);
    if (!isHttpUrl(u)) return false;
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

// ---------------- Single instance ----------------
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;

    // If already focused → save chat + quit
    if (win.isFocused() && win.isVisible() && !win.isMinimized()) {
      const url = safeGetCurrentUrl();
      if (url) writeRestoreUrl(url);
      app.quit();
      return;
    }

    // Otherwise, best-effort restore visibility
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.show();
    win.focus();

    // Wayland-safe fallback: notify if raise is denied
    if (Notification.isSupported()) {
      const n = new Notification({
        title: 'ChatGPT',
        body: 'Already running — click to bring it forward'
      });
      n.on('click', () => {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      });
      n.show();
    }
  });

  function createWindow() {
    win = new BrowserWindow({
      width: 1200,
      height: 800,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      },
      icon: path.join(__dirname, 'assets/icons/build/icons/64x64.png')
    });

    // Decide startup URL (one-shot restore)
    const restoreUrl = readRestoreUrl();
    const startUrl =
      restoreUrl && isAllowed(restoreUrl)
        ? restoreUrl
        : 'https://chatgpt.com/';

    if (startUrl !== 'https://chatgpt.com/') {
      win.webContents.once('did-finish-load', clearRestoreUrl);
      win.webContents.once('did-fail-load', clearRestoreUrl);
    }

    // ---------------- Network lockdown ----------------
    const filter = { urls: ['*://*/*'] };

    session.defaultSession.webRequest.onBeforeRequest(filter, (details, cb) => {
      try {
        const u = new URL(details.url);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          return cb({ cancel: false });
        }
        if (!isAllowed(details.url)) {
          console.log('[BLOCKED]', details.url);
          return cb({ cancel: true });
        }
        return cb({ cancel: false });
      } catch {
        return cb({ cancel: true });
      }
    });

    // ---------------- Menu ----------------
    const menu = Menu.buildFromTemplate([
      {
        label: 'File',
        submenu: [
          { role: 'close', accelerator: 'Ctrl+W' },
          { role: 'quit', accelerator: 'Ctrl+Q' }
        ]
      },
      {
        label: 'View',
        submenu: [
          { role: 'reload', accelerator: 'Ctrl+R' },
          { role: 'toggledevtools', accelerator: 'Ctrl+Shift+I' },
          { type: 'separator' },
          { role: 'resetzoom' },
          { role: 'zoomin' },
          { role: 'zoomout' },
          { type: 'separator' },
          { role: 'togglefullscreen', accelerator: 'F11' }
        ]
      }
    ]);

    Menu.setApplicationMenu(menu);
    win.setMenuBarVisibility(false);

    // ---------------- Context menu ----------------
    win.webContents.on('context-menu', (_e, p) => {
      const items = [];

      if (p.misspelledWord) {
        (p.dictionarySuggestions || []).slice(0, 8).forEach(s =>
          items.push({
            label: s,
            click: () => win.webContents.replaceMisspelling(s)
          })
        );
        if (!items.length) items.push({ label: 'No suggestions', enabled: false });
        items.push({ type: 'separator' });
      }

      items.push(
        { label: 'Cut', role: 'cut', enabled: p.isEditable && p.editFlags.canCut },
        { label: 'Copy', role: 'copy', enabled: p.selectionText?.length },
        { label: 'Paste', role: 'paste', enabled: p.isEditable && p.editFlags.canPaste },
        { label: 'Select All', role: 'selectAll' }
      );

      if (p.linkURL) {
        items.push(
          { type: 'separator' },
          {
            label: 'Copy Link Address',
            click: () => clipboard.writeText(p.linkURL)
          }
        );
      }

      Menu.buildFromTemplate(items).popup({ window: win, x: p.x, y: p.y });
    });

    // ---------------- Navigation control ----------------
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

    win.loadURL(startUrl);

    win.on('closed', () => {
      win = null;
    });
  }

  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}
