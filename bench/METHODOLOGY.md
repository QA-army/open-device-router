# Benchmark methodology

The benchmark answers three questions for each place a session can run:

1. How long until a device is ready to use?
2. How often does it fail to get there?
3. Does the free allowance behave the way the vendor's page says?

Only the first two are measured today, and published only for GitHub-hosted runners. Results are in [RESULTS.md](RESULTS.md), which is generated from the raw files in [results/](results/).

## What is measured

**Cold boot.** Each sample starts from a device that has never been booted.

| Field | iOS Simulator | Android emulator |
| --- | --- | --- |
| `create_ms` | `simctl create` of a new device | Not recorded. The AVD is created once in setup and its data is wiped on every boot |
| `boot_ms` | From calling `simctl bootstatus <udid> -b` until it returns | From spawning `emulator -no-snapshot -wipe-data` until `getprop sys.boot_completed` returns `1`, polled every 500 ms |
| `first_frame_ms` | From the same start until `simctl io screenshot` has written a non-empty file | From the same start until `adb exec-out screencap -p` has returned a non-empty image |
| `teardown_ms` | `simctl shutdown` plus `simctl delete` | `adb emu kill` until the emulator process exits |
| `setup_ms` | Choosing the runtime and device type | Installing the emulator and system image, creating the AVD |

`setup_ms` is reported separately and is never part of `boot_ms`.

**Failed boot.** A sample fails when a step errors, when boot does not complete within 5 minutes, or when the screenshot is empty. Failed samples stay in the file with their error text and count toward the failed-boot rate. They are never dropped or re-run.

**A run where nothing started.** If no sample in a run starts, the run is not published. From the outside, a total outage and a broken harness look the same, so the runner exits with an error, keeps the file as a `rejected-*` workflow artifact for diagnosis, and `npm run bench:check` refuses such a file. This means the published failed-boot rate cannot show a total outage. If one happens, it is recorded by hand in an issue with the rejected file attached.

**Session.** `bench/runners/session.mjs` runs the same lifecycle as `odr run`, through the public SDK, against a fixture app built from source in the same job (`bench/fixtures/`). Timings come from the session receipt, so production and the benchmark report the same fields.

| Field (receipt `timings_ms`) | From | To |
| --- | --- | --- |
| `queue` | `allocate()` called | capacity reserved in the ledger |
| `upload` | reservation | provider has the build (upload-before-allocation providers only) |
| `provider_queue` | provider asked for a device | provider reports the device assigned, where it reports it |
| `allocate` | provider asked for a device | device ready to accept commands |
| `install` | install started | install returned |
| `launch` | launch started | launch returned |
| `first_frame` | launch returned | first screenshot that decodes as a PNG of at least 16x16 and is not one flat colour (32x32 sample grid) |
| `run_to_first_frame` | `allocate()` called | first usable frame. The number QA.army cares about: Run click to first frame of the app |
| `teardown` | release started | release and closure check finished |

Then the session is held for `--hold` seconds with a screenshot every 5 s (`hold.screenshots_ok`, `screenshots_failed`, `max_gap_ms`), the runner taps the centre once and records whether the frame changed (`tap_frame_change`, the fixture changes colour on every tap), and the session is released. A sample counts as OK only when the outcome is `ok` and closure is `verified`.

**Session drop.** The session ended before release: two consecutive heartbeat screenshots failed (`screenshot_lost`) or the provider reported the session gone. Counted in `health.dropped`.

A session file where no sample reached a device is treated like a cold-boot run where nothing started: not published, investigated first.

**Cloud results** run from the same workflow when the provider's key is a repository secret, use the provider's built-in Settings app (no install) with one sample, and are uploaded as artifacts only. They move into `results/` when the provider's `policy.benchmark_publication` allows it and a maintainer approves.

## What is not measured yet

- **Any device cloud in published results.** See above.
- **Observed free-tier limits.** [docs/free-tiers.md](../docs/free-tiers.md) lists what vendors document. Nothing there has been confirmed by using up an allowance.
- **Any device cloud.** The harness has only run on GitHub-hosted runners.
- Network quality, input latency, or rendering correctness.

## Limits of the results so far

- Few runs, five samples per target each. Enough to show the harness works and to give a rough size, not enough to compare anything.
- On the `macos-15` runner image the harness picked the newest installed runtime (iOS 26.2) while the selected Xcode was 16.4. The result file records both. Boot time with a matching Xcode may differ.
- On iOS the screenshot after boot is slow and varies a lot, so `first_frame_ms` is much later than `boot_ms`. Both are reported.
- The first workflow run (45075840572) is not in the results. Its Android job hit a harness bug, fixed in commit `5b5478d`: the emulator could not find the AVD that setup had created, so no sample started. Its iOS samples exist only as a workflow artifact.

## Statistics

- Median uses the mean of the two middle values for an even count.
- p95 uses the nearest-rank method and is shown only from 20 successful samples up. Below that the table says `n < 20`.
- The summary pools every run for the same provider, target, runner label, device, and OS version. The per-run table keeps runs separate.
- Shared runners are noisy. Compare medians across several runs, not single samples.

## How to replicate

Every result file records the repository, commit, runner script, workflow run URL, runner label, runner image version, CPU, memory, tool versions, device type, and OS version.

On GitHub-hosted runners: fork the repository and run the `bench-github-runners` workflow.

On your own machine:

```sh
# macOS with Xcode
node bench/runners/ios-simulator.mjs --samples 5

# Linux with KVM, or macOS, with ANDROID_HOME set
node bench/runners/android-emulator.mjs --samples 5
```

Local runs write to `bench/tmp/out/`, which is ignored by git. `npm run bench:check` rejects result files that do not come from a public CI run with a commit and run URL, so local numbers cannot end up in RESULTS.md.

## Rules for publishing a provider's numbers

A provider's entry in `registry/providers/` records what its terms say about benchmarks (`policy.benchmark_publication`).

| Value | Rule |
| --- | --- |
| `allowed_with_replication` | Publish, with everything needed to replicate. The result file and this page are that record |
| `no_clause_found` | The terms were read and no benchmark clause was found. That is not permission. Send the provider the method and the numbers before publishing and record the date in the pull request |
| `restricted` | Do not publish without the provider's written permission, linked in the pull request |
| `unknown` | Read the terms first and update the entry |

Other rules:

- Results come from runner scripts in this repository, run in public CI, on an account owned by the project or by the person submitting. One account per provider.
- A benchmark run uses the free allowance only. If a run would need paid usage, it does not run.
- Vendors are welcome to submit runs of the same scripts on their own service. Those runs are labelled as vendor-submitted.
- GitHub's terms limit hosted runners to work related to the repository's own software and ask for low burden. Runs here are a handful of samples once a week.

## Corrections

If a number looks wrong, open an issue with the result file name. Result files are not edited. A wrong run is removed in a pull request that says why, and RESULTS.md is regenerated.
