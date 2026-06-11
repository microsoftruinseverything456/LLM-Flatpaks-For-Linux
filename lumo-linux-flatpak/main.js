// main.js
const { app, BrowserWindow, WebContentsView, shell, clipboard, session, Menu, ipcMain, dialog, Notification } = require('electron');
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

// ---------------- window.prompt() support ----------------
// Electron deliberately does not implement window.prompt() (it throws
// "prompt() is not supported." and returns null). Some flows rely on it, so we
// provide our own implementation.
//
// prompt() must return SYNCHRONOUSLY, but a strict CSP (connect-src 'self',
// script-src 'self') rules out the usual sync tricks (sync-XHR to a custom
// scheme, SharedArrayBuffer/Atomics needs cross-origin isolation). Instead:
//   1. preload.js exposes a synchronous bridge (window.__llPrompt.run) to the
//      page's main world.
//   2. run() opens a native modal window (ll-prompt-open) and then blocks the
//      calling renderer by polling the main process (ll-prompt-poll) until the
//      user answers. Only the calling renderer blocks — the main process event
//      loop stays free, so the modal window renders and accepts input normally.
//   3. window.prompt is reassigned to call the bridge. executeJavaScript injects
//      this into the main world, bypassing the page's script-src CSP.
// The modal collects the value and reports it back via ll-prompt-done.

const promptPending = new Map(); // token -> { done, value, win }
let promptSeq = 0;

function openPromptModal(parent, message, def) {
  const token = `llp_${Date.now()}_${++promptSeq}`;
  const entry = { done: false, value: null, win: null };
  promptPending.set(token, entry);

  let modal;
  try {
    modal = new BrowserWindow({
      width: 460,
      height: 200,
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      modal: !!(parent && !parent.isDestroyed()),
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: '',
      autoHideMenuBar: true,
      useContentSize: true,
      backgroundColor: '#1b1b22',
      icon: path.join(__dirname, '512x512.png'),
      webPreferences: {
        preload: path.join(__dirname, 'prompt-preload.js'),
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
      },
    });
  } catch {
    promptPending.delete(token);
    return null;
  }

  entry.win = modal;
  modal.setMenu(null);
  modal.loadFile(path.join(__dirname, 'prompt.html'), {
    query: { token, message: String(message ?? ''), def: String(def ?? '') },
  });

  // Closing the window without answering counts as cancel (returns null).
  modal.once('closed', () => {
    const e = promptPending.get(token);
    if (e && !e.done) { e.done = true; e.value = null; }
  });

  // Safety net: never leave the page blocked forever.
  setTimeout(() => {
    const e = promptPending.get(token);
    if (e && !e.done) {
      e.done = true;
      e.value = null;
      try { if (e.win && !e.win.isDestroyed()) e.win.close(); } catch {}
    }
  }, 10 * 60 * 1000);

  return token;
}

ipcMain.on('ll-prompt-open', (event, payload) => {
  const parent = BrowserWindow.fromWebContents(event.sender);
  event.returnValue = openPromptModal(parent, payload?.message, payload?.def);
});

ipcMain.on('ll-prompt-poll', (event, token) => {
  const entry = promptPending.get(token);
  if (!entry) { event.returnValue = { done: true, value: null }; return; }
  if (entry.done) {
    promptPending.delete(token);
    try { if (entry.win && !entry.win.isDestroyed()) entry.win.close(); } catch {}
    event.returnValue = { done: true, value: entry.value };
  } else {
    event.returnValue = { done: false };
  }
});

ipcMain.on('ll-prompt-done', (_event, payload) => {
  const entry = promptPending.get(payload?.token);
  if (!entry || entry.done) return;
  entry.value = payload?.value == null ? null : String(payload.value);
  entry.done = true;
  try { if (entry.win && !entry.win.isDestroyed()) entry.win.close(); } catch {}
});

// Reinstall window.prompt in the page's main world. executeJavaScript runs in
// the main world and bypasses the page's script-src CSP, so the reassignment
// sticks even though the site forbids inline scripts.
const PROMPT_INSTALL = `(function(){
  if (!window.__llPrompt || typeof window.__llPrompt.run !== 'function') return;
  window.prompt = function(message, def){
    try {
      return window.__llPrompt.run(
        message == null ? '' : String(message),
        def == null ? '' : String(def)
      );
    } catch (e) { return null; }
  };
})();`;

function installPromptOverride(w) {
  if (!w || w.isDestroyed()) return;
  const inject = () => {
    if (w.isDestroyed()) return;
    w.webContents.executeJavaScript(PROMPT_INSTALL, true).catch(() => {});
  };
  w.webContents.on('dom-ready', inject);
  w.webContents.on('did-finish-load', inject);
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
// Hard request filter: only proton.me (and subdomains) over https may make
// network requests; everything else is cancelled. NOTE: this is global to the
// default session, so it also applies to in-app pop-ups and downloads. If a flow
// needs an external host (e.g. third-party OAuth), widen ALLOWED_HOSTS above.
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

// ---------------- Download helpers ----------------
// Inside a flatpak the sandbox routes notifications through the desktop portal,
// which uses the app's desktop-entry icon and IGNORES a file-path icon (libnotify
// warns "App Icon is not available when using Portal Notifications"). So only set
// an explicit icon when NOT under the portal (e.g. the .deb build).
const RUNNING_IN_FLATPAK = (() => {
  try { return !!process.env.FLATPAK_ID || fs.existsSync('/.flatpak-info'); } catch { return false; }
})();

function notifOptions(opts) {
  if (!RUNNING_IN_FLATPAK) opts.icon = path.join(__dirname, '512x512.png');
  return opts;
}

function showNotif(title, body) {
  if (!Notification.isSupported()) return;
  try {
    new Notification(notifOptions({ title, body })).show();
  } catch {}
}

function moveDL(src, dest, originalFilename) {
  dlBadge(false);
  try {
    try { fs.renameSync(src, dest); }
    catch { fs.copyFileSync(src, dest); fs.unlinkSync(src); }
    logIfTerminal(`[download] saved: ${dest}`);
    if (!Notification.isSupported()) return;
    const n = new Notification(notifOptions({
      title: 'Download Complete',
      body: path.basename(dest),
    }));
    n.once('click', () => { try { shell.showItemInFolder(dest); } catch {} });
    n.show();
  } catch {
    showNotif('Download Failed', originalFilename);
  }
}

// Inject / update / remove a small in-app download badge (bottom-right corner).
// pct: 0-100 while progressing, null while indeterminate, undefined to remove.
function dlBadge(show, label, pct) {
  if (!win || win.isDestroyed()) return;
  if (!show) {
    win.webContents.executeJavaScript(
      `(function(){ const e=document.getElementById('__ll_dl__'); if(e)e.remove(); })()`
    ).catch(() => {});
    return;
  }
  const text = pct != null ? `↓ ${label} — ${pct}%` : `↓ ${label} — starting…`;
  win.webContents.executeJavaScript(`(function(){
    const ID='__ll_dl__';
    let el=document.getElementById(ID);
    if(!el){
      el=document.createElement('div'); el.id=ID;
      const sp=(k,v)=>el.style.setProperty(k,v,'important');
      sp('position','fixed'); sp('bottom','16px'); sp('right','16px');
      sp('background','rgba(15,15,22,0.92)'); sp('color','#d8d8e8');
      sp('padding','7px 13px'); sp('border-radius','8px');
      sp('font','500 12px/1.5 system-ui,sans-serif');
      sp('z-index','2147483647'); sp('pointer-events','none');
      sp('box-shadow','0 2px 12px rgba(0,0,0,0.45)');
      sp('max-width','280px'); sp('word-break','break-all');
      sp('border','1px solid rgba(255,255,255,0.08)');
      document.documentElement.appendChild(el);
    }
    el.textContent=${JSON.stringify(text)};
  })()`).catch(() => {});
}

// ---------------- Pop-up / window.open support ----------------
// The site opens pop-ups that contain forms (login, compose, share, OAuth, etc.)
// via window.open(). These must open as real in-app child windows or their text
// boxes never appear and their opener/postMessage relationship breaks. Plain
// external links (target="_blank" to another site) still go to the system
// browser, matching the rest of the app's external-link policy.

const POPUP_PRELOAD = path.join(__dirname, 'preload.js');

// Parse the windowFeatures string ("width=500,height=600,...") for a sane size,
// clamped so a misbehaving page can't request an absurd window.
function parsePopupSize(features) {
  const opts = { width: 600, height: 720 };
  if (typeof features === 'string' && features) {
    for (const part of features.split(',')) {
      const [k, v] = part.split('=').map((s) => (s || '').trim().toLowerCase());
      const n = parseInt(v, 10);
      if (Number.isFinite(n) && n > 0) {
        if (k === 'width' || k === 'innerwidth')  opts.width  = Math.min(Math.max(n, 200), 1920);
        if (k === 'height' || k === 'innerheight') opts.height = Math.min(Math.max(n, 150), 1200);
      }
    }
  }
  return opts;
}

function popupWindowOptions(features) {
  const { width, height } = parsePopupSize(features);
  return {
    width,
    height,
    show: true,
    autoHideMenuBar: true,
    icon: path.join(__dirname, '512x512.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: true,
      preload: POPUP_PRELOAD,
    },
  };
}

// Decide what to do with a window.open()/target=_blank request.
function handleWindowOpen(details) {
  const { url, disposition } = details;

  // Page-driven blank pop-ups: the site creates an empty window and fills it in
  // itself (document.write / DOM). These MUST stay in-app or the content (and
  // any text boxes) never appears.
  if (!url || url === 'about:blank') {
    return { action: 'allow', overrideBrowserWindowOptions: popupWindowOptions(details.features) };
  }

  let u;
  try { u = new URL(url); } catch { return { action: 'deny' }; }
  const proto = u.protocol;

  if (proto === 'data:' || proto === 'blob:') {
    return { action: 'allow', overrideBrowserWindowOptions: popupWindowOptions(details.features) };
  }

  if (proto === 'http:' || proto === 'https:') {
    // In-app child window for: the site's own pop-ups (allowed domain) and genuine
    // scripted pop-ups (window.open with features → 'new-window'), which covers
    // OAuth/login/share dialogs whose text boxes must work and whose opener
    // relationship must survive. Plain external links open in the system browser.
    if (isAllowed(url) || disposition === 'new-window') {
      return { action: 'allow', overrideBrowserWindowOptions: popupWindowOptions(details.features) };
    }
    try { shell.openExternal(url); } catch {}
    return { action: 'deny' };
  }

  // mailto:, tel:, and other registered schemes → hand to the OS.
  try { shell.openExternal(url); } catch {}
  return { action: 'deny' };
}

// Shared right-click menu (spellcheck suggestions + edit roles + copy link),
// used by the main window and every pop-up so text boxes get cut/copy/paste.
function attachContextMenu(w) {
  w.webContents.on('context-menu', (_e, p) => {
    const template = [];

    const misspelled = typeof p.misspelledWord === 'string' ? p.misspelledWord : '';
    const suggestions = Array.isArray(p.dictionarySuggestions) ? p.dictionarySuggestions : [];

    if (misspelled && suggestions.length) {
      suggestions.slice(0, 8).forEach((s) => {
        template.push({
          label: s,
          click: () => {
            try { if (w && !w.isDestroyed()) w.webContents.replaceMisspelling(s); } catch {}
          },
        });
      });
      template.push({ type: 'separator' });
      template.push({
        label: 'Add to Dictionary',
        click: () => {
          try { session.defaultSession.addWordToSpellCheckerDictionary(misspelled); } catch {}
        },
      });
      template.push({ type: 'separator' });
    }

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

    Menu.buildFromTemplate(template).popup({ window: w, x: p.x, y: p.y });
  });
}

// Esc / Ctrl+W close a pop-up; Ctrl+Shift+I toggles its devtools.
function attachPopupShortcuts(w) {
  w.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = (input.key || '').toLowerCase();
    const ctrlOrCmd = !!(input.control || input.meta);

    if (key === 'escape' || (ctrlOrCmd && key === 'w')) {
      event.preventDefault();
      if (w && !w.isDestroyed()) w.close();
      return;
    }
    if (ctrlOrCmd && input.shift && key === 'i') {
      event.preventDefault();
      w.webContents.toggleDevTools();
    }
  });
}

// Wire up a freshly created pop-up window. Pop-ups navigate freely (so auth /
// redirect flows complete inside them); only file:// drops are blocked. Nested
// pop-ups follow the same policy. Menu suppression is handled globally by
// browser-window-created in installNoMenuOnce().
function configurePopup(childWindow) {
  if (!childWindow || childWindow.isDestroyed()) return;

  const contents = childWindow.webContents;
  contents.setWindowOpenHandler(handleWindowOpen);
  contents.on('did-create-window', configurePopup);

  contents.on('will-navigate', (e, url) => {
    try { if (new URL(url).protocol === 'file:') e.preventDefault(); } catch {}
  });

  attachContextMenu(childWindow);
  attachPopupShortcuts(childWindow);
  installPromptOverride(childWindow);
}

// ---------------- Create window (deduped) ----------------
let hidingToBackground = false;

async function createWindowOnce() {
  if (focusExistingWindow()) return win;
  if (creatingPromise) return creatingPromise;

  creatingPromise = (async () => {
    installNoMenuOnce();
    installNetworkLockdownOnce();

    try {
      session.defaultSession.setSpellCheckerLanguages(['en-US']);
    } catch {}

    // Downloads: pick save location, show taskbar progress, notify on completion.
    // Electron requires setSavePath synchronously, so we download to a temp file
    // first and move it to the user's chosen location once done.
    session.defaultSession.on('will-download', (_event, item) => {
      const filename = item.getFilename();
      const tmpPath = path.join(app.getPath('temp'), `ll_dl_${Date.now()}_${filename}`);
      item.setSavePath(tmpPath);

      let finalPath = null;
      let itemDone = false;
      let itemState = null;

      dialog.showSaveDialog(win || undefined, {
        title: 'Save Download',
        defaultPath: path.join(app.getPath('downloads'), filename),
        buttonLabel: 'Save',
      }).then(({ filePath, canceled }) => {
        if (canceled || !filePath) {
          if (!itemDone) item.cancel();
          else try { fs.unlinkSync(tmpPath); } catch {}
          return;
        }
        finalPath = filePath;
        // Start all visible progress indicators now that the user confirmed a path
        if (win && !win.isDestroyed()) win.setProgressBar(0);
        showNotif('Downloading', path.basename(finalPath));
        dlBadge(true, path.basename(finalPath), null);
        if (itemDone && itemState === 'completed') moveDL(tmpPath, finalPath, filename);
      }).catch(() => {
        if (!itemDone) item.cancel();
      });

      item.on('updated', (_e, state) => {
        if (state !== 'progressing' || item.isPaused() || !finalPath) return;
        const total = item.getTotalBytes();
        const recv  = item.getReceivedBytes();
        const ratio = total > 0 ? recv / total : -1;
        const pct   = total > 0 ? Math.floor(ratio * 100) : null;
        if (win && !win.isDestroyed()) win.setProgressBar(ratio);
        dlBadge(true, path.basename(finalPath), pct);
      });

      item.once('done', (_e, state) => {
        itemDone  = true;
        itemState = state;
        if (win && !win.isDestroyed()) win.setProgressBar(-1);
        if (state === 'completed') {
          if (finalPath) moveDL(tmpPath, finalPath, filename);
          // else dialog still open — moveDL called from its .then()
        } else {
          dlBadge(false);
          try { fs.unlinkSync(tmpPath); } catch {}
          if (state !== 'cancelled') showNotif('Download Failed', filename);
        }
      });
    });

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
        spellcheck: true,
        preload: path.join(__dirname, 'preload.js')
      },
      icon: path.join(__dirname, '512x512.png')
    });

    // No menu bar
    win.setMenu(null);
    win.setMenuBarVisibility(false);
    win.setAutoHideMenuBar(true);

    // ---- Loading bar overlay (WebContentsView) ----
    // A separate renderer that loads bar.html — completely isolated from the site,
    // so no page CSS/JS can interfere with it.
    const barView = new WebContentsView({
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
    });
    barView.setBackgroundColor('#00000000');
    win.contentView.addChildView(barView);

    // Collapse view to height 0 when idle (mirrors Android's View.GONE), expand to 3px
    // when active.  This ensures no pixel strip is visible if compositor transparency fails.
    let barActive = false;
    let barHideTimer = null;

    function barBounds() {
      if (win.isDestroyed()) return;
      const [w] = win.getContentSize();
      barView.setBounds({ x: 0, y: 0, width: w, height: barActive ? 3 : 0 });
    }
    win.on('resize', barBounds);

    const barJs = code => {
      if (!barView.webContents || barView.webContents.isDestroyed()) return;
      barView.webContents.executeJavaScript(code).catch(() => {});
    };

    function barShow() {
      clearTimeout(barHideTimer);
      barActive = true;
      barBounds();
      barJs('start()');
    }

    function barDone() {
      barJs('finish()');
      // Hide view after animation completes: 500ms min-wait + 250ms fill + 400ms fade
      clearTimeout(barHideTimer);
      barHideTimer = setTimeout(() => { barActive = false; barBounds(); }, 1200);
    }

    barView.webContents.loadFile(path.join(__dirname, 'bar.html'));

    // Renderer death — logs the reason + exit code so a hard failure is traceable.
    // 'clean-exit' and normal navigations are skipped as noise.
    win.webContents.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return;
      console.error('[crash] render-process-gone:', JSON.stringify(details));
    });

    win.webContents.on('will-navigate',       ()                           => barShow());
    win.webContents.on('did-commit-navigation', (_e, _u, _ip, isMainFrame) => { if (isMainFrame) barShow(); });
    win.webContents.on('did-finish-load',     ()                           => barDone());
    win.webContents.on('did-stop-loading',    ()                           => barDone());

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

      if (input.alt && key === 'arrowleft' && win.webContents.navigationHistory.canGoBack()) {
        event.preventDefault();
        win.webContents.navigationHistory.goBack();
        return;
      }

      if (input.alt && key === 'arrowright' && win.webContents.navigationHistory.canGoForward()) {
        event.preventDefault();
        win.webContents.navigationHistory.goForward();
        return;
      }
    });

    win.once('ready-to-show', () => {
      if (!win || win.isDestroyed()) return;
      win.setSkipTaskbar(false);
      win.show();
      win.focus();
    });

    // Context menu (shared with pop-ups)
    attachContextMenu(win);

    // Pop-ups (window.open / target=_blank): the site's own form windows open
    // in-app; plain external links go to the system browser. See handleWindowOpen.
    win.webContents.setWindowOpenHandler(handleWindowOpen);
    win.webContents.on('did-create-window', configurePopup);

    // Provide a working window.prompt() (Electron omits it). See the section above.
    installPromptOverride(win);

    win.webContents.on('will-navigate', (e, url) => {
      try {
        const u = new URL(url);
        // Prevent Electron from navigating to dropped files
        if (u.protocol === 'file:') {
          e.preventDefault();
          return;
        }
      } catch {}
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
    // Log GPU status so hardware acceleration can be verified from the terminal.
    // NOTE: the GPU process finishes initializing AFTER whenReady, so a snapshot
    // taken here shows the pre-init (software) state — query again a few seconds
    // later for the real picture.
    const logGpuStatus = (when) => {
      try {
        const status = app.getGPUFeatureStatus();
        console.log(`[gpu] feature status (${when}):`, JSON.stringify(status));
      } catch (err) {
        console.log(`[gpu] feature status unavailable: ${err.message}`);
      }
      app.getGPUInfo('basic')
        .then((info) => console.log(`[gpu] device info (${when}):`, JSON.stringify(info)))
        .catch((err) => console.log(`[gpu] device info unavailable: ${err.message}`));
    };
    console.log('[gpu] cmdline switches (browser process):', JSON.stringify({
      'disable-features': app.commandLine.getSwitchValue('disable-features'),
      'enable-features': app.commandLine.getSwitchValue('enable-features'),
      'ozone-platform': app.commandLine.getSwitchValue('ozone-platform'),
      'ignore-gpu-blocklist': app.commandLine.hasSwitch('ignore-gpu-blocklist'),
    }));

    logGpuStatus('at-ready');
    setTimeout(() => logGpuStatus('post-init'), 6000);

    createWindowOnce();
  });

  // Log GPU / utility / renderer process deaths so a crash is diagnosable after
  // the fact. `child-process-gone` covers the GPU process and the utility
  // processes (details.name is e.g. 'Audio Service' / 'Video Decoder'); clean
  // exits are skipped to avoid noise.
  app.on('child-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    console.error('[crash] child-process-gone:', JSON.stringify(details));
  });

  // macOS dock click should focus or recreate
  app.on('activate', () => {
    createWindowOnce();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
