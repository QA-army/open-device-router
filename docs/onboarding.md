# Onboarding

A coding agent uses this page to connect every provider in the registry. The person signs up. odr never submits a form, never accepts terms, and never reads a credential value.

Machine-readable catalog: `odr onboard --json`, or `import { onboardingCatalog, freeMinuteSummary } from "opendevicerouter/onboard"`.

## Loop

1. `odr onboard next --json`
2. If the result is `null`, stop. Run `odr onboard summary --json` and tell the person which providers are connected, which are stubs, and `total_metered_minutes`.
3. Open `signup_url` (or `odr onboard open <id>`, which only launches the browser). Show the human steps. Stop and wait.
4. The person creates the account, accepts the terms, and puts any key in their own shell or secret store.
5. `odr onboard verify <id>`. It exits 0 when the check passes. It prints names of unset env vars, never values.
6. `odr connect <id> --done`
7. Go back to step 1.

`adapter: "stub"` means the registry entry and this walk exist, and `odr run` will not start a session there. `adapter: "built"` means odr can allocate when the free-only checks pass.

## AWS Device Farm

Built path, against the Device Farm API:

- Set `AWS_DEVICE_FARM_PROJECT_ARN` and a normal AWS credential (profile, access key pair, or web identity). odr checks that one of those is present and does not read it.
- `odr reconcile aws-device-farm` sums metered device minutes on every project (remote-access sessions and automated runs). An open session or a missing meter makes reconcile fail.
- Free-only routing uses that figure for 24 hours. It refuses when the remainder cannot cover the session, rounded up to a whole minute, or when the figure is missing or stale.
- A session uploads an apk or ipa, creates a metered remote-access session, and on every exit stops the session and deletes the upload. Closure is `GetRemoteAccessSession` status `COMPLETED`.
- Pixel control is not attached yet. The driver refuses before `CreateRemoteAccessSession` unless a test (or a future agent-device attach) supplies an interactor, so a metered session is not opened and then abandoned. Live AWS was not called from CI.

`odr run --platform android --kind real` is the real-device surface. `--platform android` alone asks for an emulator.

## Left out

Firebase Test Lab is deprecated and shuts down on 2027-09-30. The replacement requires billing. It is not a signup step. Source: https://firebase.google.com/docs/test-lab/migrate-faq (read 2026-11-26).
