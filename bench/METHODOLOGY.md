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
- iOS session runs 45091307145 and 45094507461 include the build and start of agent-device's iOS XCTest runner in `allocate` and `run_to_first_frame`. The untimed warm-up step called `agent-device prepare` without the `ios-runner` subcommand, failed, and the failure was swallowed. Those numbers overstate what a worker with a prepared runner waits for. From the next run the step fails the job instead, and session result files record `environment.tools.runner_prepared`.
- Android session run 45102486809: sample 1 booted cold (allocate 48.7 s); samples 2 and 3 started from the quick-boot snapshot that sample 1's shutdown saved (allocate 9.6 s and 8.0 s), so they are warm starts. The AVD now sets `fastboot.forceColdBoot=yes`.
- Android session runs before the ATD image change (45094507461 and 45096049615) produced no usable sample: first a frame check that was stricter than this document, then taps blocked by a SystemUI "not responding" dialog. Run 45099915095 tried the aosp_atd image, which returns black screenshots.
- The first workflow run (45075840572) is not in the results. Its Android job hit a harness bug, fixed in commit `5b5478d`: the emulator could not find the AVD that setup had created, so no sample started. Its iOS samples exist only as a workflow artifact.

## SimBench (`odr bench`, schema `simbench/v1`)

A benchmark anyone can run on their own Mac or Linux box with `npx opendevicerouter bench`, and that CI runs weekly on GitHub-hosted runner images (`bench-simbench-matrix`). It drives the platform tools directly (`xcrun simctl`; Android `emulator` and `adb`), not the session SDK, so it needs no agent-device install and measures the machine rather than a driver.

Definitions. Every time is milliseconds from the start of the sample unless the field ends in `_step_ms`, which is the step alone.

| Field | Cold sample (iOS) | Cold sample (Android) | Warm sample |
| --- | --- | --- | --- |
| start | before `simctl create` | before the emulator process starts | before install, on a booted device with the fixture uninstalled (uninstall not timed) |
| `boot_ms` | `simctl bootstatus -b` returned | `sys.boot_completed` is 1 | not recorded |
| `first_screenshot_ms` | first screenshot that is not one flat colour | same | not recorded |
| `run_to_first_frame_ms` | first screenshot where at least half of a 32x32 grid is the fixture's starting red | same | same |
| `tap_to_change_ms` | not measured (simctl has no input) | `adb shell input tap` at the centre until the red share is below 20% | Android only |

- Fixture: the apps in `bench/fixtures/`, built from source on the machine before the first sample. Build time is recorded as `method.fixture_build_excluded_ms` and is not in any sample.
- Cold, iOS: a new simulator per sample, deleted afterwards. Device type is the newest plain "iPhone N" for the runtime unless `--device-type` is given.
- Cold, Android: without `--avd`, odr creates an AVD named `odr-simbench` from the newest installed system image (CI pins `system-images;android-34;google_apis;x86_64`) and starts it with `-wipe-data -no-snapshot-load`. With `--avd`, the user's AVD is started with `-no-snapshot-load -no-snapshot-save` and its data is kept, which is a cold boot of an already set-up device. `method.cold` says which.
- Screenshots are polled every 250 ms, so any frame time can be late by up to one screenshot round trip plus 250 ms.
- Parallel (`--parallel 1,2,4,8`, iOS only in v1): at each level N, N cold samples start at the same time. A level passes when every device reaches the fixture's first frame. Levels run in ascending order. The run stops at the first level where any device fails, or where the median time to first frame exceeds 2x the N=1 median. `max_ok_n` is the highest level that passed both checks. This rule was written before any parallel number was published.
- Cost (CI only): the median cold run to first frame times the runner's published per-minute rate ([GitHub runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing), `actions_macos` $0.062, `actions_linux` $0.006). It is an estimate: GitHub bills whole minutes per job, and public repositories run standard runners at no charge.
- Environment recorded: OS version and build, chip, machine model, CPU count, RAM, Xcode version, power source, how many simulators were already booted, runner label and image. Not recorded: hostname, username, serial number, device UDID. The schema is closed, so a file with extra environment fields fails validation.

Tiers. `bench/RESULTS.md` keeps them in separate tables and never ranks one against another.

| Tier | Where it comes from | Checks |
| --- | --- | --- |
| `ci-verified` | `bench-simbench-matrix` in this repository | schema, summary recomputed from samples, run URL in this repository |
| `self-reported` | a "SimBench result" issue, turned into a pull request by `simbench-intake` and merged by a maintainer | schema, summary recomputed from samples, consent checkbox. Not reproduced |
| `vendor-submitted` | a provider running SimBench on its own service | not accepted yet; needs a published procedure first |

## Statistics

- Median uses the mean of the two middle values for an even count.
- p95 uses the nearest-rank method and is shown only from 20 successful samples up. Below that the table says `n < 20`.
- The summary pools every run for the same provider, target, runner label, device, and OS version. The per-run table keeps runs separate.
- Shared runners are noisy. Compare medians across several runs, not single samples.

## How to replicate

Every result file records the repository, commit, runner script, workflow run URL, runner label, runner image version, CPU, memory, tool versions, device type, and OS version.

On GitHub-hosted runners: fork the repository and run the `bench-github-runners` workflow.

On your own machine, SimBench:

```sh
npx opendevicerouter bench                 # iOS on macOS, Android elsewhere; 3 cold + 3 warm
npx opendevicerouter bench --parallel 1,2,4
npx opendevicerouter bench submit simbench-results/<file>.json   # optional: opens a public issue
```

The older cold-boot runners:

```sh
# macOS with Xcode
node bench/runners/ios-simulator.mjs --samples 5

# Linux with KVM, or macOS, with ANDROID_HOME set
node bench/runners/android-emulator.mjs --samples 5
```

Local runs write to `bench/tmp/out/`, which is ignored by git. `npm run bench:check` rejects cold-boot and session result files that do not come from a public CI run with a commit and run URL, so local numbers from those runners cannot end up in RESULTS.md. SimBench results from your own machine reach RESULTS.md only through a "SimBench result" issue, in the self-reported table.

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
