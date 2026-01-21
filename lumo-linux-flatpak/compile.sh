#!/usr/bin/env bash
set -euo pipefail

# compile-flatpak.sh - User Flatpak build & install script
# Installs as --user by default (per-user, no root)

# ---------- helpers ----------
have() { command -v "$1" >/dev/null 2>&1; }

need_sudo() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    sudo -v
  fi
}

die() { echo "Error: $*" >&2; exit 1; }

apt_install_if_missing() {
  local pkgs=("$@")
  local missing=()
  for p in "${pkgs[@]}"; do
    if ! dpkg -s "$p" >/dev/null 2>&1; then
      missing+=("$p")
    fi
  done
  if ((${#missing[@]} == 0)); then return 0; fi
  need_sudo
  sudo apt-get update -y
  sudo apt-get install -y "${missing[@]}"
}

require_project_root() {
  [[ -f package.json ]] || die "package.json not found. Run from project root."
}

ensure_npm() {
  echo "[0/6] Checking npm…"
  have npm && return 0
  echo "  Installing npm via apt…"
  apt_install_if_missing npm
}

install_deps() {
  echo "[1/6] Installing dependencies…"
  [[ -f package-lock.json ]] && npm ci || npm install
}

ensure_electron_installed() {
  echo "[2/6] Ensuring Electron…"
  [[ -x node_modules/.bin/electron ]] && return 0
  local ELECTRON_VER
  ELECTRON_VER="$(node -p "require('./package.json').devDependencies?.electron || require('./package.json').dependencies?.electron || ''")" || true
  if [[ -n "$ELECTRON_VER" ]]; then
    echo "  Installing electron@$ELECTRON_VER…"
    npm install --save-dev "electron@$ELECTRON_VER"
  else
    echo "  Installing latest electron…"
    npm install --save-dev electron
  fi
}

fix_chrome_sandbox() {
  echo "[3/6] Fixing chrome-sandbox…"
  local SANDBOX_PATH
  SANDBOX_PATH=$(find node_modules -type f -path '*/electron/dist/chrome-sandbox' -print -quit 2>/dev/null || true)
  [[ -n "$SANDBOX_PATH" ]] || die "chrome-sandbox not found."
  echo "  Found: $SANDBOX_PATH"
  need_sudo
  sudo chown root:root "$SANDBOX_PATH"
  sudo chmod 4755 "$SANDBOX_PATH"
}

ensure_flatpak_tools() {
  echo "[4/6] Ensuring flatpak tools…"
  have flatpak && have flatpak-builder && return 0
  echo "  Installing flatpak + flatpak-builder…"
  apt_install_if_missing flatpak flatpak-builder
}

ensure_flathub_remote_user() {
  flatpak remotes --user 2>/dev/null | grep -qw flathub && return 0
  echo "  Adding Flathub remote (user)…"
  flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
}

ensure_electron_builder() {
  echo "[5/6] Ensuring electron-builder…"
  [[ -x node_modules/.bin/electron-builder ]] && return 0
  echo "  Installing electron-builder…"
  npm install --save-dev electron-builder
}

ensure_packagejson_flatpak_config() {
  echo "  Pinning runtimeVersion in package.json…"
  node -e "
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('package.json','utf8'));
p.build = p.build || {};
p.build.flatpak = p.build.flatpak || {};
const fp = p.build.flatpak;
fp.base = fp.base || 'org.electronjs.Electron2.BaseApp';
fp.baseVersion = fp.baseVersion || '25.08';
fp.runtime = fp.runtime || 'org.freedesktop.Platform';
fp.sdk = fp.sdk || 'org.freedesktop.Sdk';
fp.runtimeVersion = fp.runtimeVersion || fp.baseVersion;
p.build.flatpak = fp;
fs.writeFileSync('package.json', JSON.stringify(p,null,2)+'\n');
"
}

get_flatpak_ver() {
  node -p "require('./package.json').build?.flatpak?.runtimeVersion || require('./package.json').build?.flatpak?.baseVersion || '25.08'"
}

preinstall_flatpak_refs_user() {
  local ver="$1"
  ensure_flathub_remote_user
  echo "  Pre-installing refs for $ver (user)…"
  flatpak install --user -y --noninteractive flathub \
    "org.freedesktop.Platform//$ver" \
    "org.freedesktop.Sdk//$ver" \
    "org.electronjs.Electron2.BaseApp//$ver" 2>/dev/null || true
}

build_and_install_flatpak() {
  echo "[6/6] Building & installing user Flatpak…"

  ensure_flatpak_tools
  ensure_electron_builder
  ensure_packagejson_flatpak_config

  local ver
  ver="$(get_flatpak_ver)"
  preinstall_flatpak_refs_user "$ver"

  # Clean previous dist
  rm -rf dist

  echo "Building Flatpak (using system /tmp for intermediates)..."

  # No custom TMPDIR — uses default /tmp
  env DEBUG="@malept/flatpak-bundler" \
    npx electron-builder --linux flatpak

  local FP_PATH
  FP_PATH=$(ls -1t dist/*.flatpak 2>/dev/null | head -n 1)
  [[ -n "$FP_PATH" ]] || die "No .flatpak found in dist/"

  local APP_ID
  APP_ID=$(node -p "require('./package.json').build.appId")

  echo
  echo "Built: $FP_PATH"
  echo "App ID: $APP_ID"

  echo "Installing as user Flatpak..."
  flatpak install --user --noninteractive -y "$FP_PATH" || die "Install failed"

  echo
  echo "Installed successfully as user Flatpak!"
  echo "Run with: flatpak run $APP_ID"
  echo "Verify: flatpak list --user | grep $APP_ID"
}

cleanup_prompt() {
  echo
  read -r -p "Clean build artifacts (node_modules, dist, caches)? [y/N] " cn
  case "${cn:-N}" in
    y|Y|yes|YES)
      echo "Cleaning..."
      rm -rf dist/linux-unpacked node_modules ~/.cache/electron ~/.cache/electron-builder 2>/dev/null || true
      echo "Done."
      ;;
    *) echo "Keeping files." ;;
  esac
}

# ---------- main ----------
require_project_root
ensure_npm
install_deps
ensure_electron_installed
fix_chrome_sandbox
build_and_install_flatpak
cleanup_prompt

echo "Done! Your wrapper is now installed as a per-user Flatpak."