# Taglines and descriptions

Working file. Every line that has been discussed for this project is kept here so none is lost, with a note on whether it can be used yet.

Rules for moving a line to "in use":

- It must be true of what is built, or be clearly a statement of purpose with the pre-release notice next to it.
- A line with a number needs that number in the registry or in committed benchmark results.
- A line that names a tool needs a working, documented integration with that tool.
- No comparisons to another company's product, and no "free forever" promises. Vendors set and change free tiers.

## In use

| Where | Line |
| --- | --- |
| README headline | Give coding agents eyes on real browsers, iOS simulators, and Android phones at $0. |
| Repository description | Give coding agents eyes on real browsers, iOS simulators, and Android phones at $0. Routes sessions to your own free cloud tiers first and stops before any billing. Pre-release. |
| README opener | A coding agent in a Linux sandbox cannot boot an iOS Simulator, cannot open Safari, and has no phone to tap. |

## Ready when the integration ships

| Line | Waiting on |
| --- | --- |
| Browser and mobile session router for Claude Code, Cursor, Playwright, and Appium. Uses your free cloud tiers first and never bills without an explicit budget. | `odr mcp` for agents and `odr proxy` for test suites, each shown working with the named tool. "Explicit budget" needs a budget setting; today there is no paid path at all |
| One router for every browser, simulator, and phone cloud. Free quota first. | "Every" is not true. Usable as "one router for N clouds" once N are routed, with N from the registry |
| Route diffs and test runs to the right browser or device, within your free tier. | Stage 3, the intent router |
| Connect your own accounts once. OpenDeviceRouter routes each session to free capacity first, tells you exactly what is left, and never spends money without a budget you set. | `odr run` and ledger reconciliation. "Exactly" needs the provider's own usage figure, not the local estimate |
| Connect every free tier you're entitled to in 10 minutes, and we track what's left. | A timed, recorded setup on a clean machine |

## Needs a verified number

| Line | What has to be counted |
| --- | --- |
| Give your coding agents instant access to N+ devices. | N distinct device models reachable through connected providers, counted from provider APIs on a stated date. "Instant" needs a measured time-to-ready; say the number instead |
| A device grid for your software factory. | Usable now as a descriptive line. Do not attach a device count until one is measured |

## Category and positioning lines

| Line | Note |
| --- | --- |
| A device grid for your software factory. | Short, concrete, no claim to verify. Good for talks and social posts |
| The open verification grid for coding agents and test runners. | Usable. "Open" refers to the MIT license and the public registry |
| Open verification grid. Connect your device and browser clouds once; route every session to free capacity first. | Usable once `odr run` ships; today routing is a dry run |
| Open verification grid | Category label |
| Device router | Category label. Accurate for stage 1 |
| Any device | Too broad to use alone. Coverage is whatever the connected providers offer |
| Free grid | Avoid as a name or headline. The project is free software; the capacity belongs to vendors and has limits |
| As easy as Google sign-in | A design goal for `odr connect`, not a claim. Signup still involves each provider's own form and terms |
| Every software factory can get as many free minutes as possible each month | Internal goal. In public, say "use the free allowance you already have, on one account per provider" |

## Do not use

- Any line that describes the project as another company's product "for devices".
- "Free minutes forever", "unlimited free devices", or any promise about a vendor's free tier continuing.
- "Zero flake", "fastest", or any ranking without committed results.
- Any line suggesting the tool creates accounts or collects trials for you.

## Name

**OpenDeviceRouter**, command `odr`. Tagline and description options are above; the name itself is settled for this repository.
