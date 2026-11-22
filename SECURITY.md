# Security

## Reporting a vulnerability

Use GitHub's private reporting: the **Security** tab of this repository, then **Report a vulnerability**. Please do not open a public issue.

Include what you found, how to reproduce it, and what an attacker could do with it.

## What matters most here

- Anything that causes `odr` to read, log, store, or transmit a credential value.
- Anything that routes a session to a paid allowance or past a recorded limit.
- Anything that lets a registry entry or result file run code.

## What this project stores

`odr` writes one file, `state.json`, under `~/.opendevicerouter` or `$ODR_HOME`. It holds connection dates and usage events. It holds no credentials.

## Supported versions

The project is pre-release. Fixes land on `main`.
