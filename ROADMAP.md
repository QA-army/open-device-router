# Roadmap

Everything below the "Built" section is proposed. Dates are not promised. Each item is written as a brief: outcome, non-goals, dependencies, acceptance evidence, owner, release gate.

Owner for every item is QA.army engineering until a named maintainer takes it. Community pull requests are welcome on any item marked **open**.

## Approach

Start with a small number of targets and a public benchmark, not a long list of adapters. A benchmark people can re-run is useful on its own and tells us which providers are worth an adapter.

## Built (stage 0)

- Provider registry with 19 entries, JSON Schema, and policy checks in CI.
- Free-tier index generated from the registry.
- Deterministic routing decision, local ledger, and guided connect as a CLI (`odr providers | show | validate | freshness | free-tiers | connect | status | plan | record`).
- Session lifecycle (v0.1.0): `odr run` and the Node SDK (`allocate`, `withSession`, `attach`) reserve under a lock, allocate, install, launch, wait for the first usable frame, heartbeat with screenshot probes, release on every exit path, verify closure, and write an `odr.receipt/v1`. `odr sweep` cleans up after dead workers.
- Drivers: agent-device (local, GitHub runners, Limrun, Revyl, AWS Device Farm) and the Appetize CLI. Midscene interface adapter.
- Router v2: platform, model, OS range, build format, inputs, keys, parallel caps, device profiles; free-only and budget spend modes.
- Appetize usage reconciliation (`odr reconcile appetize`).
- `odr keys`, `odr doctor`, generated `docs/keys.md`, `llms.txt`.
- Session benchmark runner with fixture apps built from source, and a workflow for GitHub runners plus key-gated cloud jobs.
- Cold-boot benchmark harness for iOS Simulator and Android emulator, with a workflow that runs it on GitHub-hosted runners and commits the raw results. First results were committed on 2026-11-22.
- SimBench (`odr bench`, `simbench/v1`): cold, warm and parallel simulator/emulator sessions to the fixture's first frame on any machine, a share card, self-reported intake through issues, and a weekly matrix across GitHub-hosted runner images. Built 2026-11-23; no published numbers yet.
- Weekly check that opens an issue when entries are older than 45 days.

## Promotion gate

The project is announced once all of these are true:

1. `bench/RESULTS.md` has session results (Run to first frame, verified closure) for iOS and Android on GitHub-hosted runners, from at least three separate runs.
2. At least one free cloud provider has completed a driven session through `odr run` with verified closure, from a public CI run. Its numbers are published only if its terms allow; otherwise the receipt is kept as a CI artifact and the README says the path works without quoting numbers.
3. A new user can go from `git clone` to a driven session in under 10 minutes, shown by a recorded run on a clean machine.
4. `docs/free-tiers.md` has been re-checked within 14 days.

Benchmarks across 4-6 device clouds (item 1.4) make the announcement stronger and do not block it. Until the gate is met the README keeps its pre-release notice.

Benchmark-only posts (amended 2026-11-23): a post about SimBench (`odr bench`) and its results may go out once gates 1, 3 and 4 are met, before gate 2. Such a post presents the benchmark and the measured runners only. It does not announce routing to device clouds or quote any cloud number, and the README keeps its pre-release notice.

## Stage 1: v0.1, deterministic switch and ledger

### 1.1 `odr run` for the first targets (built; per-provider acceptance pending)

- **Outcome:** `odr run --surface ios-simulator --minutes 10 -- <command>` picks a provider, runs `agent-device connect`, runs the caller's command with the session set, disconnects, and debits the ledger with the measured duration.
- **Non-goals:** paid routing, retries on another provider, browser clouds.
- **Dependencies:** agent-device 0.21 or newer; a project-owned account on Limrun, Revyl, and AWS for testing.
- **Acceptance evidence:** a CI job or recorded terminal session per provider showing connect, one snapshot, disconnect, and the ledger entry; unit tests for the ledger debit on success, failure, and interrupt.
- **Release gate:** the session is always disconnected, including on failure and Ctrl-C, verified per provider.

### 1.2 Ledger reconciliation (Appetize built; others need a documented usage API)

- **Outcome:** `odr status --reconcile` reads usage from providers that expose it and shows the difference from the local estimate.
- **Non-goals:** storing credentials; reading provider dashboards through a browser.
- **Dependencies:** a documented usage API or CLI per provider. Unknown for most; research first.
- **Acceptance evidence:** for each supported provider, a recorded comparison of the provider's figure and the ledger after a known session.
- **Release gate:** only documented APIs and CLIs are used.

### 1.3 `odr mcp`

- **Outcome:** a stdio MCP server with three tools: plan a route, read the ledger, list providers. Device actions stay in agent-device's own MCP server.
- **Non-goals:** proxying or wrapping device actions.
- **Dependencies:** 1.1.
- **Acceptance evidence:** a transcript of one coding agent asking for a route and then driving the device through agent-device.
- **Release gate:** tool names and schemas are documented and versioned.

### 1.4 Benchmarks on the first device clouds (**needs accounts**)

- **Outcome:** cold start to first screenshot, failed starts, and teardown for Limrun, Revyl, and AWS Device Farm, in `bench/RESULTS.md`.
- **Non-goals:** paid usage; comparing providers whose terms restrict publication.
- **Dependencies:** one project-owned account per provider; keys as repository secrets; each provider told about the method before publication where its terms have no benchmark clause.
- **Acceptance evidence:** result files from public CI runs; the date each provider was contacted, recorded in the pull request.
- **Release gate:** `policy.benchmark_publication` is not `restricted` or `unknown` for the provider.

### 1.5 Session-survival benchmark (runner built; results pending)

- **Outcome:** hold a session for a fixed time, check it every 30 seconds, and report how many sessions ended early.
- **Non-goals:** measuring app behavior.
- **Dependencies:** none for GitHub-hosted runners; 1.4 for clouds.
- **Acceptance evidence:** result schema version bump, runner script, and results from at least three runs.
- **Release gate:** the definition of a drop is in `bench/METHODOLOGY.md` before any number is published.

### 1.6 Observed free-tier limits

- **Outcome:** for each first target, a dated note of what happened when the allowance ran out: refusal, error code, or automatic billing.
- **Non-goals:** exhausting allowances on accounts the project does not own.
- **Dependencies:** 1.4.
- **Acceptance evidence:** provider response captured at the limit, linked from the registry entry.
- **Release gate:** no charge incurred. If a provider would bill, the test stops one session short and says so.

## Web track

### W1 Pass-through proxy (`odr proxy`)

- **Outcome:** one local endpoint that existing Playwright or WebDriver suites connect to. The proxy picks a connected browser cloud and forwards the connection unchanged.
- **Non-goals:** translating between CDP and WebDriver; stealth or anti-bot features.
- **Dependencies:** signup, credential, and protocol research for each candidate.
- **Acceptance evidence:** an unmodified Playwright test passing through the proxy against two providers.
- **Release gate:** each provider's terms on third-party access have been read and recorded.

### W2 Browser cloud entries and benchmark (**open** for registry research)

- **Outcome:** Hyperbrowser, Kernel, Steel, Browser Use Cloud, and Anchor Browser move from `candidate` to `researched`, then get session-start and failed-start numbers.
- **Non-goals:** task-success or stealth benchmarks, which others already publish (see `docs/prior-art.md`).
- **Dependencies:** W1 for the benchmark; none for registry research.
- **Acceptance evidence:** entries with live-checked signup and credential fields; result files from public CI.
- **Release gate:** as 1.4.

## Stage 2: v0.2, telemetry router

- **Outcome:** among allowances that pass every stage 1 check, prefer the one with the best recent time-to-ready and survival. Retry on another provider when a failure is an infrastructure fault.
- **Non-goals:** sending usage data anywhere by default. Telemetry is local unless the user opts in.
- **Dependencies:** 1.1, 1.4, 1.5.
- **Acceptance evidence:** replay tests showing the same telemetry gives the same decision; a documented rule for telling infrastructure faults from test failures.
- **Release gate:** the stage 1 order is still used when there is no telemetry.

Also in this stage: Python and Go SDKs once the request, session and receipt shapes have been stable for one release. The Node SDK shipped in v0.1.0.

## Stage 3: v1.0, intent router

- **Outcome:** given a git diff or an agent's goal and a budget, propose the smallest set of targets that covers the change, with a reason for each.
- **Non-goals:** deciding which user journeys to test, or judging results. That is outside this project.
- **Dependencies:** stage 2; a labelled set of diffs and the targets a reviewer would pick.
- **Acceptance evidence:** agreement with the reviewer-labelled set, reported with the set's size and how it was built.
- **Release gate:** every proposal still passes the deterministic checks; a model never raises a limit.

## Registry backlog (**open**)

- Read the terms of every `researched` entry and replace `unknown` policy values.
- Research signup and control path for the five `candidate` entries.
- Leads to evaluate, not yet verified: Expo Simulators, NoMac, Mobilebox, Mobilerun, Phone Harness, Argent, Run Cloud, Google Developer Device Platform, Namespace.
- Firebase Test Lab is left out on purpose: Google has announced its shutdown ([migration FAQ](https://firebase.google.com/docs/test-lab/migrate-faq), read 2026-11-22).

## Not planned

- Automated account creation, account rotation, or shared keys. See `docs/account-policy.md`.
- Hosting devices.
- A paid path that spends without a budget the user set in advance. Budget mode is opt-in, capped per session and per month, and off by default.
