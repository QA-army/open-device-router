# Prior art

Read on 2026-11-22. Descriptions are of what each source says about itself. Nothing here has been independently tested by this project.

## Device control

- **[agent-device](https://github.com/callstack/agent-device)** (Callstack, MIT). CLI, MCP server, and Node.js client for driving iOS and Android apps, with device-cloud providers for BrowserStack, AWS Device Farm, TestMu AI, Limrun, and Revyl ([device clouds](https://agent-device.dev/docs/device-clouds)). OpenDeviceRouter uses it as the control layer and does not duplicate it. agent-device chooses nothing for you: you tell it which provider to connect. Choosing is the part this project adds.
- **Expo Simulators.** The agent-device docs describe it as a limited-access preview that runs Android emulators and iOS simulators on EAS with its own agent-device daemon ([device clouds](https://agent-device.dev/docs/device-clouds)). Not a registry entry yet.

## Public benchmarks of browser session clouds

Desktop browser clouds already publish comparisons. Most are run by one of the vendors being compared.

- **[Kernel benchmarks](https://www.kernel.sh/benchmarks).** Vendor-run browser creation latency comparison.
- **[Anchor Browser benchmark results](https://llms.anchorbrowser.io/anchor-browser-benchmark-results).** Vendor page that collects third-party results, including BrowserBench and a Browser Use stealth benchmark.
- **[Halluminate BrowserBench](https://github.com/Halluminate/browserbench).** Task-success benchmark across browser providers. The repository is archived and has no license file.

## Public benchmarks of mobile device clouds

- **[Mobilebox benchmarks](https://mobilebox.dev/benchmarks).** Vendor-run, monthly. Reports start time, per-action latency, and cost for its own cloud Android phones and iOS simulators, with raw CSV. Its 8 November 2026 run also covered Limrun, Phone Harness, and an Android emulator on a GitHub-hosted runner.

We have not found a mobile benchmark that is run by a party that does not sell one of the services, covers iOS Simulator, Android emulator, and real devices, and can be re-run by anyone from a public repository. That is the gap the benchmark in [bench/](../bench/) starts on. If one exists, please open an issue.

## What this project does differently

- Results come from scripts in this repository, run in public CI, with the raw files committed.
- The summary page is generated and checked in CI, so a number cannot be typed in.
- A provider's terms are read before its numbers are published. See [bench/METHODOLOGY.md](../bench/METHODOLOGY.md).
- No vendor comparison is claimed until there are numbers for more than one vendor.
