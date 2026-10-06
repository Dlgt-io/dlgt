#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { Delegate, DelegateError, VERSION, type JobResult, type Quote } from "@dlgt-io/sdk";

const CONFIG = join(homedir(), ".config", "dlgt", "config.json");
const DEFAULT_BASE_URL = "https://app.dlgt.io/api";

const HELP = `dlgt ${VERSION}: hire AI services on Delegate (https://dlgt.io)

Usage
  dlgt login                                   Save your API key
  dlgt search <query> [--limit N] [--budget USD]
  dlgt service <service>                       Input, offers, price (id or key)
  dlgt quote <service> --input <json|@file>    Exact price; nothing is charged
  dlgt hire <service> --input <json|@file> --max-price USD [--wait] [--timeout S]
  dlgt result <id> [--wait] [--timeout S] [--out DIR]
  dlgt rate <id> --quality 1-5 --value 1-5 [--note TEXT]
  dlgt balance

quote and hire also take --offer <key> and --scope <json>. Search's --budget
ranks cheaper services higher; it doesn't filter. hire --max-price is a hard cap.

Readable output in a terminal; JSON when piped or with --json.

Get started: sign up at https://app.dlgt.io/signup, create an API key at
https://app.dlgt.io/keys, then run dlgt login (or set DELEGATE_API_KEY).`;

function args() {
  return parseArgs({
    allowPositionals: true,
    options: {
      limit: { type: "string" },
      "max-price": { type: "string" },
      budget: { type: "string" },
      input: { type: "string" },
      offer: { type: "string" },
      scope: { type: "string" },
      wait: { type: "boolean" },
      timeout: { type: "string" },
      out: { type: "string" },
      quality: { type: "string" },
      value: { type: "string" },
      note: { type: "string" },
      model: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}

type Values = ReturnType<typeof args>["values"];
type Json = Record<string, any>;

const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: number) => (text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
const bold = paint(1);
const dim = paint(2);
const green = paint(32);
const yellow = paint(33);
const red = paint(31);

async function main(): Promise<void> {
  const { values: v, positionals } = args();
  const [command, arg] = positionals;
  // People get readable text; agents and pipes get JSON.
  const human = Boolean(process.stdout.isTTY) && !v.json;
  const show = <T>(data: T, text: (data: T) => string) => console.log(human ? text(data) : JSON.stringify(data, null, 2));

  if (v.version) return show({ version: VERSION }, () => `dlgt ${VERSION}`);
  if (!command || v.help) return console.log(HELP);
  if (command === "login") return login(human);

  const { dlgt, site, env } = client();
  const waitNote = (id: string) =>
    human && process.stderr.write(dim(`  Waiting for ${id}. Ctrl+C stops waiting; the job keeps running.\n`));

  switch (command) {
    case "search": {
      const found = await dlgt.search(need(arg, "<query>"), { limit: number(v.limit), budgetUsd: number(v.budget) });
      return show(found, renderSearch);
    }
    case "service": {
      const service = await dlgt.service(need(arg, "<service>"));
      return show(service, renderService);
    }
    case "quote": {
      const service = need(arg, "<service>");
      const { raw, ...quote } = await dlgt.quote(service, orderOptions(v));
      return show(quote, (q) => renderQuote(q, service, v.input));
    }
    case "hire": {
      const maxPriceUsd = number(v["max-price"]);
      if (maxPriceUsd === undefined) {
        throw new DelegateError("--max-price is required. See the price first with: dlgt quote", 0, "usage");
      }
      const hire = await dlgt.hire(need(arg, "<service>"), { ...orderOptions(v), maxPriceUsd });
      if (!v.wait || !hire.id) return show(hire, (h) => renderHire(h));
      if (human) console.log(renderHire(hire, true));
      waitNote(hire.id);
      const view = brief(await dlgt.result(hire.id, { timeout: timeout(v) }));
      return show({ ...hire, ...view }, () => renderResult(view, site));
    }
    case "result": {
      const id = need(arg, "<id>");
      if (v.wait) waitNote(id);
      const view = brief(await dlgt.result(id, { timeout: v.wait ? timeout(v) : 0 }));
      if (v.out && view.result) view.saved = await saveFiles(dlgt, view.result, v.out);
      return show(view, (r) => renderResult(r, site));
    }
    case "rate": {
      const review = await dlgt.rate(need(arg, "<id>"), {
        quality: number(need(v.quality, "--quality"))!,
        value: number(need(v.value, "--value"))!,
        note: v.note,
        model: v.model ?? "dlgt-cli",
      });
      return show(review, renderRate);
    }
    case "balance": {
      const balance = await dlgt.balance();
      return show({ balance_usd: balance.balance_micros / 1e6, ...balance }, (b) => renderBalance(b, env, site));
    }
    default:
      throw new DelegateError(`Unknown command "${command}". Run dlgt --help`, 0, "usage");
  }
}

// ---- readable output ----

function renderSearch(found: Json): string {
  const results: Json[] = found.results ?? [];
  if (!results.length) return "\n  No services matched. Try describing the task differently.\n";
  const width = Math.max(24, Math.min(56, (process.stdout.columns ?? 120) - 66));
  const header = dim(`   #  ${"Service".padEnd(width)}  ${"Price".padEnd(9)}  ${"Rating".padEnd(11)}  Id`);
  const rows = results.map((r, i) =>
    [
      `${i + 1}`.padStart(4),
      clip(r.title ?? "", width).padEnd(width),
      (r.price_estimate?.price_display ?? "?").padEnd(9),
      stars(r.quality?.average_rating_hundredths, r.quality?.rating_count).padEnd(11),
      dim(r.service_id),
    ].join("  "),
  );
  return `\n${header}\n${rows.join("\n")}\n\n  ${dim("Details: dlgt service <id>")}\n`;
}

function renderService(s: Json): string {
  const lines = [
    "",
    `  ${bold(s.title)}`,
    `  ${[s.service_key, s.price_estimate?.price_display, stars(s.quality_average_rating, s.quality_rating_count)]
      .filter(Boolean)
      .join(" · ")}`,
  ];
  if (s.description) lines.push("", ...wrap(s.description, 76).map((line) => `  ${line}`));
  const properties: Json = s.input_schema?.properties ?? {};
  const required: string[] = s.input_schema?.required ?? [];
  const names = Object.keys(properties);
  if (names.length) {
    const nameWidth = Math.max(...names.map((name) => name.length));
    lines.push("", `  ${bold("Input")}`);
    for (const name of names) {
      const p = properties[name];
      const kind = p.enum ? p.enum.join(" | ") : (p.type ?? "any");
      const note = required.includes(name) ? "required" : p.default !== undefined ? `default ${JSON.stringify(p.default)}` : "optional";
      lines.push(`    ${name.padEnd(nameWidth)}  ${clip(`${kind}, ${note}`, 28).padEnd(28)}  ${dim(clip(p.description ?? "", 60))}`);
    }
  }
  const offers: Json[] = (s.offer_versions ?? []).filter((o: Json) => o.state === "active");
  if (offers.length > 1) {
    lines.push("", `  ${bold("Offers")} ${dim("(pick one with --offer)")}`);
    for (const o of offers) lines.push(`    ${o.definition.offer_key}  ${dim(o.definition.title ?? "")}`);
  }
  const example = (required.length ? required : names.slice(0, 1)).map((name) => `"${name}": ...`).join(", ");
  lines.push("", `  ${dim(`Price for your input: dlgt quote ${s.service_key ?? s.id} --input '{${example}}'`)}`, "");
  return lines.join("\n");
}

function renderQuote(q: Omit<Quote, "raw">, service: string, input = "{}"): string {
  const capped = q.funding?.kind === "buyer_cap";
  const price = usd(q.priceUsd);
  const terms = capped
    ? `estimate, billed by usage (cap between ${usd(q.funding.minimum_cap_micros / 1e6)} and ${usd(q.funding.maximum_cap_micros / 1e6)})`
    : "fixed price";
  const maxPrice = Math.ceil(q.priceUsd * 100) / 100;
  return [
    "",
    `  ${bold(price)}  ${dim(`${terms} · offer ${q.offerKey}`)}`,
    `  ${dim(`Valid until ${new Date(q.expiresAt).toLocaleTimeString()}`)}`,
    "",
    `  ${dim(`Hire it: dlgt hire ${service} --input '${input}' --max-price ${maxPrice} --wait`)}`,
    "",
  ].join("\n");
}

function renderHire(h: Json, waiting = false): string {
  if (h.status === "awaiting_approval") {
    return `\n  ${yellow("!")} Order ${h.orderId} is waiting for approval: its price is above your approval threshold.\n`;
  }
  const line = `\n  ${green("✓")} Hired for ${usd(h.priceUsd)} · id ${h.id}`;
  return waiting ? line : `${line}\n\n  ${dim(`Result: dlgt result ${h.id} --wait`)}\n`;
}

function renderResult(r: Json, site: string): string {
  const page = `${site}/activity/${r.id}`;
  if (r.state === "running") return `\n  ${yellow("…")} Still running.\n\n  ${dim(`Wait for it: dlgt result ${r.id} --wait`)}\n`;
  if (r.state === "failed") return `\n  ${red("✗")} Failed: ${r.error}\n\n  ${dim(`Details: ${page}`)}\n`;
  if (r.state === "needs_input") {
    const questions = r.questions.map((q: Json) => `    ${q.prompt ?? "(no text)"}${q.choices?.length ? dim(`  [${q.choices.join(" / ")}]`) : ""}`);
    return `\n  ${yellow("?")} The provider has a question:\n${questions.join("\n")}\n\n  Answer it at ${page}\n`;
  }
  const lines = ["", `  ${green("✓")} Delivered`, ""];
  if (r.result?.content) lines.push(...String(r.result.content).split("\n").map((line) => `  ${line}`), "");
  const artifacts = r.result?.artifacts;
  if (artifacts && Object.keys(artifacts).length) {
    const data = outline(artifacts);
    lines.push(...data.slice(0, 40).map((line) => `  ${dim(line)}`));
    if (data.length > 40) lines.push(`  ${dim(`… ${data.length - 40} more lines: dlgt result ${r.id} --json`)}`);
    lines.push("");
  }
  for (const path of r.saved ?? []) lines.push(`  ${green("✓")} Saved ${path}`);
  lines.push(`  ${dim(`Rate it: dlgt rate ${r.id} --quality 1-5 --value 1-5`)}`, "");
  return lines.join("\n");
}

function renderRate(review: Json): string {
  if (review.status === "nothing_pending") return "\n  Nothing to rate: this job is already rated or isn't finished yet.\n";
  return `\n  ${green("✓")} Rating saved: quality ${review.quality_rating}/5, value ${review.value_rating}/5. Thanks!\n`;
}

function renderBalance(b: Json, env: string, site: string): string {
  const note = env === "production" ? "" : dim(` (${env}${b.card_test_mode ? ", test cards" : ""})`);
  return `\n  Balance: ${bold(`$${b.balance_usd.toFixed(2)}`)}${note}\n\n  ${dim(`Top up: ${site}/wallet`)}\n`;
}

/** Money with two decimals, or up to four for sub-cent prices: $0.00, $0.30, $0.0594. */
function usd(amount: number): string {
  return `$${amount.toFixed(4).replace(/(\.\d\d\d?)0+$/, "$1")}`;
}

/** Indented key: value lines for structured results; empty fields are skipped. */
function outline(value: unknown, indent = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (item === null || typeof item !== "object") return [`${indent}- ${item}`];
      const [first = "", ...rest] = outline(item, `${indent}  `);
      return [`${indent}- ${first.trimStart()}`, ...rest];
    });
  }
  if (value === null || typeof value !== "object") return [`${indent}${value}`];
  return Object.entries(value).flatMap(([key, item]) => {
    if (item === null || item === undefined || item === "" || (typeof item === "object" && !Object.keys(item).length)) return [];
    if (typeof item === "object") return [`${indent}${key}:`, ...outline(item, `${indent}  `)];
    return [`${indent}${key}: ${String(item).replace(/\s*\n\s*/g, " ")}`];
  });
}

function stars(hundredths?: number | null, count?: number): string {
  return count && hundredths ? `★ ${(hundredths / 100).toFixed(1)} (${count})` : "new";
}

function clip(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  return line ? [...lines, line] : lines;
}

// ---- auth and config ----

function client() {
  const config = readConfig();
  const apiKey = process.env.DELEGATE_API_KEY || config.api_key;
  if (!apiKey) {
    throw new DelegateError(
      "No API key: run dlgt login or set DELEGATE_API_KEY. Create a key at https://app.dlgt.io/keys",
      0,
      "missing_api_key",
    );
  }
  const baseUrl = process.env.DELEGATE_API_BASE_URL || config.base_url || DEFAULT_BASE_URL;
  return { dlgt: new Delegate({ apiKey, baseUrl }), ...where(baseUrl) };
}

/** The app's address and a readable environment name for an API base URL. */
function where(baseUrl: string) {
  const site = baseUrl.replace(/\/api\/?$/, "");
  const host = new URL(site).host;
  return { site, host, env: host === "app.dlgt.io" ? "production" : host === "dev.dlgt.io" ? "staging" : host };
}

function readConfig(): { api_key?: string; base_url?: string } {
  try {
    return JSON.parse(readFileSync(CONFIG, "utf8"));
  } catch {
    return {};
  }
}

async function login(human: boolean): Promise<void> {
  const baseUrl = process.env.DELEGATE_API_BASE_URL || undefined;
  const { site, host, env } = where(baseUrl ?? DEFAULT_BASE_URL);
  const keysUrl = `${site}/keys`;

  if (process.stdin.isTTY && process.stderr.isTTY) {
    process.stderr.write(
      `\n  Log in to Delegate (${env})\n\n` +
        `  1. Create an API key at ${keysUrl}\n` +
        `  2. Paste it below. Each character shows as •\n\n`,
    );
  }
  const apiKey = (
    await readKey(`  API key (Enter opens ${host}/keys): `, () => {
      openBrowser(keysUrl);
      process.stderr.write(`\n  Opened ${keysUrl}. Paste the key here: `);
    })
  ).trim();
  if (!apiKey.startsWith("dlg_")) {
    throw new DelegateError(`That isn't a Delegate API key (they start with dlg_). Create one at ${keysUrl}`, 0, "usage");
  }

  let balance;
  try {
    balance = await new Delegate({ apiKey, baseUrl }).balance(); // proves the key works before saving it
  } catch (error) {
    if (error instanceof DelegateError && error.status === 401) {
      throw new DelegateError(`${env} rejected that key. Keys only work where they were created: ${keysUrl}`, 401, "invalid_key");
    }
    throw error;
  }
  mkdirSync(dirname(CONFIG), { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG, JSON.stringify({ api_key: apiKey, ...(baseUrl ? { base_url: baseUrl } : {}) }, null, 2) + "\n");
  chmodSync(CONFIG, 0o600);

  const balanceUsd = balance.balance_micros / 1e6;
  if (!human) return console.log(JSON.stringify({ logged_in: env, balance_usd: balanceUsd, saved: CONFIG }, null, 2));
  console.log(
    `\n  ${green("✓")} Logged in to ${env}. Balance: $${balanceUsd.toFixed(2)}\n` +
      `  ${green("✓")} Key saved to ${CONFIG.replace(homedir(), "~")}\n\n` +
      `  ${dim('Next: dlgt search "what you need done"')}\n`,
  );
}

/**
 * Reads the key with a • per character, so a paste visibly lands. Enter on an
 * empty line calls onEmptyEnter (opens the keys page). Piped input
 * (echo "$KEY" | dlgt login) is read as-is.
 */
function readKey(prompt: string, onEmptyEnter: () => void): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    return new Promise((resolve) => {
      let data = "";
      stdin.on("data", (chunk) => (data += chunk)).on("end", () => resolve(data));
    });
  }
  process.stderr.write(prompt);
  return new Promise((resolve) => {
    let key = "";
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
    };
    const onData = (chunk: string) => {
      for (const ch of chunk.replace(/\u001b\[[\d;?]*[~A-Za-z]/g, "")) {
        if (ch === "\u0003" || ch === "\u0004") {
          finish();
          process.exit(130);
        } else if (ch === "\r" || ch === "\n") {
          if (key) {
            finish();
            return resolve(key);
          }
          onEmptyEnter();
        } else if (ch === "\u007f" || ch === "\b") {
          if (key) {
            key = key.slice(0, -1);
            process.stderr.write("\b \b");
          }
        } else if (ch >= " ") {
          key += ch;
          process.stderr.write("•");
        }
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.resume();
  });
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  spawn(command, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

// ---- helpers ----

/** Saves every delegate-file:// the result references into dir. */
async function saveFiles(dlgt: Delegate, result: unknown, dir: string): Promise<string[]> {
  const uris = [...new Set(JSON.stringify(result).match(/delegate-file:\/\/[\w-]+/g) ?? [])];
  mkdirSync(dir, { recursive: true });
  const saved: string[] = [];
  for (const uri of uris) {
    const file = await dlgt.download(uri);
    const path = join(dir, basename(file.filename));
    writeFileSync(path, file.data);
    saved.push(path);
  }
  return saved;
}

function brief(view: JobResult): Omit<JobResult, "raw"> & { saved?: string[] } {
  const { raw, ...rest } = view;
  return rest;
}

function orderOptions(v: Values) {
  return { input: jsonArg(v.input), offer: v.offer, scope: jsonArg(v.scope) };
}

function jsonArg(value: string | undefined) {
  if (value === undefined) return undefined;
  return JSON.parse(value.startsWith("@") ? readFileSync(value.slice(1), "utf8") : value);
}

function timeout(v: Values): number {
  return number(v.timeout) ?? 600;
}

function need(value: string | undefined, name: string): string {
  if (!value) throw new DelegateError(`Missing ${name}. Run dlgt --help`, 0, "usage");
  return value;
}

function number(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new DelegateError(`Not a number: ${value}`, 0, "usage");
  return parsed;
}

main().catch((error) => {
  const detail =
    error instanceof DelegateError
      ? { message: error.message, code: error.code, status: error.status || undefined }
      : { message: String(error?.message ?? error) };
  // People get a sentence; agents and pipes get JSON.
  console.error(process.stderr.isTTY ? `\n  ✗ ${detail.message}\n` : JSON.stringify({ error: detail }, null, 2));
  process.exitCode = 1;
});
