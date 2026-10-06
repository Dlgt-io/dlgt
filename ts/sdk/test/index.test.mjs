import { test } from "node:test";
import assert from "node:assert/strict";
import { Delegate, DelegateError } from "../dist/index.js";

const SERVICE_ID = "11111111-2222-3333-4444-555555555555";

function offer(key, { batch, bindings = [], required = [], funding = { kind: "exact" } } = {}) {
  return {
    offer_version_id: `ov-${key}`,
    state: "active",
    definition: {
      offer_key: key,
      scope: { required },
      funding,
      fulfillment: { kind: "task", bindings, ...(batch ? { batch: { count_scope_key: batch } } : {}) },
    },
  };
}

const SERVICE = {
  id: SERVICE_ID,
  title: "Company signals",
  filesystem_runtime_modes: ["live_workspace_v1"],
  offer_versions: [
    offer("one", {
      bindings: [{ scope_key: "section_count", task_input_key: "section_count" }],
      required: ["section_count"],
    }),
    offer("batch", { batch: "company_count", required: ["company_count"] }),
  ],
};

const QUOTE = {
  funding: { kind: "exact" },
  canonical_scope: { section_count: 2 },
  resolution: { total_micros: 300000 },
  pricing_resolution_id: "pr-1",
  expires_at: "2026-10-05T12:00:00Z",
};

const ORDER = {
  order_id: "o-1",
  task_group_id: "tg-1",
  status: "contracted",
  result: { job_id: "j-1", conversation_id: "c-1" },
  funding_amount_micros: 300000,
};

const reply = (payload, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

// Routes "METHOD /path" to a payload, or to (body) => Response; records every call.
function fakeApi(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    const key = `${init.method} ${new URL(url).pathname.replace(/^\/api/, "")}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ key, body, headers: init.headers });
    const route = routes[key];
    if (route === undefined) return reply({ detail: `no route ${key}` }, 404);
    return typeof route === "function" ? route(body) : reply(route);
  };
  return { calls, client: new Delegate({ apiKey: "dlg_test", baseUrl: "https://x.test/api", fetch }) };
}

const sent = (calls, key) => calls.find((call) => call.key === key)?.body;

test("hire picks the single offer, binds scope from input, orders the signed quote", async () => {
  const { calls, client } = fakeApi({
    [`GET /v1/services/${SERVICE_ID}`]: SERVICE,
    "POST /v1/offers/ov-one/pricing-preview": QUOTE,
    "POST /v1/orders": ORDER,
  });
  const hire = await client.hire(SERVICE_ID, { input: { domain: "example.com", section_count: 2 }, maxPriceUsd: 0.5 });

  assert.deepEqual(hire, {
    id: "c-1",
    jobId: "j-1",
    orderId: "o-1",
    taskGroupId: "tg-1",
    status: "contracted",
    priceUsd: 0.3,
  });
  const preview = sent(calls, "POST /v1/offers/ov-one/pricing-preview");
  assert.deepEqual(preview.scope, { section_count: 2 });
  assert.deepEqual(preview.task.input, { domain: "example.com", section_count: 2 });
  const order = sent(calls, "POST /v1/orders");
  assert.equal(order.schema_version, 2);
  assert.equal(order.pricing_resolution_id, "pr-1");
  assert.deepEqual(order.scope, QUOTE.canonical_scope);
  assert.deepEqual(order.task, preview.task);
  assert.equal(order.buyer_cap_micros, undefined);
  assert.deepEqual(order.execution_context, {});
});

test("hire refuses a quote above maxPriceUsd and orders nothing", async () => {
  const { calls, client } = fakeApi({
    [`GET /v1/services/${SERVICE_ID}`]: SERVICE,
    "POST /v1/offers/ov-one/pricing-preview": QUOTE,
    "POST /v1/orders": ORDER,
  });
  await assert.rejects(
    client.hire(SERVICE_ID, { input: { section_count: 2 }, maxPriceUsd: 0.1 }),
    (error) => error instanceof DelegateError && error.code === "price_above_max",
  );
  assert.equal(sent(calls, "POST /v1/orders"), undefined);
});

test("a batch-only buyer_cap service wraps the input as one item and caps at the offer maximum", async () => {
  const capped = {
    ...SERVICE,
    filesystem_runtime_modes: ["snapshot_v1"],
    file_contract_hash: "fch-1",
    offer_versions: [
      offer("batch", {
        batch: "company_count",
        required: ["company_count"],
        funding: { kind: "buyer_cap", minimum_cap_micros: 100000, maximum_cap_micros: 2000000 },
      }),
    ],
  };
  const { calls, client } = fakeApi({
    "GET /v1/services/by-key/company-signals": capped,
    "POST /v1/offers/ov-batch/pricing-preview": { ...QUOTE, funding: capped.offer_versions[0].definition.funding },
    "POST /v1/orders": ORDER,
  });
  await client.hire("company-signals", { input: { domain: "example.com" }, maxPriceUsd: 5 });

  const preview = sent(calls, "POST /v1/offers/ov-batch/pricing-preview");
  assert.deepEqual(preview.scope, { company_count: 1 });
  assert.deepEqual(preview.task.items, [{ custom_id: "1", input: { domain: "example.com" } }]);
  const order = sent(calls, "POST /v1/orders");
  assert.equal(order.buyer_cap_micros, 2000000);
  assert.deepEqual(order.execution_context, { file_contract_hash: "fch-1" });
});

test("missing scope is reported before quoting", async () => {
  const { calls, client } = fakeApi({ [`GET /v1/services/${SERVICE_ID}`]: SERVICE });
  await assert.rejects(
    client.quote(SERVICE_ID, { input: { domain: "example.com" } }),
    (error) => error.code === "missing_scope" && /section_count/.test(error.message),
  );
  assert.equal(calls.length, 1);
});

test("result maps conversation detail to a job state", async () => {
  const cases = [
    [{ conversation: { status: "delivered" }, jobs: [{ status: "delivered", result_payload: { content: "ok" } }] }, "delivered", null],
    [
      {
        conversation: { status: "delivered" },
        jobs: [{ status: "delivered", result_payload: { outcome: "failed_provider", settlement: { reason: "upstream down" } } }],
      },
      "failed",
      "upstream down",
    ],
    [{ conversation: { status: "proposed" }, jobs: [{ status: "rejected" }] }, "failed", "Job rejected"],
    [
      { conversation: { status: "in_progress" }, jobs: [{ status: "in_progress" }], feedback_requests: [{ status: "pending", prompt: "Which year?" }] },
      "needs_input",
      null,
    ],
    [{ conversation: { status: "in_progress" }, jobs: [{ status: "in_progress" }] }, "running", null],
  ];
  for (const [detail, state, error] of cases) {
    const { client } = fakeApi({ "GET /v1/conversations/c-1": detail });
    const view = await client.result("c-1");
    assert.equal(view.state, state, JSON.stringify(detail));
    assert.equal(view.error, error);
  }
  const { client } = fakeApi({ "GET /v1/conversations/c-1": cases[0][0] });
  assert.deepEqual((await client.result("c-1")).result, { content: "ok" });
});

test("rate sends rate_services over MCP for the conversation's task group", async () => {
  const { calls, client } = fakeApi({
    "GET /v1/conversations/c-1": { conversation: { task_group_id: "tg-1", service_id: SERVICE_ID } },
    "POST /mcp": () =>
      reply({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: JSON.stringify({ reviews: [{ status: "saved", service_id: SERVICE_ID }] }) }] },
      }),
  });
  const review = await client.rate("c-1", { quality: 5, value: 4, note: "fast" });

  assert.equal(review.status, "saved");
  const call = calls.find((c) => c.key === "POST /mcp");
  assert.match(call.headers.accept, /text\/event-stream/);
  assert.equal(call.body.method, "tools/call");
  assert.equal(call.body.params.name, "rate_services");
  const args = call.body.params.arguments;
  assert.equal(args.task_group_id, "tg-1");
  assert.equal(args.reviewer_model_name, "dlgt-sdk");
  const { submission_id, ...entry } = args.reviews[0];
  assert.ok(submission_id);
  assert.deepEqual(entry, {
    service_id: SERVICE_ID,
    rated_hire_count: 1,
    quality_rating: 5,
    value_rating: 4,
    quality_note: "fast",
  });
});

test("download returns the bytes and the server's filename", async () => {
  const { calls, client } = fakeApi({
    "GET /v1/files/f-1/content": () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: {
          "content-type": "text/csv",
          "content-disposition": "attachment; filename=\"r_port.csv\"; filename*=UTF-8''r%C3%A9port.csv",
        },
      }),
  });
  const file = await client.download("delegate-file://f-1");

  assert.equal(file.filename, "réport.csv");
  assert.equal(file.contentType, "text/csv");
  assert.deepEqual([...file.data], [1, 2, 3]);
  assert.equal(calls[0].headers.accept, "*/*");
});

test("API errors carry status, code, and where to fix them", async () => {
  const { client } = fakeApi({
    [`GET /v1/services/${SERVICE_ID}`]: SERVICE,
    "POST /v1/offers/ov-one/pricing-preview": QUOTE,
    "POST /v1/orders": () => reply({ detail: { error_type: "insufficient_escrow", message: "Insufficient escrow balance" } }, 402),
  });
  await assert.rejects(client.hire(SERVICE_ID, { input: { section_count: 2 }, maxPriceUsd: 1 }), (error) => {
    assert.equal(error.status, 402);
    assert.equal(error.code, "insufficient_escrow");
    assert.match(error.message, /app\.dlgt\.io\/wallet/);
    return true;
  });
});

test("a missing API key fails fast and says where to get one", () => {
  delete process.env.DELEGATE_API_KEY;
  assert.throws(() => new Delegate(), (error) => error.code === "missing_api_key" && /app\.dlgt\.io\/keys/.test(error.message));
});
