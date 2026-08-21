// main.js
const { app, BrowserWindow, WebContentsView, shell, clipboard, session, Menu, ipcMain, dialog, Notification } = require('electron');

// Allow audio without a prior user gesture (Chromium blocks autoplay by default)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// NOTE: GPU/hardware-acceleration switches are NOT set here. Chromium reads
// feature flags (e.g. --disable-features=Vulkan) before this script runs, so
// app.commandLine.appendSwitch() is too late for them. They are passed on the
// real launch command line via the flatpak target's `executableArgs` in
// package.json instead. See the [gpu] logging in app.whenReady() below.
//
// Vulkan/Wayland: useWaylandFlags appends `--ozone-platform=wayland` to the
// launch command, which is incompatible with Vulkan (Chromium logs a warning
// from wayland_surface_factory). `--disable-features=Vulkan` is kept as intent
// but is CONFIRMED ineffective for the GPU vulkan status in this Electron-42
// flatpak: re-test showed the switch arrives intact (see the [gpu] cmdline log)
// yet post-init still reports vulkan:enabled_on (and webgpu:enabled despite
// being disabled too) — Chromium ignores the disable list for these. On NVIDIA
// `hardwareSupportsVulkan:false`, so the warning is cosmetic there. Actually
// suppressing Vulkan needs a heavier, cross-vendor lever (force GL/ANGLE backend
// or --ozone-platform=x11), which must be validated on AMD before adopting.
// `--ignore-gpu-blocklist` was removed for a separate reason (it force-enables
// blocklisted video-decode paths on non-NVIDIA GPUs); do not re-add it.
const path = require('path');
const fs = require('fs');

// ============================================================================
//  APP CONFIGURATION - the ONLY per-app section in this file.
//  Retargeting this wrapper means editing this block, the identity fields in
//  package.json, and the BUILD_TMP slug in compile_arch.sh. Nothing else in
//  main.js mentions the site.
// ============================================================================

// Window/taskbar title, and the fallback until the page supplies its own.
const APP_TITLE = 'Claude';

// First page on a cold start, and the fallback when there is no restore state.
// MUST satisfy isAllowedUrl() - see the config guard below.
const HOME_URL = 'https://claude.ai/';

// THE FIREWALL + IN-APP ALLOWLIST (one list, two jobs).
// A URL matches if it is https AND its host equals an entry or is a subdomain
// of one. Anything here (a) may make network requests, (b) opens in-app rather
// than in the system browser. Third-party CDN, captcha and auth hosts the site
// depends on MUST be listed, or their requests are cancelled and the page
// silently half-loads. See "Network lockdown" below.
const ALLOWED_HOSTS = [
  'claude.ai',
  'anthropic.com',
  'cloudflare.com',
  'claudeusercontent.com',
  'cloudflareinsights.com',
  'claudemcpcontent.com',
  'claude.com',
];

// Hosts allowed to ASK for camera / microphone / clipboard / fullscreen.
// Deliberately a subset of ALLOWED_HOSTS: a captcha or analytics host has no
// business requesting the webcam. Set to null to fall back to ALLOWED_HOSTS.
const TRUSTED_HOSTS = ['claude.ai', 'claude.com', 'anthropic.com', 'claudeusercontent.com', 'claudemcpcontent.com'];

// Optional per-app JS run in the page's MAIN world after every load (bypasses
// the site's script-src CSP, like PROMPT_INSTALL does). null = nothing.
const PAGE_INJECT_JS = null;

// ========================= END APP CONFIGURATION ============================

let win = null;
let creatingPromise = null;

// Page machinery (built inside createWindowOnce, exposed here for the
// module-level IPC handlers and helpers). Null while no window exists.
let pageApi = null;

// The site page lives in a WebContentsView, which BrowserWindow.fromWebContents()
// cannot resolve (it returns undefined), so fall back to the main window — the
// only window that ever hosts the page. Pop-ups are real BrowserWindows and
// resolve normally.
function ownerWindowFor(contents) {
  const w = BrowserWindow.fromWebContents(contents);
  if (w && !w.isDestroyed()) return w;
  return win && !win.isDestroyed() ? win : null;
}
const DOWNLOAD_BAR_HEIGHT = 34;

// ---------------- Restore-on-rerun state ----------------
function stateFilePath() {
  return path.join(app.getPath('userData'), 'restore-state.json');
}

// state = { restoreUrl }
function writeRestoreState(restoreUrl) {
  try {
    fs.writeFileSync(stateFilePath(), JSON.stringify({ restoreUrl, ts: Date.now() }), 'utf8');
  } catch {}
}

// Returns the URL to restore, or null.
function readRestoreState() {
  try {
    const data = JSON.parse(fs.readFileSync(stateFilePath(), 'utf8'));
    if (typeof data?.restoreUrl === 'string' && isAllowedUrl(data.restoreUrl)) return data.restoreUrl;
    // Tabbed-build format ({ tabs, activeIndex }): restore just the active tab,
    // so a state file left behind by that build still works here.
    if (Array.isArray(data?.tabs)) {
      const urls = data.tabs.filter((u) => typeof u === 'string' && isAllowedUrl(u));
      if (!urls.length) return null;
      const idx = Number.isInteger(data.activeIndex) ? data.activeIndex : 0;
      return urls[Math.min(Math.max(idx, 0), urls.length - 1)];
    }
    return null;
  } catch {
    return null;
  }
}

function clearRestoreState() {
  try {
    fs.unlinkSync(stateFilePath());
  } catch {}
}

// ---------------- Domain policy ----------------
// One host matcher, two policies layered on it. https-only by design: an http
// URL is never in-app and never allowed through the firewall.
function hostMatches(urlString, hosts) {
  try {
    const u = new URL(urlString);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    return hosts.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

// "May the app load this at all?" - the firewall, navigation, pop-up and
// restore-state predicate.
function isAllowedUrl(urlString) {
  return hostMatches(urlString, ALLOWED_HOSTS);
}

// "May this origin be granted camera / mic / clipboard / fullscreen?"
function isTrustedUrl(urlString) {
  return hostMatches(urlString, TRUSTED_HOSTS || ALLOWED_HOSTS);
}

function shouldOpenExternally(targetUrl) {
  try {
    const u = new URL(targetUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return !isAllowedUrl(targetUrl);
  } catch {
    return false;
  }
}

// Config guard. A HOME_URL outside ALLOWED_HOSTS yields a window that opens and
// instantly blanks (the firewall cancelling its own home page) with no other
// clue. Cheap insurance while retargeting.
if (!isAllowedUrl(HOME_URL)) {
  console.error(
    `[config] HOME_URL ${HOME_URL} is not covered by ALLOWED_HOSTS ` +
    `${JSON.stringify(ALLOWED_HOSTS)} - the app will not load.`
  );
}

// ---------------- Terminal-only logging helper ----------------
function logIfTerminal(msg) {
  try {
    if (process?.stdout?.isTTY) console.log(msg);
  } catch {}
}

// ---------------- Network lockdown (once) ----------------
// Hard request filter on the DEFAULT session: only ALLOWED_HOSTS over https may
// make network requests; everything else is cancelled. The filter is GLOBAL to
// the session, so it covers the page WebContentsView, every in-app pop-up and
// every download (including the stall-watchdog's downloadURL restarts).
//
// The '*://*/*' pattern only matches http/https/ws/wss, and the handler passes
// any non-http(s) scheme through untouched - so ws/wss streaming, blob:, data:,
// file: (downloadbar.html, prompt.html) and devtools: are unaffected. This is
// the previous generation's exact semantics; do not "tighten" it without
// re-testing streaming responses.
let networkLockdownInstalled = false;
const blockedHostsNotified = new Set();

function logBlockedUrl(detailsUrl, why = '') {
  try {
    if (!process?.stdout?.isTTY) return;
    const u = new URL(detailsUrl);
    const reason = why ? ` (${why})` : '';
    console.log(`[blocked] ${u.origin}${u.pathname}${u.search}${reason}`);
  } catch {
    logIfTerminal(`[blocked] ${String(detailsUrl)}`);
  }
}

// A cancelled SUBRESOURCE is usually harmless (an analytics beacon). A cancelled
// DOCUMENT is what the user experiences as "the sign-in pop-up is just white" -
// so surface that one, once per host, instead of failing silently. Without this
// the only evidence is a [blocked] line on a TTY, which a flatpak user never sees.
function notifyBlockedDocument(url) {
  try {
    const host = new URL(url).hostname;
    if (blockedHostsNotified.has(host)) return;
    blockedHostsNotified.add(host);
    showNotif('Blocked by app firewall', host);
  } catch {}
}

function installNetworkLockdownOnce() {
  if (networkLockdownInstalled) return;
  networkLockdownInstalled = true;

  session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
    try {
      const u = new URL(details.url);

      // Allow non-http(s) internal schemes (devtools, file, blob, ws, ...)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return cb({ cancel: false });

      if (!isAllowedUrl(details.url)) {
        logBlockedUrl(details.url, 'domain not allowed');
        if (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame') {
          notifyBlockedDocument(details.url);
        }
        return cb({ cancel: true });
      }

      return cb({ cancel: false });
    } catch {
      logBlockedUrl(details.url, 'invalid url');
      return cb({ cancel: true });
    }
  });
}

// ---------------- window.prompt() support ----------------
// Electron deliberately does not implement window.prompt() (it throws
// "prompt() is not supported." and returns null). The site relies on it (e.g.
// "Enter new filename:"), so we provide our own implementation.
//
// prompt() must return SYNCHRONOUSLY, but the site's strict CSP
// (connect-src 'self', script-src 'self') rules out the usual sync tricks
// (sync-XHR to a custom scheme, SharedArrayBuffer/Atomics needs cross-origin
// isolation). Instead:
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

// fromWebContents() returns undefined for the page's WebContentsView contents,
// so resolve the host window (the main window) via ownerWindowFor instead.
ipcMain.on('ll-prompt-open', (event, payload) => {
  event.returnValue = openPromptModal(ownerWindowFor(event.sender), payload?.message, payload?.def);
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

// window.confirm() returns true only for the affirmative button. Buttons render
// left-to-right in array order on Linux, so 'OK' is last to keep the affirmative
// on the right (GNOME/GTK convention).
ipcMain.on('ll-confirm', (event, payload) => {
  const parent = ownerWindowFor(event.sender);
  let result = false;
  try {
    const choice = dialog.showMessageBoxSync(
      parent && !parent.isDestroyed() ? parent : undefined,
      {
        type: 'question',
        buttons: ['Cancel', 'OK'],
        defaultId: 1,
        cancelId: 0,
        noLink: true,
        message: String(payload?.message ?? ''),
      }
    );
    result = choice === 1;
  } catch {}
  event.returnValue = result;
});

// Reinstall window.prompt / window.confirm in the page's main world.
// executeJavaScript runs in the main world and bypasses the page's script-src
// CSP, so the reassignment sticks even though the site forbids inline scripts.
const PROMPT_INSTALL = `(function(){
  if (window.__llPrompt && typeof window.__llPrompt.run === 'function') {
    window.prompt = function(message, def){
      try {
        return window.__llPrompt.run(
          message == null ? '' : String(message),
          def == null ? '' : String(def)
        );
      } catch (e) { return null; }
    };
  }
  if (window.__llConfirm && typeof window.__llConfirm.run === 'function') {
    window.confirm = function(message){
      try {
        return window.__llConfirm.run(message == null ? '' : String(message));
      } catch (e) { return false; }
    };
  }
})();`;

function installPromptOverride(contents) {
  if (!contents || contents.isDestroyed()) return;
  const inject = () => {
    if (contents.isDestroyed()) return;
    contents.executeJavaScript(PROMPT_INSTALL, true).catch(() => {});
  };
  contents.on('dom-ready', inject);
  contents.on('did-finish-load', inject);
}

// ---------------- Download-bar IPC (downloadbar.html / downloadbar-preload.js) ----
ipcMain.on('ll-dl-ready', () => { if (pageApi) pageApi.dlPush(); });
ipcMain.on('ll-dl-dismiss', (_event, id) => { if (pageApi) pageApi.dlDismiss(id); });
ipcMain.on('ll-dl-open', (_event, id) => { if (pageApi) pageApi.dlOpen(id); });

// ---------------- Minimal UI: no menus ----------------
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

// ---------------- Focus helper ----------------
function focusExistingWindow() {
  if (!win || win.isDestroyed()) return false;

  try {
    win.setSkipTaskbar(false);
    if (!win.isVisible()) win.show();
  } catch {}

  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();

  // Un-hiding from the background does not reliably emit 'focus' on every Wayland
  // compositor, so the win.on('focus') path above may never run. Push keyboard
  // focus into the page directly, or arrow keys stay dead until the user clicks.
  setImmediate(() => {
    if (!win || win.isDestroyed() || !win.isFocused()) return;
    const wc = pageApi && pageApi.contents();
    if (wc) { try { wc.focus(); } catch {} }
  });

  return true;
}

// (Loading bar lives in preload.js — see comments there.)

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

// The in-app download status lives in a dedicated bottom bar (a WebContentsView,
// see the download-bar setup in createWindowOnce) — main.js owns the download
// list and drives it via pageApi.dl* helpers.

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
    // In-app child window for: the site's own pop-ups and links (home domain,
    // including plain target="_blank" — with no tab strip these become their own
    // window) and genuine scripted pop-ups (window.open with features →
    // 'new-window'), which covers OAuth/login/share dialogs whose text boxes must
    // work and whose opener relationship must survive. Plain external links open
    // in the system browser.
    if (isAllowedUrl(url) || disposition === 'new-window') {
      return { action: 'allow', overrideBrowserWindowOptions: popupWindowOptions(details.features) };
    }
    try { shell.openExternal(url); } catch {}
    return { action: 'deny' };
  }

  // mailto:, tel:, and other registered schemes → hand to the OS.
  try { shell.openExternal(url); } catch {}
  return { action: 'deny' };
}

// Resolve an owner-window argument that may be a BrowserWindow or a getter
// returning one (the page's owner is looked up lazily: the main window may be
// recreated, so the getter is read at event time).
function resolveOwnerWin(ownerWinOrGetter) {
  const w = typeof ownerWinOrGetter === 'function' ? ownerWinOrGetter() : ownerWinOrGetter;
  return w && !w.isDestroyed() ? w : null;
}

// Shared right-click menu (spellcheck suggestions + edit roles + copy link),
// used by the main window and every pop-up so text boxes get cut/copy/paste.
// ownerWin may be a BrowserWindow or a getter (for the page view).
function attachContextMenu(contents, ownerWin) {
  contents.on('context-menu', (_e, p) => {
    const template = [];

    const misspelled = typeof p.misspelledWord === 'string' ? p.misspelledWord : '';
    const suggestions = Array.isArray(p.dictionarySuggestions) ? p.dictionarySuggestions : [];

    if (misspelled && suggestions.length) {
      suggestions.slice(0, 8).forEach((s) => {
        template.push({
          label: s,
          click: () => {
            try { if (!contents.isDestroyed()) contents.replaceMisspelling(s); } catch {}
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

    // No explicit x/y: a WebContentsView reports view-relative coordinates,
    // which would misplace the menu in the window; the cursor is always right.
    Menu.buildFromTemplate(template).popup({
      window: resolveOwnerWin(ownerWin) || undefined,
    });
  });
}

// Esc / Ctrl+W close a pop-up; Ctrl+Shift+I toggles its devtools; F11 fullscreen.
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

// A page's beforeunload guard (e.g. an in-progress upload) tries to cancel a
// navigation or window close. Without a handler Electron just blocks it with no
// way out, trapping the window. Intercept it and show a real confirm dialog:
// preventDefault() lets the unload proceed (user chose Leave); doing nothing
// keeps the page (user chose Stay).
function attachUnloadPrompt(contents, ownerWin) {
  contents.on('will-prevent-unload', (event) => {
    const win = resolveOwnerWin(ownerWin) || BrowserWindow.fromWebContents(contents);
    // Buttons are laid out left-to-right in array order on Linux; the
    // affirmative action goes on the right (GNOME/GTK convention), so 'Leave'
    // is last.
    const choice = dialog.showMessageBoxSync(win || undefined, {
      type: 'question',
      buttons: ['Stay', 'Leave'],
      defaultId: 1,
      cancelId: 0,
      title: 'Leave site?',
      message: 'Changes you made may not be saved.'
    });
    if (choice === 1) event.preventDefault(); // Leave → allow the unload
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

  attachContextMenu(contents, childWindow);
  attachPopupShortcuts(childWindow);
  attachUnloadPrompt(contents, childWindow);
  installPromptOverride(contents);
}

// ---------------- Create window (deduped) ----------------
async function createWindowOnce() {
  if (focusExistingWindow()) return win;
  if (creatingPromise) return creatingPromise;

  creatingPromise = (async () => {
    installNoMenuOnce();
    // Firewall first: it must exist before the first byte of the site is requested.
    installNetworkLockdownOnce();

    try {
      session.defaultSession.setSpellCheckerLanguages(['en-US']);
    } catch {}

    // Media permissions (webcam / microphone). Chromium denies getUserMedia by
    // default unless the embedder approves it; without these handlers the camera
    // is never reachable. Grant media only for our own https origins.
    const mediaPerms = new Set(['media', 'camera', 'microphone', 'mediaKeySystem']);
    // The async Clipboard API (navigator.clipboard.writeText / readText) is also
    // routed through the permission handler. Once a handler is installed, Chromium
    // denies it unless explicitly granted — that is why the site's "click to copy"
    // buttons silently fail. Grant clipboard read + (sanitized) write for our
    // origins so copy/paste works.
    const clipboardPerms = new Set(['clipboard-read', 'clipboard-sanitized-write']);
    // The HTML5 Fullscreen API (element.requestFullscreen) is routed through the
    // permission handler too. Once a handler is installed, Chromium denies
    // fullscreen unless it is explicitly granted — that is why the site cannot go
    // fullscreen even though F11 (a native toggle) works. Grant it for our origins.
    const allowedPerms = new Set([...mediaPerms, ...clipboardPerms, 'fullscreen']);

    // Fullscreen may be requested from inside a CROSS-ORIGIN embed — e.g. a
    // YouTube iframe, whose requestingUrl is youtube.com, not our site. Gating it
    // on the requesting origin (as the other perms are) wrongly denies embedded
    // players while same-origin HTML5 <video> still works. So for fullscreen,
    // trust the TOP-LEVEL page instead: if our site is the page driving the
    // window, allow any frame inside it to go fullscreen.
    const topOriginTrusted = (wc) => {
      try { return isTrustedUrl(wc && wc.getURL()); } catch { return false; }
    };
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
      if (permission === 'fullscreen') {
        callback(topOriginTrusted(wc));
        return;
      }
      const origin = (details && details.requestingUrl) || (wc && wc.getURL());
      const granted = allowedPerms.has(permission) && isTrustedUrl(origin);
      // A silent denial presents as a "copy" button that does nothing or a mic
      // that never activates, with no other trace. Log it.
      if (!granted) logIfTerminal(`[perm] denied ${permission} for ${origin}`);
      callback(granted);
    });
    // Synchronous check used by Chromium for some flows (e.g. enumerateDevices labels).
    session.defaultSession.setPermissionCheckHandler((wc, permission, origin) => {
      if (permission === 'fullscreen') return topOriginTrusted(wc);
      const granted = allowedPerms.has(permission) && isTrustedUrl(origin);
      if (!granted) logIfTerminal(`[perm] check denied ${permission} for ${origin}`);
      return granted;
    });

    // Downloads: pick save location, show progress in the bottom bar + taskbar,
    // and notify only on completion/failure (no "downloading" start toast).
    // Electron requires setSavePath synchronously, so we download to a temp file
    // first and move it to the user's chosen location once done.
    //
    // Networks drop (VPN toggles, Wi-Fi blips). A dropped connection usually dies
    // *silently* — Chromium keeps the item 'progressing' but no bytes arrive, and
    // pause()/resume() won't dislodge the dead socket (verified: resume() never
    // reopens the connection). So a watchdog detects the stall, cancels the stuck
    // transfer, and *restarts* the download — reusing the chosen path + chip with
    // no re-prompt — until it succeeds or a long grace period is exhausted.
    const STALL_MS = 15000;          // no byte movement for this long => recover
    const RECOVER_BACKOFF_MS = 2500; // min gap between recovery attempts
    const MAX_RESTARTS = 10;         // ~survives a multi-minute outage
    const RESTART_ADOPT_MS = 20000;  // if a restart never re-downloads, fail it
    session.defaultSession.on('will-download', (_event, item) => {
      const filename = item.getFilename();
      const url = item.getURL();
      const tmpPath = path.join(app.getPath('temp'), `ll_dl_${Date.now()}_${filename}`);
      item.setSavePath(tmpPath);

      // Is this a programmatic restart of a stalled download? If so adopt its
      // context (chosen path, existing chip, retry count) instead of re-prompting.
      let restartCtx = null;
      const pending = dlRestarts.get(url);
      if (pending && pending.length) { restartCtx = pending.shift(); if (!pending.length) dlRestarts.delete(url); }

      let finalPath = restartCtx ? restartCtx.finalPath : null;
      let entryId   = restartCtx ? restartCtx.entryId   : null;
      let retries   = restartCtx ? restartCtx.retries   : 0;
      let itemDone = false;
      let itemState = null;

      // Stall/recovery tracking.
      let lastBytes = 0;
      let lastProgressAt = Date.now();
      let lastRecoverAt = 0;
      let watchdog = null;

      const dlEntry = () => downloads.find((d) => d.id === entryId);
      const stopWatchdog = () => { if (watchdog) { clearInterval(watchdog); watchdog = null; } };

      function setStalled(on) {
        const e = dlEntry();
        if (e && e.stalled !== on) { e.stalled = on; dlPush(); }
      }
      // Show a "progressing" chip once the user has confirmed a save path.
      function ensureEntry() {
        if (entryId != null) return;
        entryId = ++dlSeq;
        downloads.push({ id: entryId, filename: path.basename(finalPath), state: 'progressing', pct: null, received: 0, total: null, stalled: false, path: null });
        dlItems.set(entryId, item);
        dlRefresh();
      }
      // Move the chip to a terminal state, then auto-remove it after a moment.
      function finishEntry(state) {
        const e = dlEntry();
        if (!e) return;
        e.state = state;
        e.stalled = false;
        if (state === 'completed') e.path = finalPath;
        dlPush();
        setTimeout(() => dlRemove(entryId), 6000);
      }
      function failNow() {
        stopWatchdog();
        if (win && !win.isDestroyed()) win.setProgressBar(-1);
        try { fs.unlinkSync(tmpPath); } catch {}
        finishEntry('failed');
        showNotif('Download Failed', filename);
      }
      // Queue a fresh attempt of the same URL and kick it off (reusing the chip).
      // Returns false if it can't be started (no window / no committed path).
      function startRestart() {
        if (finalPath == null || entryId == null) return false;
        const wc = dlWC();
        if (!wc) return false;
        retries++;
        setStalled(true);
        const e = dlEntry();
        if (e) { e.pct = null; e.received = 0; dlPush(); }
        const ctx = { finalPath, entryId, retries };
        const q = dlRestarts.get(url) || [];
        q.push(ctx);
        dlRestarts.set(url, q);
        try { wc.downloadURL(url); } catch { return false; }
        // Safety net: if nothing ever adopts this context (e.g. the URL no longer
        // serves a download), don't leave the chip spinning forever — fail it.
        setTimeout(() => {
          const cur = dlRestarts.get(url);
          if (!cur || !cur.includes(ctx)) return; // adopted — fine
          cur.splice(cur.indexOf(ctx), 1);
          if (!cur.length) dlRestarts.delete(url);
          const ee = downloads.find((d) => d.id === ctx.entryId);
          if (ee && ee.state === 'progressing') {
            ee.state = 'failed'; ee.stalled = false; dlPush();
            dlItems.delete(ctx.entryId);
            setTimeout(() => dlRemove(ctx.entryId), 6000);
            showNotif('Download Failed', filename);
          }
        }, RESTART_ADOPT_MS);
        return true;
      }
      // Watchdog-detected stall: abandon the stuck transfer and restart it.
      function recoverFromStall() {
        if (itemDone || finalPath == null || entryId == null) return;
        const now = Date.now();
        if (now - lastRecoverAt < RECOVER_BACKOFF_MS) return;
        lastRecoverAt = now;
        itemDone = true;          // abandon this item; its 'done' handler will no-op
        stopWatchdog();
        try { item.cancel(); } catch {}
        try { fs.unlinkSync(tmpPath); } catch {}
        if (retries >= MAX_RESTARTS || !startRestart()) failNow();
      }

      // A restart whose chip was dismissed/cancelled in the meantime: drop it.
      if (restartCtx && !dlEntry()) { try { item.cancel(); } catch {} return; }
      if (restartCtx && entryId != null) {
        dlItems.set(entryId, item);           // × now cancels the new item
        if (win && !win.isDestroyed()) win.setProgressBar(0);
        setStalled(true);                     // "reconnecting…" until bytes flow
      }

      // Watchdog: notice when progress stops and recover.
      watchdog = setInterval(() => {
        if (itemDone) { stopWatchdog(); return; }
        try {
          // Any byte change (incl. a reset when a restart begins) counts as
          // activity — only a frozen count is a stall.
          const recv = item.getReceivedBytes();
          if (recv !== lastBytes) { lastBytes = recv; lastProgressAt = Date.now(); setStalled(false); return; }
          if (Date.now() - lastProgressAt > STALL_MS) recoverFromStall();
        } catch { stopWatchdog(); }
      }, 3000);

      if (!restartCtx) {
        dialog.showSaveDialog(win || undefined, {
          title: 'Save Download',
          defaultPath: path.join(app.getPath('downloads'), filename),
          buttonLabel: 'Save',
        }).then(({ filePath, canceled }) => {
          if (canceled || !filePath) {
            stopWatchdog();
            if (!itemDone) item.cancel();
            else try { fs.unlinkSync(tmpPath); } catch {}
            return;
          }
          finalPath = filePath;
          // Start all visible progress indicators now that the user confirmed a path
          if (win && !win.isDestroyed()) win.setProgressBar(0);
          ensureEntry();
          // The download may have already finished while the dialog was open.
          if (itemDone) {
            stopWatchdog();
            if (itemState === 'completed') { moveDL(tmpPath, finalPath, filename); finishEntry('completed'); }
            else if (itemState !== 'cancelled') finishEntry('failed');
          }
        }).catch(() => {
          stopWatchdog();
          if (!itemDone) item.cancel();
        });
      }

      item.on('updated', (_e, state) => {
        const recv = item.getReceivedBytes();
        if (recv !== lastBytes) { lastBytes = recv; lastProgressAt = Date.now(); }
        if (state === 'interrupted') { // let Chromium range-continue if it can
          if (item.canResume()) { try { item.resume(); } catch {} }
          return;
        }
        if (state !== 'progressing' || item.isPaused() || finalPath == null) return;
        const total = item.getTotalBytes();
        const ratio = total > 0 ? recv / total : -1;
        const pct   = total > 0 ? Math.floor(ratio * 100) : null;
        if (win && !win.isDestroyed()) win.setProgressBar(ratio);
        const e = dlEntry();
        if (e) { e.pct = pct; e.received = recv; e.total = total > 0 ? total : null; e.stalled = false; dlPush(); }
      });

      item.once('done', (_e, state) => {
        if (itemDone) return; // already finalized/abandoned
        itemDone  = true;
        itemState = state;
        stopWatchdog();
        if (win && !win.isDestroyed()) win.setProgressBar(-1);
        if (state === 'completed') {
          if (finalPath) { moveDL(tmpPath, finalPath, filename); finishEntry('completed'); }
          // else dialog still open — handled from its .then()
        } else if (state === 'cancelled') {
          try { fs.unlinkSync(tmpPath); } catch {}
          dlRemove(entryId);
        } else { // interrupted & unresumable — restart if we still have budget
          try { fs.unlinkSync(tmpPath); } catch {}
          if (finalPath != null && entryId != null && retries < MAX_RESTARTS && startRestart()) return;
          finishEntry('failed');
          showNotif('Download Failed', filename);
        }
      });
    });

    const restoreUrl = readRestoreState();
    const startUrl = restoreUrl || HOME_URL;

    // The window's own webContents is an inert shell (about:blank): the site
    // loads in a WebContentsView layered on top of it. Keeping the page in its
    // own view lets the download bar reserve space at the bottom of the window
    // instead of covering the bottom of the page.
    win = new BrowserWindow({
      width: 1440,
      height: 900,
      show: false,
      title: APP_TITLE,
      backgroundColor: '#1b1b22',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
      icon: path.join(__dirname, '512x512.png')
    });

    win.setMenu(null);
    win.setMenuBarVisibility(false);
    win.setAutoHideMenuBar(true);

    // ---- The page ----
    // A single WebContentsView with the site's webPreferences (preload.js).
    let page = null; // { view, title, htmlFullscreen }

    // Download status bar: a WebContentsView pinned to the bottom of the window.
    // `downloads` is the source of truth; the bar renders whatever we push.
    const downloads = []; // { id, filename, state:'progressing'|'completed'|'failed', pct, received, total, stalled, path }
    const dlItems = new Map(); // download id -> DownloadItem, so the × can cancel it
    const dlRestarts = new Map(); // url -> queued restart contexts (stall recovery)
    let dlBarView = null;
    let dlSeq = 0;

    const pageContents = () => {
      const wc = page && page.view.webContents;
      return wc && !wc.isDestroyed() ? wc : null;
    };

    // The page fills the window, minus the download bar when it is showing;
    // in HTML5 fullscreen it covers the whole window, bar included.
    function layoutViews() {
      if (!win || win.isDestroyed()) return;
      const [w, h] = win.getContentSize();
      // The bar is hidden while the page is in HTML5 fullscreen (which covers
      // the whole window) and when there is nothing to show.
      const barVisible = downloads.length > 0 && !(page && page.htmlFullscreen);
      const barH = barVisible ? DOWNLOAD_BAR_HEIGHT : 0;
      if (page) {
        page.view.setBounds(page.htmlFullscreen
          ? { x: 0, y: 0, width: w, height: h }
          : { x: 0, y: 0, width: w, height: Math.max(h - barH, 0) });
      }
      if (dlBarView) {
        dlBarView.setVisible(barVisible);
        if (barVisible) {
          dlBarView.setBounds({ x: 0, y: Math.max(h - DOWNLOAD_BAR_HEIGHT, 0), width: w, height: DOWNLOAD_BAR_HEIGHT });
        }
      }
    }
    win.on('resize', layoutViews);
    win.on('enter-full-screen', layoutViews);
    win.on('leave-full-screen', layoutViews);

    // ---- Download bar state ----
    function dlPush() {
      if (!dlBarView || dlBarView.webContents.isDestroyed()) return;
      dlBarView.webContents.send('ll-dl-state', { items: downloads });
    }
    // Adding/removing an entry changes whether the bar is shown, so re-layout
    // (reserve/reclaim the bottom strip) as well as re-render.
    function dlRefresh() {
      layoutViews();
      dlPush();
    }
    function dlRemove(id) {
      dlItems.delete(id);
      const i = downloads.findIndex((d) => d.id === id);
      if (i === -1) return;
      downloads.splice(i, 1);
      dlRefresh();
    }
    // The × cancels a still-running download (its 'done'/'cancelled' handler then
    // clears the chip); for a finished chip it just dismisses it.
    function dlDismiss(id) {
      const d = downloads.find((x) => x.id === id);
      const item = dlItems.get(id);
      if (d && d.state === 'progressing' && item) { try { item.cancel(); } catch {} return; }
      dlRemove(id);
    }
    function dlOpen(id) {
      const d = downloads.find((x) => x.id === id);
      if (d && d.path) { try { shell.showItemInFolder(d.path); } catch {} }
    }
    // A webContents to re-issue a download from (stall recovery). Prefer the page
    // (keeps the site's origin/cookies context); fall back to the window shell.
    function dlWC() {
      return pageContents() || ((win && !win.isDestroyed()) ? win.webContents : null);
    }

    // The window's own webContents is a blank shell, so win.focus() alone leaves
    // keyboard focus outside the page and the site's document-level key handlers
    // (arrow-key seek, space play/pause) never fire until the user clicks. Hand
    // focus to the page's view instead.
    //
    // Deferred by a tick: the click or compositor event that raised the window can
    // otherwise re-take focus in the same turn, undoing a synchronous focus() call.
    // The isFocused() recheck stops us stealing focus if the window lost it again
    // before the tick ran.
    function focusPage() {
      setImmediate(() => {
        if (!win || win.isDestroyed() || !win.isFocused()) return;
        const wc = pageContents();
        if (wc) { try { wc.focus(); } catch {} }
      });
    }

    function createPage(url) {
      const view = new WebContentsView({
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          spellcheck: true,
          preload: path.join(__dirname, 'preload.js'),
        },
      });
      view.setBackgroundColor('#1b1b22');
      page = { view, title: APP_TITLE, htmlFullscreen: false };
      win.contentView.addChildView(view);
      wirePageContents(page);
      layoutViews();
      view.webContents.loadURL(url).catch(() => {});
      focusPage();
      return page;
    }

    // Ask the page to close; the actual teardown happens in the 'destroyed'
    // handler (wirePageContents), after beforeunload had its chance to veto via
    // attachUnloadPrompt. Closing the page quits the app.
    function closePage() {
      const wc = pageContents();
      if (wc) { try { wc.close(); } catch {} }
    }

    // Snapshot for hide-to-background restore: the page's URL, if it is ours.
    function collectState() {
      let u = null;
      try {
        const wc = pageContents();
        u = wc ? wc.getURL() || null : null;
      } catch {}
      return u && isAllowedUrl(u) ? u : null;
    }

    // Any real close = hard reset (no restore next launch)
    win.on('close', () => {
      clearRestoreState();
    });

    // Keyboard shortcuts — one handler shared by the window shell and the page
    let lastFocusAt = 0;
    win.on('focus', () => {
      lastFocusAt = Date.now();   // must stay first: feeds the Ctrl+W/Q bleed guard below
      focusPage();
    });
    win.on('show', () => focusPage());
    win.on('restore', () => focusPage());

    const shortcutHandler = (event, input) => {
      if (input.type !== 'keyDown') return;

      const fw = BrowserWindow.getFocusedWindow();
      if (!fw || fw.id !== win.id) return;

      const key = (input.key || '').toLowerCase();
      const ctrlOrCmd = !!(input.control || input.meta);
      const contents = pageContents();

      // Prevent cross-window Ctrl+W/Q bleed
      if (ctrlOrCmd && (key === 'w' || key === 'q')) {
        const msSinceFocus = Date.now() - lastFocusAt;
        if (msSinceFocus >= 0 && msSinceFocus < 250) return;
      }

      if (ctrlOrCmd && key === 'q') {
        event.preventDefault();
        clearRestoreState();
        app.quit();
        return;
      }

      // Ctrl+W closes the page (and so the app), giving beforeunload its say.
      // The restore marker is cleared by the page's teardown, so a vetoed close
      // (an in-progress upload, say) leaves it intact.
      if (ctrlOrCmd && key === 'w') {
        event.preventDefault();
        closePage();
        return;
      }

      if (ctrlOrCmd && !input.shift && key === 'r') {
        event.preventDefault();
        if (contents) contents.reload();
        return;
      }

      if (ctrlOrCmd && input.shift && key === 'r') {
        event.preventDefault();
        if (contents) contents.reloadIgnoringCache();
        return;
      }

      if (ctrlOrCmd && input.shift && key === 'i') {
        event.preventDefault();
        if (contents) contents.toggleDevTools();
        return;
      }

      if (input.key === 'F11') {
        event.preventDefault();
        win.setFullScreen(!win.isFullScreen());
        return;
      }

      if (input.alt && key === 'arrowleft' && contents && contents.navigationHistory.canGoBack()) {
        event.preventDefault();
        contents.navigationHistory.goBack();
        return;
      }

      if (input.alt && key === 'arrowright' && contents && contents.navigationHistory.canGoForward()) {
        event.preventDefault();
        contents.navigationHistory.goForward();
        return;
      }
    };

    win.webContents.on('before-input-event', shortcutHandler);


    win.once('ready-to-show', () => {
      if (!win || win.isDestroyed()) return;
      win.setSkipTaskbar(false);
      win.show();
      win.focus();
    });

    // Decide what to do with a same-window navigation. Returns true if it was
    // handled (and the caller should preventDefault), false to let it proceed.
    const handleNavigation = (url) => {
      let u;
      try { u = new URL(url); } catch { return false; }
      // Prevent Electron from navigating to dropped files.
      if (u.protocol === 'file:') return true;
      // Non-web schemes (magnet:, mailto:, tel:, ftp:, ...) can't load as a page
      // navigation — Chromium just drops them, so a clicked magnet link does
      // nothing. Hand them to the OS handler (e.g. the torrent client) instead.
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        try { shell.openExternal(url); } catch {}
        return true;
      }
      // External http(s) → system browser (matches the rest of the app policy).
      if (shouldOpenExternally(url)) {
        try { shell.openExternal(url); } catch {}
        return true;
      }
      return false;
    };

    // Wire up the page's webContents.
    function wirePageContents(pg) {
      const contents = pg.view.webContents;

      contents.on('will-navigate', (e, url) => {
        if (handleNavigation(url)) e.preventDefault();
      });
      contents.on('will-redirect', (e, url) => {
        if (handleNavigation(url)) e.preventDefault();
      });

      // The window's own webContents is blank and can't drive the title, so
      // track the page's title on the window directly.
      contents.on('page-title-updated', (_e, title) => {
        pg.title = title || APP_TITLE;
        try { if (win && !win.isDestroyed()) win.setTitle(pg.title); } catch {}
      });

      // HTML5 fullscreen (e.g. fullscreen video): re-lay-out so the view covers
      // the whole window (download bar included). Electron auto-fullscreens the
      // owning BrowserWindow.
      contents.on('enter-html-full-screen', () => { pg.htmlFullscreen = true; layoutViews(); });
      contents.on('leave-html-full-screen', () => { pg.htmlFullscreen = false; layoutViews(); });

      // Renderer death (distinct from the GPU/utility crashes caught at the app
      // level) — logs the reason + exit code so a hard playback failure is
      // traceable. 'clean-exit' and normal navigations are skipped as noise.
      contents.on('render-process-gone', (_e, details) => {
        if (details.reason === 'clean-exit') return;
        console.error('[crash] render-process-gone:', JSON.stringify(details));
      });

      // Pop-ups (window.open / target=_blank): home-domain links and the site's
      // scripted form windows open in-app, plain external links go to the system
      // browser. See handleWindowOpen.
      contents.setWindowOpenHandler(handleWindowOpen);
      contents.on('did-create-window', configurePopup);

      // Context menu + unload guard parent to the main window.
      attachContextMenu(contents, () => win);
      attachUnloadPrompt(contents, () => win);

      // Provide a working window.prompt() (Electron omits it). See the section above.
      installPromptOverride(contents);

      // Optional per-app DOM fix-ups (see PAGE_INJECT_JS in the app config).
      // Injected into the MAIN world so it bypasses the site's script-src CSP,
      // the same trick PROMPT_INSTALL uses.
      if (PAGE_INJECT_JS) {
        contents.on('did-finish-load', () => {
          if (contents.isDestroyed()) return;
          contents.executeJavaScript(PAGE_INJECT_JS, true).catch(() => {});
        });
      }

      contents.on('before-input-event', shortcutHandler);

      // Teardown after webContents.close() (beforeunload may have vetoed it).
      // Closing the page = closing the app.
      contents.once('destroyed', () => {
        if (page !== pg) return;
        page = null;
        if (!win || win.isDestroyed()) return; // whole window going away already
        try { win.contentView.removeChildView(pg.view); } catch {}
        clearRestoreState();
        app.quit();
      });
    }

    // The window shell itself must never navigate or open windows.
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return;
      console.error('[crash] shell render-process-gone:', JSON.stringify(details));
    });

    pageApi = {
      collectState,
      dlPush,
      dlDismiss,
      dlOpen,
      contents: pageContents,
    };

    // Loaded only so the window paints and reaches 'ready-to-show'; the page
    // view covers it completely.
    await win.loadURL('about:blank');

    // Download status bar — a local WebContentsView pinned to the bottom of the
    // window (see layoutViews). Starts hidden; shown only when downloads exist.
    dlBarView = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: path.join(__dirname, 'downloadbar-preload.js'),
      },
    });
    dlBarView.setBackgroundColor('#101016');
    win.contentView.addChildView(dlBarView);
    dlBarView.setVisible(false);
    dlBarView.webContents.loadFile(path.join(__dirname, 'downloadbar.html')).catch(() => {});

    // Load the site (a fresh home page, or the restored URL).
    createPage(startUrl);

    // If we restored, clear the marker once the load outcome is known
    if (restoreUrl) {
      const wc = pageContents();
      if (wc) {
        wc.once('did-finish-load', clearRestoreState);
        wc.once('did-fail-load', clearRestoreState);
      } else {
        clearRestoreState();
      }
    }

    win.on('closed', () => {
      win = null;
      creatingPromise = null;
      pageApi = null;
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
    // If focused/visible, interpret as "hide-to-background" gesture.
    if (win && !win.isDestroyed() && win.isVisible() && win.isFocused() && !win.isMinimized()) {
      const url = pageApi ? pageApi.collectState() : null;
      if (url) writeRestoreState(url);

      try {
        win.setSkipTaskbar(true);
        win.hide();
        win.blur();
      } catch {}

      return;
    }

    await createWindowOnce();
  });

  app.whenReady().then(async () => {
    // Log GPU status so hardware acceleration can be verified from the terminal.
    // Each feature entry is 'enabled' (hardware), 'unavailable_software' (CPU
    // fallback) or 'disabled_*'; look for gpu_compositing / opengl / rasterization
    // to be 'enabled'. NOTE: the GPU process finishes initializing AFTER
    // whenReady, so a snapshot taken here always shows the pre-init (software)
    // state — query a few seconds later for the real picture.
    const logGpuStatus = (when) => {
      try {
        const status = app.getGPUFeatureStatus();
        console.log(`[gpu] feature status (${when}):`, JSON.stringify(status));
        // Assert the Vulkan/Wayland contradiction stays resolved: under the
        // wayland ozone platform (forced by useWaylandFlags) Vulkan must NOT be
        // enabled. If this warns, something re-enabled Vulkan (e.g. a re-added
        // --ignore-gpu-blocklist) — see the NOTE at the top of this file.
        const onWayland = app.commandLine.getSwitchValue('ozone-platform') === 'wayland';
        if (onWayland && typeof status.vulkan === 'string' && status.vulkan.startsWith('enabled')) {
          console.error(`[gpu] WARNING (${when}): Vulkan is "${status.vulkan}" under --ozone-platform=wayland — incompatible; expected disabled_off`);
        }
      } catch (err) {
        console.log(`[gpu] feature status unavailable: ${err.message}`);
      }
      // Device/driver details: vendorId 0x10de=NVIDIA / 0x1002=AMD / 0x8086=Intel.
      // glImplementationParts other than (gl=none,angle=none) means a real GL
      // backend is loaded.
      app.getGPUInfo('basic')
        .then((info) => console.log(`[gpu] device info (${when}):`, JSON.stringify(info)))
        .catch((err) => console.log(`[gpu] device info unavailable: ${err.message}`));
    };
    // Confirm which Chromium switches actually reached the browser process.
    // If 'disable-features' here does not contain "Vulkan", the flag is being
    // dropped/clobbered (e.g. by a later --disable-features from the wrapper or
    // zypak — Chromium keeps only the LAST occurrence of a repeated switch).
    // 'ignore-gpu-blocklist' should be false (we removed it).
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

  // Log GPU / utility / renderer process deaths so a mid-playback stall (e.g. a
  // GPU-process reset or audio/video decoder crash) is diagnosable after the
  // fact. `child-process-gone` covers the GPU process and the utility processes
  // (details.name is e.g. 'Audio Service' / 'Video Decoder'); clean exits are
  // skipped to avoid noise. See the [gpu] startup logging in app.whenReady().
  app.on('child-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    console.error('[crash] child-process-gone:', JSON.stringify(details));
  });

  app.on('activate', () => {
    createWindowOnce();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
