# iOS and Android for coding agents without a Mac

A coding agent running in a Linux sandbox (a cloud agent, a container, a CI job on Ubuntu) cannot boot an iOS Simulator: it needs macOS and Xcode. Android emulators need KVM, which most sandboxes do not expose. This page lists the routes odr knows about, what each costs, and whose account it runs on.

Status: odr 0.1.0, pre-release. "Measured" below means a public CI result in [bench/RESULTS.md](../bench/RESULTS.md). Everything else is labelled.

## Routes, in the order odr tries them

| Route | Where the device runs | Whose account | Cost to you | Status |
| --- | --- | --- | --- | --- |
| Your own Mac or Linux box | `local` provider | none | none | Measured on GitHub runners; your machine: run `odr bench` |
| GitHub-hosted macOS runner | a workflow in your repository | your GitHub account | standard runners are free on public repositories; private repositories use your Actions minutes | Measured (iOS and Android session runs) |
| Revyl, Limrun | the vendor's cloud | your account and your key | each has a free allowance (see [free-tiers.md](free-tiers.md)); vendor-documented, not yet measured by odr | Driver built; no published CI session yet |
| Appetize | the vendor's cloud | your account and your key | free allowance, vendor-documented | Driver built; usage reconciliation built |

odr's router spends capacity in that order: hardware you own, then free public-repo runners, then renewing allowances, then one-time trials. It refuses rather than pick capacity that could bill, unless you pass a budget.

## Keys stay with you

Revyl, Limrun and GitHub's terms restrict giving other parties access to your account (`third_party_access: restricted` in the [registry](../registry/providers/)). So:

- odr never stores, proxies or shares a provider key. Keys are read from your environment at session time ([keys.md](keys.md)).
- An agent should never ask you to paste a key into the conversation. Put it in the environment the agent's tools run in, or in a GitHub Actions secret.
- One account per provider per organisation. odr does not create accounts.

## Give the agent odr over MCP

`odr mcp` is a Model Context Protocol server on stdio. In 0.1.0 it is read-only:

| Tool | What it answers |
| --- | --- |
| `plan_route` | Which provider and device profile a session would use, and why the others were skipped. Reserves nothing. |
| `read_ledger` | Used and remaining free allowance per connected provider (odr's local estimate unless reconciled), and open reservations. |
| `list_providers` | Providers in the registry, their surfaces, free allowance, overage behaviour, and key policy. |

It does not allocate devices. The agent plans with `plan_route`, then runs `odr run` (or the SDK) as a normal command, so device sessions stay visible in your shell and your CI logs.

Until odr is on npm, run it from the repository:

```json
{
  "mcpServers": {
    "odr": {
      "command": "npx",
      "args": ["-y", "github:QA-army/open-device-router", "mcp"]
    }
  }
}
```

Or from a clone: `"command": "node", "args": ["/path/to/open-device-router/dist/cli/index.js", "mcp"]` after `npm install`.

The server was checked with the official MCP Inspector CLI (`tools/list`, `tools/call plan_route`) on 2026-11-23.

## A session from a Linux sandbox, through a GitHub macOS runner

The agent cannot boot the simulator itself, but it can push a branch and read a workflow's artifacts. A minimal workflow in your repository is below. It is a sketch: this exact file has not been run. The tested version of the same steps is this repository's [bench-sessions.yml](../.github/workflows/bench-sessions.yml), iOS job.

```yaml
name: odr-ios-session
on: workflow_dispatch
jobs:
  session:
    runs-on: macos-15
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm i -g github:QA-army/open-device-router agent-device
      - run: odr connect github-actions --done
      - run: xcodebuild -scheme App -sdk iphonesimulator -derivedDataPath build build
      # The first iOS session also builds agent-device's XCTest runner, which takes minutes.
      # bench-sessions.yml does that in an untimed step first (`agent-device prepare ios-runner`).
      - run: >
          odr run --provider github-actions --platform ios --minutes 10 --json
          --build build/Build/Products/Debug-iphonesimulator/App.app > receipt.json
      - uses: actions/upload-artifact@v4
        with: { name: odr-receipt, path: receipt.json }
```

The receipt records the device, timings, and whether closure was verified. On public repositories the standard macOS runner is free; on private repositories it uses your Actions minutes, and GitHub bills macOS minutes at its published rate ([runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)).

## What this does not do

- It does not give an agent a live, interactive simulator over the network. Sessions run where the device is, and the agent reads screenshots and receipts.
- It does not bypass a provider's limits, and it does not pool accounts.
- No cloud provider's session has been published from public CI yet. See [ROADMAP.md](../ROADMAP.md), promotion gate 2.
