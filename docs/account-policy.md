# Account policy

OpenDeviceRouter routes sessions to accounts you already own. It is not a way to collect free trials.

## Rules

1. **Bring your own account.** You sign up with each provider yourself, under your own name or your organization's.
2. **One account per provider per organization.** Every registry entry sets `max_accounts_per_org: 1` and the schema rejects any other value.
3. **A person does the human steps.** Accepting terms, solving a captcha, entering a phone code, and adding a payment card are done by the account owner. `odr` does not automate them and contributions that do will be declined.
4. **No account creation by the tool.** `odr connect` prints the signup link and a checklist. It does not submit signup forms.
5. **No rotation, no disposable identities.** No throwaway emails, no virtual phone numbers, no new account when a trial ends.
6. **No pooled or shared keys.** The project does not hold provider credentials for users and does not offer a shared key.
7. **Free only by default, and stop at the limit.** In `free-only` mode the router refuses when an allowance is used up, when overage behavior is unknown, or when the allowance bills and has not been reconciled with the provider in the last 24 hours. Paid capacity is used only with an explicit per-session budget (`--budget-usd`) and the connection's monthly cap (`--max-usd-month`).
8. **Credentials stay where you keep them.** `odr` checks that an environment variable is set and passes it, through the environment, to the provider's own CLI or SDK. It does not write it to disk, log it, put it in a receipt, or send it anywhere other than that provider.
9. **Follow each provider's terms.** Where an entry records a restriction, such as no third-party access or no public benchmarks, the tool and the project follow it.

## What an agent may do

A coding agent can read a provider entry, tell you which fields a signup needs, fill in values it can derive from the repository such as a project name, run a device-code login command so you can approve it in your browser, and check that the credential is set.

A coding agent does not create the account, accept terms for you, or supply an email, phone number, or card.

## Limits of the ledger

The ledger counts sessions odr ran (and manual `odr record` debits), with reservations taken under a file lock so parallel workers cannot spend the same minutes. It is still an estimate unless reconciled: `odr reconcile <id>` pulls the provider's own figure where a usage API exists (Appetize today). The provider's own meter is the authority. Some providers move an account to paid billing automatically when a trial limit is passed; the entry's notes say so where the vendor documents it. Where a provider offers a spend cap or a no-overage setting, turn it on.

## Why these rules

Several providers' terms prohibit creating multiple accounts, signing up on behalf of someone else, or giving third parties access. The registry quotes the clauses it has found, with links, under each entry's `policy`. Entries marked `unknown` have not been read for these clauses yet. Nothing in this repository is legal advice.
