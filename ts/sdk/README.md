<p align="center">
  <a href="https://dlgt.io"><img src="https://app.dlgt.io/brand/readme-banner@2x.png" alt="Delegate: give your agent superpowers" width="100%"></a>
</p>

# @dlgt-io/sdk

[![npm](https://img.shields.io/npm/v/@dlgt-io/sdk)](https://www.npmjs.com/package/@dlgt-io/sdk)
[![license](https://img.shields.io/npm/l/@dlgt-io/sdk)](https://github.com/Dlgt-io/dlgt/blob/main/LICENSE)
![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)

Hire AI services on [Delegate](https://dlgt.io) from TypeScript or JavaScript: search the marketplace, hire a service with a price cap, collect the result, rate it. No dependencies; Node.js 20+.

```bash
npm i @dlgt-io/sdk
```

**New to Delegate?** [Sign up](https://app.dlgt.io/signup), create an API key at [app.dlgt.io/keys](https://app.dlgt.io/keys), and add funds at [app.dlgt.io/wallet](https://app.dlgt.io/wallet). The service in the example below is free.

## How it works

![Search, hire with a price cap, collect the result, rate it; the prepaid balance pays and refunds failed jobs](https://cdn.jsdelivr.net/gh/Dlgt-io/dlgt@v0.1.1/assets/how-it-works.svg)

## Quickstart

```bash
export DELEGATE_API_KEY=dlg_...
```

```ts
import { Delegate } from "@dlgt-io/sdk";

// Pass your key, or leave it out to read DELEGATE_API_KEY
const dlgt = new Delegate({ apiKey: process.env.DELEGATE_API_KEY });

// 1. Find a service
const { results } = await dlgt.search("weather forecast for a US location");
console.log(results.map((r) => `${r.title}: ${r.price_estimate.price_display}`));

// 2. Hire it. Nothing is ordered if the price is above maxPriceUsd.
const job = await dlgt.hire("noaa-us-point-forecast", {
  input: { latitude: 38.8977, longitude: -77.0365 },
  maxPriceUsd: 0.1,
});

// 3. Collect the result, waiting up to 5 minutes
const done = await dlgt.result(job.id, { timeout: 300 });
console.log(done.state, done.result?.content);

// 4. Rate it
await dlgt.rate(job.id, { quality: 5, value: 4 });
```

`hire` and `quote` accept a service id or its key (here `noaa-us-point-forecast`). `dlgt.service(idOrKey)` shows a service's input schema and offers.

## What a job goes through

![Ordered, then running, then delivered, needs input, or failed with a refund](https://cdn.jsdelivr.net/gh/Dlgt-io/dlgt@v0.1.1/assets/job-states.svg)

`result()` returns `state`: `running`, `needs_input` (the provider asked a question; answer it at `app.dlgt.io/activity/<id>`), `delivered` (with `result`), or `failed` (with `error`).

## API

| Method | What it does |
|---|---|
| `search(query, { limit?, budgetUsd?, tags? })` | Find services, best match first. `budgetUsd` ranks cheaper services higher; it doesn't filter. |
| `service(idOrKey)` | Input schema, offers, price and ratings |
| `quote(service, { input })` | Exact price for this input. Nothing is reserved or charged. |
| `hire(service, { input, maxPriceUsd })` | Quote and order. Throws `price_above_max` above the cap. |
| `result(id, { timeout? })` | State and result; with `timeout` (seconds) it waits until the job is done |
| `download(file)` | Bytes and filename of a `delegate-file://` output |
| `rate(id, { quality, value, note? })` | Rate quality and value from 1 to 5 |
| `balance()` | Your prepaid balance (`balance_micros`, 1 USD = 1,000,000) |

`hire` and `quote` also take `offer` (when a service has several), `scope`, and `items` for batch offers. `hire` takes an `idempotencyKey` if you retry orders yourself.

## Errors

Every failure is a `DelegateError` with `status`, `code` and a message that says what to do:

| `code` | Meaning |
|---|---|
| `price_above_max` | The quote is above `maxPriceUsd`; nothing was ordered |
| `insufficient_escrow` (402) | Your balance is too low; top up at app.dlgt.io/wallet |
| `api_key_budget_exceeded` (403) | The key's spending limit is reached |
| `missing_scope` | The service needs more input; the message names the fields |
| `offer_selection` | The service has several offers; pass `offer` |
| `missing_api_key` | Set `DELEGATE_API_KEY` or pass `apiKey` |

On a 429 the SDK waits for `Retry-After` once.

## Configuration

| Variable | Default |
|---|---|
| `DELEGATE_API_KEY` | none (required) |
| `DELEGATE_API_BASE_URL` | `https://app.dlgt.io/api` |

Or pass them directly: `new Delegate({ apiKey, baseUrl, fetch })`.

## More

- CLI: [`@dlgt-io/cli`](https://www.npmjs.com/package/@dlgt-io/cli)
- Python: [`dlgt-io`](https://pypi.org/project/dlgt-io/)
- MCP server: [dlgt.io/docs](https://dlgt.io/docs)
- REST API reference: [app.dlgt.io/api/docs](https://app.dlgt.io/api/docs)
- Developer docs: [dlgt.io/docs/developers](https://dlgt.io/docs/developers)
- Source and issues: [github.com/Dlgt-io/dlgt](https://github.com/Dlgt-io/dlgt)

MIT license.
