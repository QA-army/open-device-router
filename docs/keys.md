# Keys

Generated from `registry/providers/*.yaml` by `npm run docs:keys`. Do not edit by hand.

odr never creates accounts and never stores keys. Each key lives in your shell or your CI secret store.
A person signs up and accepts each provider's terms; an agent can do everything after that.

Fastest path: `odr keys` prints this for the providers you have not connected yet, and `odr doctor` tells you what is missing.

| Provider | Env vars | Free allowance (vendor-documented) | Card | Get a key |
|---|---|---|---|---|
| Appetize | `APPETIZE_API_TOKEN` | 30 minute monthly | unknown | [sign up](https://appetize.io/signup) |
| AWS Device Farm | `AWS_REGION`, `AWS_ROLE_ARN`, `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | 1000 device_minute one_time | yes | [sign up](https://signin.aws.amazon.com/signup?request_type=register) |
| GitHub-hosted runners | none | unlimited | unknown | - |
| Limrun | `LIMRUN_API_KEY`, `LIM_API_KEY` | 120 credit one_time | no | [sign up](https://console.limrun.com/authn/login) |
| Local devices | none | unlimited | unknown | - |
| Revyl | `REVYL_API_KEY` | 1200 device_minute monthly | no | [sign up](https://app.revyl.ai/) |

## Appetize

- Sign up yourself (a person must accept the terms): https://appetize.io/signup
- Steps only a person can do: accept_terms, captcha_possible, email_verification
- Copy the key from: Organization settings > API tokens (admin or developer role)
- Set it locally: `export APPETIZE_API_TOKEN=...`
- Set it for GitHub Actions: `gh secret set APPETIZE_API_TOKEN`
- Record the connection: `odr connect appetize --done`
- Note: The CLI and the REST API use the same token. The REST API sends it as the X-API-KEY header.
- Source: https://docs.appetize.io/account/api-tokens

## AWS Device Farm

- Sign up yourself (a person must accept the terms): https://signin.aws.amazon.com/signup?request_type=register
- Steps only a person can do: accept_terms, email_verification, payment_card, phone_code, captcha_possible
- Set it locally: `export AWS_REGION=...` `export AWS_ROLE_ARN=...` `export AWS_WEB_IDENTITY_TOKEN_FILE=...` `export AWS_ACCESS_KEY_ID=...` `export AWS_SECRET_ACCESS_KEY=...` `export AWS_SESSION_TOKEN=...`
- Set it for GitHub Actions: `gh secret set AWS_REGION` `gh secret set AWS_ROLE_ARN` `gh secret set AWS_WEB_IDENTITY_TOKEN_FILE` `gh secret set AWS_ACCESS_KEY_ID` `gh secret set AWS_SECRET_ACCESS_KEY` `gh secret set AWS_SESSION_TOKEN`
- Record the connection: `odr connect aws-device-farm --done`
- Note: Standard AWS credential chain. Prefer short-lived role credentials over long-lived user keys. A CloudFormation quick-create link that provisions a least-privilege role is proposed and not built.
- Source: https://agent-device.dev/docs/aws-device-farm

## GitHub-hosted runners

- No account or key needed.
- Note: Jobs use the repository's own GITHUB_TOKEN.

## Limrun

- Sign up yourself (a person must accept the terms): https://console.limrun.com/authn/login
- Steps only a person can do: accept_terms
- Log in from a terminal: `lim login`
- Copy the key from: console.limrun.com/settings > API Keys > Create Token
- Set it locally: `export LIMRUN_API_KEY=...` `export LIM_API_KEY=...`
- Set it for GitHub Actions: `gh secret set LIMRUN_API_KEY` `gh secret set LIM_API_KEY`
- Record the connection: `odr connect limrun --done`
- Note: `lim login` finishes in the browser and writes the key to ~/.lim/config.yaml. The lim CLI reads LIM_API_KEY; agent-device reads LIMRUN_API_KEY.
- Source: https://docs.limrun.com/docs/quickstart

## Local devices

- No account or key needed.

## Revyl

- Sign up yourself (a person must accept the terms): https://app.revyl.ai/
- Steps only a person can do: accept_terms
- Log in from a terminal: `revyl auth login`
- Copy the key from: Dashboard > Settings > API Keys > Create key (shown once)
- Set it locally: `export REVYL_API_KEY=...`
- Set it for GitHub Actions: `gh secret set REVYL_API_KEY`
- Record the connection: `odr connect revyl --done`
- Note: `revyl auth login` prints an approval URL and a short code; the browser can be on another machine.
- Source: https://docs.revyl.com/authentication

Other providers in the registry have no session driver yet. See `odr providers`.
