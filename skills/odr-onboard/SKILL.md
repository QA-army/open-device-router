---
name: odr-onboard
description: Walk a person through connecting every free device and QA provider in OpenDeviceRouter. Use when they want free device minutes, odr onboard, or every integration connected.
---

# Connect OpenDeviceRouter providers

The person signs up. You do not.

1. Run `odr onboard next --json`.
2. When it is null, run `odr onboard summary --json` and report connected providers, stubs, and `total_metered_minutes`. Stop.
3. Open `signup_url` for them (`odr onboard open <id>` only launches a browser). Tell them the human steps from the JSON. Wait.
4. Do not fill the form, accept terms, solve a captcha, or type a password, card, or phone number. Do not read a key into the chat or the repo.
5. When they say they are done, run `odr onboard verify <id>`. It checks that env vars exist. It must not print values. If it fails, tell them the missing names and wait.
6. Run `odr connect <id> --done`.
7. Repeat from step 1.

`adapter: "stub"` is recorded and is not started by `odr run`. `adapter: "built"` can run when free-only checks pass.

Do not connect Firebase Test Lab. `odr onboard summary` explains why.

AWS Device Farm is built for session create, stop, upload delete, closure, and free-minute reconcile. It will not open a metered session until pixel control is attached. Free-only routing needs a fresh `odr reconcile aws-device-farm`.
