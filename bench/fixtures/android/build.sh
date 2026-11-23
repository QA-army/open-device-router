#!/usr/bin/env bash
# Builds odr-fixture.apk with the Android SDK on the machine. Usage: build.sh <out-dir>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$(mkdir -p "${1:-$here/out}" && cd "${1:-$here/out}" && pwd)"
sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:?set ANDROID_HOME}}"
bt="$(ls -d "$sdk"/build-tools/* | sort -V | tail -1)"
plat="$(ls -d "$sdk"/platforms/android-* | sort -V | tail -1)"
work="$(mktemp -d)"
javac --release 11 -classpath "$plat/android.jar" -d "$work/classes" $(find "$here/src" -name '*.java')
"$bt/d8" --min-api 26 --lib "$plat/android.jar" --output "$work" $(find "$work/classes" -name '*.class')
"$bt/aapt2" link -o "$work/base.apk" -I "$plat/android.jar" --manifest "$here/AndroidManifest.xml"
(cd "$work" && zip -q -j base.apk classes.dex)
"$bt/zipalign" -f 4 "$work/base.apk" "$work/aligned.apk"
keytool -genkeypair -keystore "$work/debug.jks" -storepass android -keypass android -alias odr \
  -dname "CN=odr fixture" -keyalg RSA -keysize 2048 -validity 30 >/dev/null 2>&1
"$bt/apksigner" sign --ks "$work/debug.jks" --ks-pass pass:android --key-pass pass:android \
  --out "$out/odr-fixture.apk" "$work/aligned.apk"
echo "$out/odr-fixture.apk"
