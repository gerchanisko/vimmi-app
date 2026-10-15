#!/usr/bin/env bash
# Vimmi installer for Linux (Ubuntu/Debian, Arch, Fedora, openSUSE and others).
#
#   curl -fsSL https://raw.githubusercontent.com/gerchanisko/vimmi-app/main/install.sh | bash
#
# Options:  --update      pull the latest version and reinstall (same as running it again)
#           --uninstall   remove the app (your notes and settings stay)
#
# What it does: makes sure git and Node.js 22+ are available (Node is downloaded just for Vimmi
# if the system one is missing or too old), fetches the source, builds the app, and adds Vimmi
# to your application menu. Everything goes into your home folder; sudo is only used to install
# missing system packages and, on Ubuntu 24.04+, an AppArmor profile Electron apps need.
set -euo pipefail

REPO_URL="${VIMMI_REPO:-https://github.com/gerchanisko/vimmi-app.git}"
# Which version to install: the newest release (tested on CI) unless VIMMI_BRANCH says otherwise.
BRANCH="${VIMMI_BRANCH:-}"
DATA_DIR="${VIMMI_DATA_DIR:-$HOME/.local/share/vimmi}"
SRC_DIR="$DATA_DIR/source"
NODE_DIR="$DATA_DIR/node"
APP_DIR="$HOME/.local/opt/vimmi"
DESKTOP_FILE="$HOME/.local/share/applications/vimmi.desktop"
ICON_FILE="$HOME/.local/share/icons/hicolor/512x512/apps/vimmi.png"
APPARMOR_PROFILE="/etc/apparmor.d/vimmi"
NODE_MIN=22
# Set by the app when it updates itself in the background: never wait for a sudo password.
NONINTERACTIVE="${VIMMI_NONINTERACTIVE:-}"

bold=$'\e[1m'; dim=$'\e[2m'; green=$'\e[32m'; yellow=$'\e[33m'; red=$'\e[31m'; reset=$'\e[0m'
[ -t 1 ] || { bold=""; dim=""; green=""; yellow=""; red=""; reset=""; }
step() { printf '\n%s==>%s %s%s%s\n' "$green" "$reset" "$bold" "$*" "$reset"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '%s!%s %s\n' "$yellow" "$reset" "$*"; }
die()  { printf '%sChyba:%s %s\n' "$red" "$reset" "$*" >&2; exit 1; }
trap 'printf "%sChyba:%s instalace selhala (řádek %s). Zkus to znovu, případně nahlas problém na https://github.com/gerchanisko/vimmi-app/issues\n" "$red" "$reset" "$LINENO" >&2' ERR

# ---------------------------------------------------------------- platform

case "$(uname -s)" in
  Linux) ;;
  Darwin) die "macOS zatím není podporovaný – připravujeme. Sleduj https://github.com/gerchanisko/vimmi-app" ;;
  *) die "Tento skript je pro Linux. Verze pro Windows a macOS připravujeme." ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) NODE_ARCH="x64" ;;
  aarch64 | arm64) NODE_ARCH="arm64" ;;
  *) die "Nepodporovaná architektura: $(uname -m) (podporováno: x86_64, arm64)." ;;
esac

[ "$(id -u)" -ne 0 ] || die "Nespouštěj skript jako root ani přes sudo – Vimmi se instaluje do tvé domovské složky."

DISTRO_ID="unknown"; DISTRO_LIKE=""; DISTRO_NAME="Linux"
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  DISTRO_ID="${ID:-unknown}"; DISTRO_LIKE="${ID_LIKE:-}"; DISTRO_NAME="${PRETTY_NAME:-$DISTRO_ID}"
fi

PKG=""
if command -v apt-get >/dev/null 2>&1; then PKG="apt"
elif command -v pacman >/dev/null 2>&1; then PKG="pacman"
elif command -v dnf >/dev/null 2>&1; then PKG="dnf"
elif command -v zypper >/dev/null 2>&1; then PKG="zypper"
fi

SUDO=""
if command -v sudo >/dev/null 2>&1; then SUDO="sudo"; elif command -v doas >/dev/null 2>&1; then SUDO="doas"; fi

pkg_install() {
  [ $# -gt 0 ] || return 0
  [ -z "$NONINTERACTIVE" ] || die "Chybí systémové balíčky ($*). Spusť instalaci jednou ručně v terminálu."
  [ -n "$PKG" ] || die "Nainstaluj prosím ručně: $* (nepoznal jsem správce balíčků)."
  [ -n "$SUDO" ] || die "Chybí sudo. Nainstaluj prosím ručně: $*"
  info "Instaluji systémové balíčky: $* ${dim}(může se zeptat na heslo)${reset}"
  case "$PKG" in
    apt) $SUDO apt-get update -qq && $SUDO apt-get install -y -qq "$@" ;;
    pacman) $SUDO pacman -S --needed --noconfirm "$@" ;;
    dnf) $SUDO dnf install -y -q "$@" ;;
    zypper) $SUDO zypper --non-interactive install "$@" ;;
  esac
}

# ---------------------------------------------------------------- uninstall

if [ "${1:-}" = "--uninstall" ]; then
  step "Odinstalovávám Vimmi"
  rm -rf "$APP_DIR" "$DESKTOP_FILE" "$ICON_FILE" "$DATA_DIR"
  if [ -f "$APPARMOR_PROFILE" ] && [ -n "$SUDO" ]; then
    $SUDO apparmor_parser -R "$APPARMOR_PROFILE" 2>/dev/null || true
    $SUDO rm -f "$APPARMOR_PROFILE"
  fi
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(dirname "$DESKTOP_FILE")" 2>/dev/null || true
  info "Hotovo. Tvoje poznámky (trezor) a nastavení (~/.config/Vimmi) zůstaly."
  exit 0
fi

printf '%sVimmi%s – instalace pro %s\n' "$bold" "$reset" "$DISTRO_NAME"

# ---------------------------------------------------------------- tools

step "Kontroluji potřebné nástroje"
missing=()
command -v git >/dev/null 2>&1 || missing+=(git)
command -v curl >/dev/null 2>&1 || missing+=(curl)
command -v tar >/dev/null 2>&1 || missing+=(tar)
command -v xz >/dev/null 2>&1 || case "$PKG" in apt) missing+=(xz-utils) ;; *) missing+=(xz) ;; esac
if [ ${#missing[@]} -gt 0 ]; then
  pkg_install "${missing[@]}"
else
  info "git, curl, tar, xz: v pořádku"
fi

# ---------------------------------------------------------------- Node.js

node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

step "Kontroluji Node.js (potřeba $NODE_MIN+)"
if [ -x "$NODE_DIR/bin/node" ] && [ "$(node_major "$NODE_DIR/bin/node")" -ge "$NODE_MIN" ]; then
  export PATH="$NODE_DIR/bin:$PATH"
  info "Používám Node.js pro Vimmi: $(node -v)"
elif command -v node >/dev/null 2>&1 && [ "$(node_major node)" -ge "$NODE_MIN" ] && command -v npm >/dev/null 2>&1; then
  info "Používám systémový Node.js: $(node -v)"
else
  info "Systémový Node.js chybí nebo je starý – stáhnu oficiální Node.js jen pro Vimmi (bez zásahu do systému)."
  index="$(curl -fsSL https://nodejs.org/dist/index.json)" || die "Nepodařilo se stáhnout seznam verzí Node.js."
  # First LTS release in the index is the newest LTS.
  # sed (not head) takes the first match: head would close the pipe early and, with pipefail, abort the script.
  version="$(printf '%s' "$index" | grep -o '"version":"v[0-9.]*"[^}]*"lts":"[A-Za-z]*"' | sed -n '1s/^"version":"\(v[0-9.]*\)".*/\1/p')"
  [ -n "$version" ] || die "Nepodařilo se zjistit aktuální verzi Node.js LTS."
  file="node-$version-linux-$NODE_ARCH.tar.xz"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  info "Stahuji $file"
  curl -fsSL "https://nodejs.org/dist/$version/$file" -o "$tmp/$file"
  curl -fsSL "https://nodejs.org/dist/$version/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c --quiet -) || die "Kontrolní součet Node.js nesouhlasí – stahování je poškozené."
  rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
  tar -xJf "$tmp/$file" -C "$NODE_DIR" --strip-components=1
  export PATH="$NODE_DIR/bin:$PATH"
  info "Node.js $(node -v) připraven v $NODE_DIR"
fi

# ---------------------------------------------------------------- source

step "Stahuji Vimmi"
script_dir=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
if [ -n "$script_dir" ] && [ -f "$script_dir/package.json" ] && grep -q '"name": "vimmi"' "$script_dir/package.json"; then
  BUILD_DIR="$script_dir"
  info "Používám zdrojáky ze složky $BUILD_DIR"
else
  if [ -z "$BRANCH" ]; then
    # Newest release tag (vX.Y.Z); main only if there is no release yet.
    BRANCH="$( { git ls-remote --tags --refs --sort=-v:refname "$REPO_URL" 'v*' || true; } | awk '!done { sub(".*refs/tags/", ""); print; done = 1 }')"
    BRANCH="${BRANCH:-main}"
  fi
  BUILD_DIR="$SRC_DIR"
  if [ -d "$SRC_DIR/.git" ]; then
    git -C "$SRC_DIR" fetch --quiet --depth 1 origin "$BRANCH"
    git -C "$SRC_DIR" reset --quiet --hard FETCH_HEAD
    git -C "$SRC_DIR" clean --quiet -fdx -e node_modules
  else
    mkdir -p "$(dirname "$SRC_DIR")"
    git clone --quiet --depth 1 --branch "$BRANCH" "$REPO_URL" "$SRC_DIR"
  fi
  info "Verze $BRANCH ($(git -C "$SRC_DIR" log -1 --format='%h'))"
fi

# ---------------------------------------------------------------- build & install

step "Instaluji závislosti (může chvíli trvat)"
cd "$BUILD_DIR"
npm ci --no-audit --no-fund --loglevel=error

step "Sestavuji a instaluji aplikaci"
npm run --silent install-desktop

# ---------------------------------------------------------------- system integration

# Ubuntu 24.04+ restricts unprivileged user namespaces, which Electron's sandbox needs.
# The recommended fix is a small AppArmor profile for the app binary.
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = "1" ] && [ ! -f "$APPARMOR_PROFILE" ]; then
  step "Povoluji sandbox Electronu (AppArmor, Ubuntu 24.04+)"
  if [ -n "$NONINTERACTIVE" ]; then
    warn "AppArmor profil chybí – spusť instalaci jednou ručně v terminálu."
  elif [ -n "$SUDO" ] && command -v apparmor_parser >/dev/null 2>&1; then
    profile="abi <abi/4.0>,
include <tunables/global>

profile vimmi \"$APP_DIR/vimmi\" flags=(unconfined) {
  userns,
  include if exists <local/vimmi>
}"
    printf '%s\n' "$profile" | $SUDO tee "$APPARMOR_PROFILE" >/dev/null
    $SUDO apparmor_parser -r "$APPARMOR_PROFILE"
    info "Profil nainstalován: $APPARMOR_PROFILE"
  else
    warn "Nepodařilo se přidat AppArmor profil. Kdyby se Vimmi nespustilo, spusť ho s parametrem --no-sandbox."
  fi
fi

# Report shared libraries Electron needs but the system lacks (rare on desktop installs).
missing_libs="$(ldd "$APP_DIR/vimmi" 2>/dev/null | awk '/not found/ {print $1}' | sort -u | tr '\n' ' ')"
if [ -n "$missing_libs" ] && [ -z "$NONINTERACTIVE" ]; then
  step "Doinstalovávám knihovny, které Electron potřebuje"
  info "Chybí: $missing_libs"
  case "$PKG" in
    apt)
      asound="libasound2"; apt-cache show libasound2t64 >/dev/null 2>&1 && asound="libasound2t64"
      pkg_install libnss3 libgtk-3-0 libgbm1 libxss1 libxshmfence1 libatk-bridge2.0-0 "$asound" ;;
    pacman) pkg_install nss gtk3 mesa libxss alsa-lib ;;
    dnf) pkg_install nss gtk3 mesa-libgbm libXScrnSaver alsa-lib ;;
    zypper) pkg_install mozilla-nss gtk3-tools libgbm1 libXss1 alsa ;;
    *) warn "Nainstaluj prosím ručně knihovny: $missing_libs" ;;
  esac
fi

printf '\n%s✓ Vimmi je nainstalované.%s\n' "$green$bold" "$reset"
info "Najdeš ho v nabídce aplikací – odtud si ho můžeš připnout na panel."
info "Spuštění z terminálu: $APP_DIR/vimmi"
info "Aktualizace: spusť tento skript znovu. Odinstalace: bash install.sh --uninstall"
