/**
 * Delegate client: search services, hire one with a price cap, collect the
 * result, rate it, read your balance. Zero dependencies; any runtime with fetch.
 *
 * Everything goes through the public REST API except rating, which only exists
 * as the MCP tool `rate_services` - same key, one JSON-RPC POST to /mcp.
 */

export const VERSION = "0.1.0";

const DEFAULT_BASE_URL = "https://app.dlgt.io/api";
const KEYS_URL = "https://app.dlgt.io/keys";
const WALLET_URL = "https://app.dlgt.io/wallet";
const MIN_POLL_MS = 3000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// API payloads are passed through as returned; only SDK-built objects are typed.
type Json = Record<string, any>;

export interface DelegateOptions {
  /** Defaults to the DELEGATE_API_KEY environment variable. */
  apiKey?: string;
  /** Defaults to DELEGATE_API_BASE_URL, then https://app.dlgt.io/api. */
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface OrderOptions {
  /** Task input, matching the service's input schema. */
  input?: Json;
  /** Batch line items; picks the service's batch offer. */
  items?: { customId: string; input: Json }[];
  /** Offer key or offer_version_id, when a service has several. */
  offer?: string;
  /** Commercial scope; derived from input where the offer binds it. */
  scope?: Json;
  title?: string;
  summary?: string;
}

export interface HireOptions extends OrderOptions {
  /** Hard cap: nothing is ordered when the quote is above it. */
  maxPriceUsd: number;
  idempotencyKey?: string;
}

export interface Quote {
  priceUsd: number;
  offerKey: string;
  offerVersionId: string;
  funding: Json;
  expiresAt: string;
  raw: Json;
}

export interface Hire {
  /** Conversation id: pass it to result() and rate(). Null while awaiting approval. */
  id: string | null;
  jobId: string | null;
  orderId: string;
  taskGroupId: string | null;
  status: "contracted" | "awaiting_approval";
  priceUsd: number;
}

export type JobState = "running" | "needs_input" | "delivered" | "failed";

export interface JobResult {
  id: string;
  state: JobState;
  /** The delivered payload (content, artifacts, outcome) once delivered. */
  result: Json | null;
  error: string | null;
  /** Pending questions from the provider; answer them in the dashboard. */
  questions: Json[];
  raw: Json;
}

export interface DownloadedFile {
  filename: string;
  contentType: string;
  data: Uint8Array;
}

export class DelegateError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly code?: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "DelegateError";
  }
}

export class Delegate {
  readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DelegateOptions = {}) {
    const env: Record<string, string | undefined> = (globalThis as any).process?.env ?? {};
    this.apiKey = options.apiKey || env.DELEGATE_API_KEY || "";
    this.baseUrl = (options.baseUrl || env.DELEGATE_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    if (!this.apiKey) {
      throw new DelegateError(
        `No API key: set DELEGATE_API_KEY or pass { apiKey }. Create one at ${KEYS_URL}`,
        0,
        "missing_api_key",
      );
    }
  }

  /** Find services for a task, best match first. budgetUsd ranks services over it lower; it doesn't filter. */
  search(query: string, options: { limit?: number; budgetUsd?: number; tags?: string[] } = {}): Promise<Json> {
    return this.json("POST", "/v1/services/search", {
      query,
      tags: options.tags,
      max_results: options.limit,
      budget: options.budgetUsd === undefined ? undefined : { max_amount_micros: micros(options.budgetUsd) },
    });
  }

  /** Full service details: input schema, offers, price, ratings. Accepts an id or a service key. */
  service(idOrKey: string): Promise<Json> {
    const path = UUID.test(idOrKey) ? idOrKey : `by-key/${encodeURIComponent(idOrKey)}`;
    return this.json("GET", `/v1/services/${path}`);
  }

  /** Exact price for this input. Nothing is reserved or charged. */
  async quote(service: string, options: OrderOptions = {}): Promise<Quote> {
    const { offer, preview } = await this.prepare(service, options);
    return {
      priceUsd: preview.resolution.total_micros / 1e6,
      offerKey: offer.definition.offer_key,
      offerVersionId: offer.offer_version_id,
      funding: preview.funding,
      expiresAt: preview.expires_at,
      raw: preview,
    };
  }

  /** Quote and order in one step. Throws before ordering when the quote is above maxPriceUsd. */
  async hire(service: string, options: HireOptions): Promise<Hire> {
    if (!(options.maxPriceUsd >= 0)) {
      throw new DelegateError("maxPriceUsd is required", 0, "max_price_required");
    }
    const { svc, offer, task, preview } = await this.prepare(service, options);
    const cap = micros(options.maxPriceUsd);
    const total: number = preview.resolution.total_micros;
    if (total > cap) {
      throw new DelegateError(
        `Quoted $${total / 1e6} is above maxPriceUsd $${options.maxPriceUsd}; nothing was ordered`,
        0,
        "price_above_max",
        preview,
      );
    }
    const body: Json = {
      schema_version: 2,
      offer_version_id: offer.offer_version_id,
      scope: preview.canonical_scope,
      task,
      pricing_resolution_id: preview.pricing_resolution_id,
      idempotency_key: options.idempotencyKey,
      execution_context:
        // Snapshot-only services must name the file contract they were quoted against.
        JSON.stringify(svc.filesystem_runtime_modes) === '["snapshot_v1"]'
          ? { file_contract_hash: svc.file_contract_hash }
          : {},
    };
    if (preview.funding.kind === "buyer_cap") {
      body.buyer_cap_micros = Math.min(cap, preview.funding.maximum_cap_micros);
      if (body.buyer_cap_micros < Math.max(total, preview.funding.minimum_cap_micros)) {
        throw new DelegateError(
          `maxPriceUsd is below this offer's minimum cap of $${preview.funding.minimum_cap_micros / 1e6}`,
          0,
          "price_above_max",
          preview,
        );
      }
    }
    const order = await this.json("POST", "/v1/orders", body);
    if (order.status === "rejected" || order.status === "failed") {
      throw new DelegateError(`Order ${order.status}`, 0, `order_${order.status}`, order);
    }
    return {
      id: order.result?.conversation_id ?? null,
      jobId: order.result?.job_id ?? null,
      orderId: order.order_id,
      taskGroupId: order.task_group_id ?? null,
      status: order.status,
      priceUsd: total / 1e6,
    };
  }

  /** Job state and result. With a timeout (seconds), waits until it's no longer running. */
  async result(id: string, options: { timeout?: number } = {}): Promise<JobResult> {
    const deadline = Date.now() + (options.timeout ?? 0) * 1000;
    for (;;) {
      const started = Date.now();
      const wait = Math.min(30, Math.max(0, Math.floor((deadline - started) / 1000)));
      const detail = await this.json("GET", `/v1/conversations/${encodeURIComponent(id)}${wait ? `?wait=${wait}` : ""}`);
      const view = jobView(id, detail);
      if (view.state !== "running" || Date.now() >= deadline) return view;
      await sleep(Math.min(Math.max(0, MIN_POLL_MS - (Date.now() - started)), deadline - Date.now()));
    }
  }

  /** Download a delivered file (a delegate-file:// URI or a file id). */
  async download(file: string): Promise<DownloadedFile> {
    const fileId = file.replace(/^delegate-file:\/\//, "");
    const res = await this.request("GET", `/v1/files/${encodeURIComponent(fileId)}/content`, undefined, "*/*");
    return {
      filename: filenameOf(res.headers.get("content-disposition")) ?? fileId,
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
      data: new Uint8Array(await res.arrayBuffer()),
    };
  }

  /** Rate a finished job's quality and value from 1 to 5. */
  async rate(id: string, rating: { quality: number; value: number; note?: string; model?: string }): Promise<Json> {
    const { conversation } = await this.json("GET", `/v1/conversations/${encodeURIComponent(id)}`);
    const out = await this.mcp("rate_services", {
      task_group_id: conversation.task_group_id,
      reviewer_model_name: rating.model ?? "dlgt-sdk",
      reviews: [
        {
          service_id: conversation.service_id,
          submission_id: globalThis.crypto.randomUUID(),
          rated_hire_count: 1,
          quality_rating: rating.quality,
          value_rating: rating.value,
          quality_note: rating.note,
        },
      ],
    });
    const review = out?.reviews?.[0];
    if (!review || review.status === "error") {
      throw new DelegateError(review?.error?.message ?? "Rating failed", 0, review?.error?.code ?? "rating_failed", out);
    }
    return review;
  }

  /** Prepaid balance: balance_micros, funding_mode. */
  balance(): Promise<Json> {
    return this.json("GET", "/v1/wallet/balance");
  }

  private async prepare(service: string, options: OrderOptions) {
    const svc = await this.service(service);
    const offer = pickOffer(svc, options);
    const fulfillment = offer.definition.fulfillment;
    const input: Json = { ...(options.input ?? {}) };
    // A batch-only service still takes a single input: one item.
    const items = options.items ?? (fulfillment.batch ? [{ customId: "1", input }] : undefined);
    const scope = buildScope(offer.definition, input, items?.length, options.scope);
    const task: Json = {
      title: (options.title ?? svc.title).slice(0, 500),
      summary: (options.summary ?? JSON.stringify(items ?? input)).slice(0, 5000),
      input: items ? {} : input,
    };
    if (items) task.items = items.map((item) => ({ custom_id: item.customId, input: item.input }));
    const preview = await this.json(
      "POST",
      `/v1/offers/${encodeURIComponent(offer.offer_version_id)}/pricing-preview`,
      { scope, task },
    );
    return { svc, offer, task, preview };
  }

  private async mcp(name: string, args: Json): Promise<any> {
    const res = await this.request(
      "POST",
      "/mcp",
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
      "application/json, text/event-stream",
    );
    const message = await res.json();
    if (message.error) {
      throw new DelegateError(message.error.message, res.status, String(message.error.code), message);
    }
    const result = message.result ?? {};
    let payload = result.structuredContent;
    const text = result.content?.find((block: Json) => block.type === "text")?.text;
    if (payload === undefined && typeof text === "string") {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }
    if (result.isError) {
      const detail = typeof payload === "string" ? { message: payload } : (payload?.error ?? payload ?? {});
      throw new DelegateError(detail.message ?? "Tool call failed", res.status, detail.code ?? "tool_error", payload);
    }
    return payload;
  }

  private async json(method: string, path: string, body?: unknown): Promise<any> {
    return (await this.request(method, path, body)).json();
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    accept = "application/json",
    retried = false,
  ): Promise<Response> {
    const res = await this.fetchImpl(this.baseUrl + path, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        accept,
        "user-agent": `dlgt-io-ts/${VERSION}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // Honour Retry-After once. Never hammer: repeated limiter hits get the IP banned.
    const retryAfter = Number(res.headers.get("retry-after"));
    if (res.status === 429 && !retried && retryAfter > 0 && retryAfter <= 30) {
      await sleep(retryAfter * 1000);
      return this.request(method, path, body, accept, true);
    }
    if (!res.ok) throw await errorFrom(res);
    return res;
  }
}

function pickOffer(svc: Json, options: OrderOptions): Json {
  const active: Json[] = (svc.offer_versions ?? []).filter((offer: Json) => offer.state === "active");
  const tasks = active.filter((offer) => offer.definition.fulfillment.kind === "task");
  let candidates: Json[];
  if (options.offer) {
    candidates = active.filter(
      (offer) => offer.offer_version_id === options.offer || offer.definition.offer_key === options.offer,
    );
  } else if (options.items) {
    candidates = tasks.filter((offer) => offer.definition.fulfillment.batch);
  } else {
    const single = tasks.filter((offer) => !offer.definition.fulfillment.batch);
    candidates = single.length ? single : tasks;
  }
  if (candidates.length !== 1) {
    const keys = active.map((offer) => offer.definition.offer_key).join(", ");
    throw new DelegateError(
      keys ? `Choose an offer with { offer }: ${keys}` : "This service has no active offers",
      0,
      "offer_selection",
    );
  }
  if (candidates[0].definition.fulfillment.kind !== "task") {
    throw new DelegateError("Entitlement offers aren't supported yet", 0, "unsupported_offer");
  }
  return candidates[0];
}

/** Scope keys bound to input keys must be equal; fill each side from the other. Mutates input. */
function buildScope(definition: Json, input: Json, itemCount: number | undefined, override: Json = {}): Json {
  const bindings: Json[] = (definition.fulfillment.bindings ?? []).filter((b: Json) => b.task_input_key);
  const scope: Json = {};
  for (const b of bindings) if (b.task_input_key in input) scope[b.scope_key] = input[b.task_input_key];
  const countKey = definition.fulfillment.batch?.count_scope_key;
  if (countKey && itemCount !== undefined) scope[countKey] = itemCount;
  Object.assign(scope, override);
  for (const b of bindings) if (!(b.task_input_key in input) && b.scope_key in scope) input[b.task_input_key] = scope[b.scope_key];
  const missing = (definition.scope?.required ?? []).filter((key: string) => !(key in scope));
  if (missing.length) {
    throw new DelegateError(
      `Missing scope: ${missing.join(", ")}. Pass them in input or in { scope }.`,
      0,
      "missing_scope",
    );
  }
  return scope;
}

function jobView(id: string, detail: Json): JobResult {
  const conversation = detail.conversation ?? {};
  const jobs: Json[] = detail.jobs ?? [];
  const job = jobs[jobs.length - 1] ?? {};
  const payload = job.result_payload && typeof job.result_payload === "object" ? job.result_payload : null;
  const questions = (detail.feedback_requests ?? []).filter((request: Json) => request.status === "pending");
  const view = { id, result: null, error: null, questions, raw: detail };
  if (payload && (job.status === "delivered" || ["delivered", "completed"].includes(conversation.status))) {
    if (payload.outcome === "failed_provider") {
      return { ...view, state: "failed", error: payload.settlement?.reason ?? payload.content ?? "The provider failed" };
    }
    return { ...view, state: "delivered", result: payload };
  }
  if (["rejected", "dispatch_failed"].includes(job.status)) return { ...view, state: "failed", error: `Job ${job.status}` };
  if (conversation.status === "disputed") return { ...view, state: "failed", error: "Disputed" };
  if (questions.length) return { ...view, state: "needs_input" };
  return { ...view, state: "running" };
}

async function errorFrom(res: Response): Promise<DelegateError> {
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep the raw text
  }
  const detail = body?.detail ?? body;
  let code: string | undefined;
  let message: string;
  if (typeof detail === "string") {
    message = detail;
  } else if (Array.isArray(detail)) {
    code = "validation_error";
    message = detail.map((d: Json) => `${(d.loc ?? []).join(".")}: ${d.msg}`).join("; ");
  } else {
    code = detail?.code ?? detail?.error_type;
    message = detail?.message ?? (text || res.statusText);
  }
  if (code === "insufficient_escrow") message += `. Top up at ${WALLET_URL}`;
  return new DelegateError(`${res.status} ${message}`, res.status, code, body);
}

function filenameOf(disposition: string | null): string | undefined {
  const encoded = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) return decodeURIComponent(encoded);
  return disposition?.match(/filename="([^"]+)"/i)?.[1];
}

function micros(usd: number): number {
  return Math.round(usd * 1e6);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
