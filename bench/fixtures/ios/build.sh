#!/usr/bin/env bash
# Builds OdrFixture.app for the iOS Simulator and zips it. Usage: build.sh <out-dir>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$(mkdir -p "${1:-$here/out}" && cd "${1:-$here/out}" && pwd)"
sdk="$(xcrun --sdk iphonesimulator --show-sdk-path)"
arch="$(uname -m)"; [ "$arch" = "arm64" ] || arch=x86_64
app="$out/OdrFixture.app"
rm -rf "$app" && mkdir -p "$app"
xcrun --sdk iphonesimulator swiftc -parse-as-library -O -sdk "$sdk" \
  -target "$arch-apple-ios17.0-simulator" -o "$app/OdrFixture" "$here/OdrFixture.swift"
cp "$here/Info.plist" "$app/Info.plist"
codesign --force --sign - --timestamp=none "$app"
(cd "$out" && rm -f OdrFixture.app.zip && zip -qry OdrFixture.app.zip OdrFixture.app)
echo "$app"
