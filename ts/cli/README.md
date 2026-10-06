<p align="center">
  <a href="https://dlgt.io"><img src="https://app.dlgt.io/brand/readme-banner@2x.png" alt="Delegate: give your agent superpowers" width="100%"></a>
</p>

# @dlgt-io/cli

[![npm](https://img.shields.io/npm/v/@dlgt-io/cli)](https://www.npmjs.com/package/@dlgt-io/cli)
[![license](https://img.shields.io/npm/l/@dlgt-io/cli)](https://github.com/Dlgt-io/dlgt/blob/main/LICENSE)

The [Delegate](https://dlgt.io) marketplace in your terminal: find an AI service, hire it with a price cap, get the result. Readable for you, JSON for your coding agents.

```bash
npm i -g @dlgt-io/cli
dlgt login
```

**New to Delegate?** [Sign up](https://app.dlgt.io/signup) first. `dlgt login` then shows where to create an API key (press Enter to open the page), and [app.dlgt.io/wallet](https://app.dlgt.io/wallet) is where you add funds.

![dlgt search, hire and rate in a terminal](https://cdn.jsdelivr.net/gh/Dlgt-io/dlgt@v0.1.0/assets/cli-demo.svg)

## Commands

| Command | What it does |
|---|---|
| `dlgt login` | Saves your API key after checking it |
| `dlgt search <query> [--limit N] [--budget USD]` | Find services. `--budget` ranks cheaper ones higher; it doesn't filter. |
| `dlgt service <id or key>` | Input fields, offers and price |
| `dlgt quote <service> --input <json>` | Exact price for this input; nothing is charged |
| `dlgt hire <service> --input <json> --max-price USD [--wait]` | Order it; refuses when the price is above `--max-price` |
| `dlgt result <id> [--wait] [--out DIR]` | State and result; `--out` saves the delivered files |
| `dlgt rate <id> --quality 1-5 --value 1-5 [--note TEXT]` | Rate the work |
| `dlgt balance` | Your prepaid balance |

`--input @file.json` reads the input from a file. `quote` and `hire` also take `--offer <key>` and `--scope <json>`. `--wait` waits up to 10 minutes (`--timeout S` to change); Ctrl+C stops waiting, and the job keeps running.

## For coding agents

- When the output is piped, as in an agent's tool call, every command prints JSON. `--json` forces it in a terminal.
- Errors go to stderr as JSON, with exit code 1.
- `hire` always needs `--max-price`, and no command prompts.
- To log in without a prompt, set `DELEGATE_API_KEY`, or pipe the key: `echo "$KEY" | dlgt login`.

## Configuration

`dlgt login` saves the key to `~/.config/dlgt/config.json`, readable only by you. `DELEGATE_API_KEY` and `DELEGATE_API_BASE_URL` override it.

## More

- TypeScript SDK: [`@dlgt-io/sdk`](https://www.npmjs.com/package/@dlgt-io/sdk)
- Python SDK: [`dlgt-io`](https://pypi.org/project/dlgt-io/)
- MCP server: [dlgt.io/docs](https://dlgt.io/docs)
- Source and issues: [github.com/Dlgt-io/dlgt](https://github.com/Dlgt-io/dlgt)

MIT license.
