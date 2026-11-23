#!/usr/bin/env bash
# Installs the Rust desktop beta (Tauri) for the current user, next to the normal Vimmi:
# ~/.local/bin/vimmi-beta and an app menu entry "Vimmi Beta". Run after: npx tauri build --no-bundle
set -euo pipefail
cd "$(dirname "$0")/.."
bin="src-tauri/target/release/vimmi-beta"
[ -x "$bin" ] || { echo "Nejdřív sestav betu: npx tauri build --no-bundle" >&2; exit 1; }
install -Dm755 "$bin" "$HOME/.local/bin/vimmi-beta"
install -Dm644 src-tauri/icons/icon.png "$HOME/.local/share/icons/hicolor/512x512/apps/vimmi-beta.png"
mkdir -p "$HOME/.local/share/applications"
cat > "$HOME/.local/share/applications/vimmi-beta.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Vimmi Beta
GenericName=Poznámky a úkoly
Comment=Vimmi přepsané do Rustu (Tauri) – testovací verze
Exec=$HOME/.local/bin/vimmi-beta
Icon=vimmi-beta
Terminal=false
Categories=Office;Utility;
StartupWMClass=vimmi-beta
DESKTOP
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
echo "Vimmi Beta je nainstalovaná: najdeš ji v menu aplikací jako „Vimmi Beta“."
