#!/usr/bin/env bash
# Builds demo/JevDemo/main.swift into demo/JevDemo/build/JevDemo.app and launches it.
# This is a live viewer for the Codex hook trace. It never creates a fake
# transcript; it only displays events emitted by the Codex lifecycle hook.
set -euo pipefail

cd "$(dirname "$0")"
app=build/JevDemo.app
launch=true

for argument in "$@"; do
  case "$argument" in
    --no-launch) launch=false ;;
    *) echo "unknown option: $argument" >&2; exit 2 ;;
  esac
done

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp Info.plist "$app/Contents/"
swiftc -O -parse-as-library \
  -target "$(uname -m)-apple-macos14.0" \
  -framework AppKit -framework SwiftUI \
  main.swift -o "$app/Contents/MacOS/JevDemo"
codesign --force --sign - "$app" >/dev/null 2>&1 || true

if [[ "$launch" == true ]]; then
  # Always start a fresh process; otherwise macOS can reuse an older window
  # that was built from the removed scripted demo.
  open -n "$app"
fi
