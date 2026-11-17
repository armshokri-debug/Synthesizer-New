#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if pgrep -x Live >/dev/null; then
  echo 'Please quit Ableton Live, then open this installer again.'
  read -r -p 'Press Enter to close.'
  exit 1
fi
src="$PWD/VST3/SY-1.vst3"
/usr/bin/lipo "$src/Contents/MacOS/SY-1" -verify_arch "$(uname -m)"
/usr/bin/codesign --verify --deep --strict "$src"
backup="$HOME/Library/Application Support/SY-1/Plugin Backups/CPU-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup"
standard="$HOME/Library/Audio/Plug-Ins/VST3/SY-1.vst3"
custom="$HOME/Desktop/SY1-Consolidated.9ZOaEEir/VST3/SY-1.vst3"
for target in "$standard" "$custom"; do
  if [ "$target" = "$custom" ] && [ ! -d "$target" ]; then continue; fi
  label=standard
  if [ "$target" = "$custom" ]; then label=custom; fi
  mkdir -p "$(dirname "$target")"
  stage="$(mktemp -d "$(dirname "$target")/.sy1-stage.XXXXXX")"
  ditto "$src" "$stage/SY-1.vst3"
  xattr -dr com.apple.quarantine "$stage/SY-1.vst3" 2>/dev/null || true
  codesign --verify --deep --strict "$stage/SY-1.vst3"
  if [ -e "$target" ]; then mv "$target" "$backup/$label.vst3"; fi
  if ! mv "$stage/SY-1.vst3" "$target"; then
    if [ -d "$backup/$label.vst3" ]; then mv "$backup/$label.vst3" "$target"; fi
    exit 1
  fi
  rmdir "$stage"
done
printf 'Installed. Backups:\n%s\nOpen Ableton and test your existing project.\n' "$backup"
read -r -p 'Press Enter to close.'
