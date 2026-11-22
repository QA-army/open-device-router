# Contributing

Thanks for helping. The registry is only useful if it is right, so corrections are the most valuable contribution.

## Ways to help

- **Fix a provider entry.** A free tier changed, a signup step is wrong, a terms clause is missing.
- **Research a candidate.** Five entries have only their pricing page checked. See the registry backlog in [ROADMAP.md](ROADMAP.md).
- **Propose a provider.** Use the "Propose a provider" issue form.
- **Improve the benchmark.** New measurements and runners are welcome. Read [bench/METHODOLOGY.md](bench/METHODOLOGY.md) first.
- **Pick up a roadmap item** marked open.

## Setup

Node.js 20.19 or newer.

```sh
git clone https://github.com/QA-army/opendevicerouter.git
cd opendevicerouter
npm install
npm run check
```

## Provider entries

One YAML file per provider in `registry/providers/`, checked against `schema/provider.schema.json`.

Evidence rules:

1. Use first-party pages only: the vendor's pricing, docs, or terms. Not blog posts, not comparison sites, not another vendor's page.
2. Every allowance has a `source` URL, and that URL also appears in `sources`.
3. Set `checked_at` to the date you read the pages.
4. If the vendor does not say, write `unknown`. Do not guess, and do not copy a number from memory.
5. Quote terms clauses exactly, with the terms URL and its "last updated" date.
6. For signup fields, say whether you saw the live form (`live_page`) or read docs (`docs`). Look at the form. Do not submit it.
7. If two vendor pages disagree, record both in `notes`.

Status values:

| Status | Meaning |
| --- | --- |
| `candidate` | Pricing page checked. Signup, credentials, and control path not researched |
| `researched` | Signup, credentials, free allowance, and limits checked |
| `launch` | One of the first routed targets. Needs a verified control path, a terms URL, and benchmark terms that are not restrictive |
| `baseline` | Needs no account |

After editing:

```sh
npm run docs:free-tiers
npm run check
```

## Code

- TypeScript, ES modules, Node's built-in test runner. No new dependencies without discussion in an issue.
- The router and ledger are deterministic. New behavior needs a test, including a test for the case where the router refuses.
- The agent-device adapter stays a thin command builder.
- Keep the README "What works today" table accurate in the same pull request.

## Benchmarks

- Do not add or edit files in `bench/results/` by hand. The workflow writes them.
- Do not edit `bench/RESULTS.md`. Run `npm run bench:summarize`.
- A new runner script needs its measurement defined in `bench/METHODOLOGY.md` in the same pull request.
- To add a provider to the benchmark, its entry must record what its terms say about publishing results.

## What will be declined

- Automating account creation, terms acceptance, captcha, phone, or card steps.
- Multiple accounts per provider, disposable emails or phone numbers, shared or pooled keys.
- Code that reads, stores, or transmits credential values.
- A route that spends money without a cap the user set.
- Provider comparisons without committed result files.

## Pull requests

- Small and focused. One provider or one behavior per pull request where possible.
- Fill in the template: what changed, and the evidence.
- If you work for a provider you are editing, say so. Vendor corrections are welcome and are labelled.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contribution is licensed under the MIT License in [LICENSE](LICENSE).
