# AGENTS.md

Instructions for coding agents working in this repository.

## Scope

OpenDeviceRouter decides where a browser or mobile session runs. It holds a provider registry, a deterministic router, a local ledger, a thin agent-device adapter, and a benchmark harness. It does not implement device control, host devices, or judge test results. Keep changes inside that scope.

## Sources of truth

| Fact | File |
| --- | --- |
| Provider facts | `registry/providers/<id>.yaml` |
| Entry shape | `schema/provider.schema.json` |
| Rules the schema cannot express | `src/registry/load.ts` |
| Routing order and checks | `src/core/router.ts`, described in `docs/architecture.md` |
| Account rules | `docs/account-policy.md` |
| Benchmark definitions and publishing rules | `bench/METHODOLOGY.md` |
| What is built and what is proposed | `README.md` table, `ROADMAP.md` |

## Commands

```sh
npm install
npm run check            # validate, typecheck, test, generated pages match
npm run docs:free-tiers  # regenerate docs/free-tiers.md after any registry change
npm run bench:summarize  # regenerate bench/RESULTS.md after result files change
npm run odr -- help
```

`npm run check` must pass before you report a change as done.

## Rules

1. **Every provider fact needs a first-party source.** A pricing, docs, or terms page on the vendor's own domain. Set `checked_at` to the date you read it. If the page does not say, write `unknown`. Do not infer.
2. **Never write a number you did not get from a run.** `bench/RESULTS.md` and `docs/free-tiers.md` are generated. Do not edit them. Do not create or edit files in `bench/results/`; only the benchmark workflow writes there.
3. **Never automate account creation.** No code that submits signup forms, accepts terms, solves captchas, enters phone or card details, creates more than one account per provider, or uses disposable identities.
4. **Never handle secret values.** Check that an environment variable is set. Do not read, log, store, or transmit its value. No credentials in the repository, fixtures, or logs.
5. **No paid path.** The router refuses when free capacity is gone. Do not add fallbacks that spend money.
6. **Limits stay deterministic.** Quotas, session caps, spend limits, and capability checks are plain code with tests. No model calls in `src/core/`.
7. **Keep the hands adapter thin.** Device actions belong to agent-device. Do not add tap, swipe, type, or snapshot implementations here.
8. **Say what is built.** If you add something, move it from proposed to built in `README.md` and `ROADMAP.md` in the same change. Do not describe proposed work as working.
9. **Plain claims.** No comparisons between providers without committed result files. No "fastest", "zero flake", or coverage claims.

## Changing a provider entry

1. Edit `registry/providers/<id>.yaml`. The file name must equal `id`.
2. Update `checked_at` and make sure each changed fact's URL is in `sources`.
3. Run `npm run docs:free-tiers`, then `npm run check`.
4. In the pull request, list each changed fact with its URL.

## Changing the router

Add a test in `test/router.test.ts` for the new behavior, including the case where the router must refuse. Update `docs/architecture.md` if the order or the checks change.

## Stop and ask a maintainer before

- Adding a dependency.
- Changing `schema/provider.schema.json` in a way that invalidates existing entries.
- Publishing benchmark numbers for a provider whose `policy.benchmark_publication` is not `allowed_with_replication`.
- Anything that sends data off the user's machine.
- Publishing a package, cutting a release, or changing the license.

## Done means

`npm run check` passes, generated pages are regenerated, the README table is still accurate, and the pull request lists evidence for each changed fact.
