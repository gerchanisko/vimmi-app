#!/usr/bin/env bash
# Vimmi installer for Linux (Ubuntu/Debian, Arch, Fedora, openSUSE and others).
#
#   curl -fsSL https://raw.githubusercontent.com/gerchanisko/vimmi-app/main/install.sh | bash
#
# Options:  --update      install the newest version (same as running it again)
#           --uninstall   remove the app (your notes and settings stay)
#
# What it does: downloads the ready-made app (Vimmi.AppImage) of the newest release from GitHub,
# checks it against the release's SHA256SUMS, unpacks it into ~/.local/opt/vimmi (no FUSE needed)
# and adds Vimmi to your application menu. Everything stays in your home folder; no sudo.
# Updating from Vimmi 0.7 (Electron, built from source) removes the old build and its Node.js.
set -euo pipefail

REPO="gerchanisko/vimmi-app"
# Which version to install: the newest release unless VIMMI_BRANCH names a tag (vX.Y.Z).
TAG="${VIMMI_BRANCH:-}"
DATA_DIR="${VIMMI_DATA_DIR:-$HOME/.local/share/vimmi}"
APP_DIR="$HOME/.local/opt/vimmi"
DESKTOP_FILE="$HOME/.local/share/applications/vimmi.desktop"
ICON_FILE="$HOME/.local/share/icons/hicolor/512x512/apps/vimmi.png"
# Set by the app when it updates itself in the background.
NONINTERACTIVE="${VIMMI_NONINTERACTIVE:-}"
# Tests install from a local folder with Vimmi.AppImage and SHA256SUMS instead of GitHub.
LOCAL_RELEASE="${VIMMI_LOCAL_RELEASE:-}"

bold=$'\e[1m'; dim=$'\e[2m'; green=$'\e[32m'; yellow=$'\e[33m'; red=$'\e[31m'; reset=$'\e[0m'
[ -t 1 ] || { bold=""; dim=""; green=""; yellow=""; red=""; reset=""; }
step() { printf '\n%s==>%s %s%s%s\n' "$green" "$reset" "$bold" "$*" "$reset"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '%s!%s %s\n' "$yellow" "$reset" "$*"; }
die()  { printf '%sChyba:%s %s\n' "$red" "$reset" "$*" >&2; exit 1; }
trap 'printf "%sChyba:%s instalace selhala (řádek %s). Zkus to znovu, případně nahlas problém na https://github.com/gerchanisko/vimmi-app/issues\n" "$red" "$reset" "$LINENO" >&2' ERR

refresh_menus() { command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$(dirname "$DESKTOP_FILE")" 2>/dev/null || true; }

# ---------------------------------------------------------------- platform

case "$(uname -s)" in
  Linux) ;;
  Darwin) die "Aplikace pro macOS zatím není. Na Macu otevři webovou aplikaci: https://gerchanisko.github.io/vimmi-app/" ;;
  *) die "Tento skript je pro Linux. Pro Windows stáhni instalátor z https://github.com/$REPO/releases/latest" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) ;;
  *) die "Pro $(uname -m) zatím není hotová aplikace. Použij webovou aplikaci: https://gerchanisko.github.io/vimmi-app/" ;;
esac
[ "$(id -u)" -ne 0 ] || die "Nespouštěj skript jako root ani přes sudo – Vimmi se instaluje do tvé domovské složky."

# ---------------------------------------------------------------- uninstall

if [ "${1:-}" = "--uninstall" ]; then
  step "Odinstalovávám Vimmi"
  rm -rf "$APP_DIR" "$DESKTOP_FILE" "$ICON_FILE" "$DATA_DIR"
  refresh_menus
  info "Hotovo. Tvoje poznámky (trezor) a nastavení zůstaly."
  exit 0
fi

printf '%sVimmi%s – instalace pro Linux\n' "$bold" "$reset"
for tool in curl sha256sum; do command -v "$tool" >/dev/null 2>&1 || die "Chybí $tool. Nainstaluj ho prosím a spusť skript znovu."; done

# ---------------------------------------------------------------- download

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

step "Stahuji Vimmi"
if [ -n "$LOCAL_RELEASE" ]; then
  cp "$LOCAL_RELEASE/Vimmi.AppImage" "$LOCAL_RELEASE/SHA256SUMS" "$tmp/"
  info "Z místní složky $LOCAL_RELEASE"
else
  if [ -n "$TAG" ]; then base="https://github.com/$REPO/releases/download/$TAG"; else base="https://github.com/$REPO/releases/latest/download"; fi
  curl -fL --progress-bar "$base/Vimmi.AppImage" -o "$tmp/Vimmi.AppImage" || die "Nepodařilo se stáhnout Vimmi ($base)."
  curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" || die "Nepodařilo se stáhnout kontrolní součty."
fi
(cd "$tmp" && grep ' Vimmi.AppImage$' SHA256SUMS | sha256sum -c --quiet -) || die "Kontrolní součet nesouhlasí – stažený soubor je poškozený."
info "Soubor je v pořádku (SHA-256)."

# ---------------------------------------------------------------- install

step "Instaluji"
chmod +x "$tmp/Vimmi.AppImage"
# Unpacking avoids FUSE, which many current distributions no longer install by default.
(cd "$tmp" && ./Vimmi.AppImage --appimage-extract >/dev/null) || die "Nepodařilo se rozbalit aplikaci."
[ -x "$tmp/squashfs-root/AppRun" ] || die "Stažená aplikace je neúplná."

# Vimmi 0.7 (Electron) lived in the same folder; its source and Node.js copy are no longer needed.
rm -rf "$APP_DIR" "$DATA_DIR/source" "$DATA_DIR/node"
mkdir -p "$APP_DIR" "$DATA_DIR"
mv "$tmp/squashfs-root" "$APP_DIR/app"
# A stable launcher: the menu entry and the old app's "restart into the new version" start it.
cat > "$APP_DIR/vimmi" <<'LAUNCHER'
#!/bin/sh
exec "$(dirname "$(readlink -f "$0")")/app/AppRun" "$@"
LAUNCHER
chmod +x "$APP_DIR/vimmi"

icon="$(find "$APP_DIR/app/usr/share/icons" -path '*512x512*' -name '*.png' 2>/dev/null | sort | sed -n 1p)"
[ -n "$icon" ] || icon="$(find "$APP_DIR/app" -maxdepth 1 -name '*.png' | sed -n 1p)"
mkdir -p "$(dirname "$ICON_FILE")" "$(dirname "$DESKTOP_FILE")"
[ -n "$icon" ] && cp "$icon" "$ICON_FILE"
cat > "$DESKTOP_FILE" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Vimmi
GenericName=Poznámky
Comment=Poznámky, úkoly a kalendář s AI asistentem
Exec="$APP_DIR/vimmi" %U
Icon=vimmi
Terminal=false
Categories=Office;TextEditor;
Keywords=notes;poznámky;úkoly;markdown;ai;
StartupWMClass=vimmi
DESKTOP
refresh_menus

version="$(sed -n 's/^X-AppImage-Version=//p' "$APP_DIR"/app/*.desktop 2>/dev/null | sed -n 1p)"
printf '\n%s✓ Vimmi%s je nainstalované.%s\n' "$green$bold" "${version:+ $version}" "$reset"
if [ -z "$NONINTERACTIVE" ]; then
  info "Najdeš ho v nabídce aplikací – odtud si ho můžeš připnout na panel."
  info "Spuštění z terminálu: $APP_DIR/vimmi"
  info "Aktualizuje se samo. Odinstalace: bash install.sh --uninstall"
fi
