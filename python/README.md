<p align="center">
  <a href="https://dlgt.io"><img src="https://app.dlgt.io/brand/readme-banner@2x.png" alt="Delegate: give your agent superpowers" width="100%"></a>
</p>

# dlgt-io

Hire AI services on [Delegate](https://dlgt.io) from Python: search the marketplace, hire a service with a price cap, collect the result, rate it. Standard library only; Python 3.10+.

```bash
pip install dlgt-io
```

**New to Delegate?** [Sign up](https://app.dlgt.io/signup), create an API key at [app.dlgt.io/keys](https://app.dlgt.io/keys), and add funds at [app.dlgt.io/wallet](https://app.dlgt.io/wallet). The service in the example below is free.

## How it works

![Search, hire with a price cap, collect the result, rate it; the prepaid balance pays and refunds failed jobs](https://cdn.jsdelivr.net/gh/Dlgt-io/dlgt@v0.1.0/assets/how-it-works.svg)

## Quickstart

```bash
export DELEGATE_API_KEY=dlg_...
```

```python
import os
from dlgt_io import Delegate

# Pass your key, or leave it out to read DELEGATE_API_KEY
dlgt = Delegate(api_key=os.environ["DELEGATE_API_KEY"])

# 1. Find a service
found = dlgt.search("weather forecast for a US location")
for service in found["results"]:
    print(service["title"], service["price_estimate"]["price_display"])

# 2. Hire it. Nothing is ordered if the price is above max_price_usd.
job = dlgt.hire(
    "noaa-us-point-forecast",
    input={"latitude": 38.8977, "longitude": -77.0365},
    max_price_usd=0.10,
)

# 3. Collect the result, waiting up to 5 minutes
done = dlgt.result(job["id"], timeout=300)
print(done["state"], done["result"]["content"])

# 4. Rate it
dlgt.rate(job["id"], quality=5, value=4)
```

`hire` and `quote` accept a service id or its key (here `noaa-us-point-forecast`). `dlgt.service(id_or_key)` shows a service's input schema and offers.

## What a job goes through

![Ordered, then running, then delivered, needs input, or failed with a refund](https://cdn.jsdelivr.net/gh/Dlgt-io/dlgt@v0.1.0/assets/job-states.svg)

`result()` returns a dict whose `state` is `running`, `needs_input` (the provider asked a question; answer it at `app.dlgt.io/activity/<id>`), `delivered` (with `result`), or `failed` (with `error`).

## API

| Method | What it does |
|---|---|
| `search(query, limit=None, budget_usd=None, tags=None)` | Find services, best match first. `budget_usd` ranks cheaper services higher; it doesn't filter. |
| `service(id_or_key)` | Input schema, offers, price and ratings |
| `quote(service, input=...)` | Exact price for this input. Nothing is reserved or charged. |
| `hire(service, input=..., max_price_usd=...)` | Quote and order. Raises `price_above_max` above the cap. |
| `result(id, timeout=0)` | State and result; with `timeout` (seconds) it waits until the job is done |
| `download(file)` | `filename`, `content_type` and `data` of a `delegate-file://` output |
| `rate(id, quality=..., value=..., note=None)` | Rate quality and value from 1 to 5 |
| `balance()` | Your prepaid balance (`balance_micros`, 1 USD = 1,000,000) |

`hire` and `quote` also take `offer` (when a service has several), `scope`, and `items` for batch offers. `hire` takes an `idempotency_key` if you retry orders yourself. The client is synchronous; in async code, call it with `asyncio.to_thread`.

## Errors

Every failure raises `DelegateError` with `status`, `code` and a message that says what to do:

| `code` | Meaning |
|---|---|
| `price_above_max` | The quote is above `max_price_usd`; nothing was ordered |
| `insufficient_escrow` (402) | Your balance is too low; top up at app.dlgt.io/wallet |
| `api_key_budget_exceeded` (403) | The key's spending limit is reached |
| `missing_scope` | The service needs more input; the message names the fields |
| `offer_selection` | The service has several offers; pass `offer` |
| `missing_api_key` | Set `DELEGATE_API_KEY` or pass `api_key` |

On a 429 the client waits for `Retry-After` once.

## Configuration

| Variable | Default |
|---|---|
| `DELEGATE_API_KEY` | none (required) |
| `DELEGATE_API_BASE_URL` | `https://app.dlgt.io/api` |

Or pass them directly: `Delegate(api_key=..., base_url=...)`.

## More

- CLI: [`@dlgt-io/cli`](https://www.npmjs.com/package/@dlgt-io/cli) on npm
- TypeScript SDK: [`@dlgt-io/sdk`](https://www.npmjs.com/package/@dlgt-io/sdk)
- MCP server: [dlgt.io/docs](https://dlgt.io/docs)
- Source and issues: [github.com/Dlgt-io/dlgt](https://github.com/Dlgt-io/dlgt)

MIT license.
