# Fixture apps

Two tiny apps the session benchmark installs, so install and launch time are measured on a known
build rather than a system app. Both draw a full-screen colour and a tap counter, so the runner can
check that a tap changed the frame.

- `android/build.sh` builds `odr-fixture.apk` (package `dev.odr.fixture`) with the SDK build tools on
  the runner: javac, d8, aapt2, zipalign, apksigner with a throwaway debug key.
- `ios/build.sh` builds `OdrFixture.app` (bundle `dev.odr.fixture`) for the iOS Simulator with swiftc
  and ad-hoc signing, plus `OdrFixture.app.zip` for providers that take a zip.

Both are built in CI from this source. No prebuilt binaries are committed.
