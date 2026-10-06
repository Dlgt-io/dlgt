import json
import os
import sys
import unittest
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from dlgt_io import Delegate, DelegateError  # noqa: E402

SERVICE_ID = "11111111-2222-3333-4444-555555555555"


def offer(key, batch=None, bindings=(), required=(), funding=None):
    fulfillment = {"kind": "task", "bindings": list(bindings)}
    if batch:
        fulfillment["batch"] = {"count_scope_key": batch}
    return {
        "offer_version_id": f"ov-{key}",
        "state": "active",
        "definition": {
            "offer_key": key,
            "scope": {"required": list(required)},
            "funding": funding or {"kind": "exact"},
            "fulfillment": fulfillment,
        },
    }


SERVICE = {
    "id": SERVICE_ID,
    "title": "Company signals",
    "filesystem_runtime_modes": ["live_workspace_v1"],
    "offer_versions": [
        offer(
            "one",
            bindings=[
                {"scope_key": "section_count", "task_input_key": "section_count"}
            ],
            required=["section_count"],
        ),
        offer("batch", batch="company_count", required=["company_count"]),
    ],
}

QUOTE = {
    "funding": {"kind": "exact"},
    "canonical_scope": {"section_count": 2},
    "resolution": {"total_micros": 300000},
    "pricing_resolution_id": "pr-1",
    "expires_at": "2026-10-05T12:00:00Z",
}

ORDER = {
    "order_id": "o-1",
    "task_group_id": "tg-1",
    "status": "contracted",
    "result": {"job_id": "j-1", "conversation_id": "c-1"},
    "funding_amount_micros": 300000,
}


def reply(payload, status=200, headers=None):
    return status, headers or {}, json.dumps(payload).encode()


class FakeApi(Delegate):
    """Routes "METHOD /path" to a payload, or to fn(body) -> (status, headers, bytes); records calls."""

    def __init__(self, routes):
        super().__init__(api_key="dlg_test", base_url="https://x.test/api")
        self.routes = routes
        self.calls = []

    def _send(self, method, url, headers, data):
        key = f"{method} {urllib.parse.urlsplit(url).path.removeprefix('/api')}"
        body = json.loads(data) if data else None
        self.calls.append({"key": key, "body": body, "headers": headers})
        route = self.routes.get(key)
        if route is None:
            return reply({"detail": f"no route {key}"}, 404)
        return route(body) if callable(route) else reply(route)

    def sent(self, key):
        return next((call["body"] for call in self.calls if call["key"] == key), None)


class HireTest(unittest.TestCase):
    def test_picks_the_single_offer_binds_scope_and_orders_the_signed_quote(self):
        api = FakeApi(
            {
                f"GET /v1/services/{SERVICE_ID}": SERVICE,
                "POST /v1/offers/ov-one/pricing-preview": QUOTE,
                "POST /v1/orders": ORDER,
            }
        )
        hire = api.hire(
            SERVICE_ID,
            input={"domain": "example.com", "section_count": 2},
            max_price_usd=0.5,
        )

        self.assertEqual(
            hire,
            {
                "id": "c-1",
                "job_id": "j-1",
                "order_id": "o-1",
                "task_group_id": "tg-1",
                "status": "contracted",
                "price_usd": 0.3,
            },
        )
        preview = api.sent("POST /v1/offers/ov-one/pricing-preview")
        self.assertEqual(preview["scope"], {"section_count": 2})
        self.assertEqual(
            preview["task"]["input"], {"domain": "example.com", "section_count": 2}
        )
        order = api.sent("POST /v1/orders")
        self.assertEqual(order["schema_version"], 2)
        self.assertEqual(order["pricing_resolution_id"], "pr-1")
        self.assertEqual(order["scope"], QUOTE["canonical_scope"])
        self.assertEqual(order["task"], preview["task"])
        self.assertNotIn("buyer_cap_micros", order)
        self.assertNotIn("idempotency_key", order)
        self.assertEqual(order["execution_context"], {})

    def test_refuses_a_quote_above_the_cap_and_orders_nothing(self):
        api = FakeApi(
            {
                f"GET /v1/services/{SERVICE_ID}": SERVICE,
                "POST /v1/offers/ov-one/pricing-preview": QUOTE,
                "POST /v1/orders": ORDER,
            }
        )
        with self.assertRaises(DelegateError) as caught:
            api.hire(SERVICE_ID, input={"section_count": 2}, max_price_usd=0.1)
        self.assertEqual(caught.exception.code, "price_above_max")
        self.assertIsNone(api.sent("POST /v1/orders"))

    def test_batch_only_buyer_cap_service_wraps_input_and_caps_at_the_offer_maximum(
        self,
    ):
        funding = {
            "kind": "buyer_cap",
            "minimum_cap_micros": 100000,
            "maximum_cap_micros": 2000000,
        }
        capped = {
            **SERVICE,
            "filesystem_runtime_modes": ["snapshot_v1"],
            "file_contract_hash": "fch-1",
            "offer_versions": [
                offer(
                    "batch",
                    batch="company_count",
                    required=["company_count"],
                    funding=funding,
                )
            ],
        }
        api = FakeApi(
            {
                "GET /v1/services/by-key/company-signals": capped,
                "POST /v1/offers/ov-batch/pricing-preview": {
                    **QUOTE,
                    "funding": funding,
                },
                "POST /v1/orders": ORDER,
            }
        )
        api.hire("company-signals", input={"domain": "example.com"}, max_price_usd=5)

        preview = api.sent("POST /v1/offers/ov-batch/pricing-preview")
        self.assertEqual(preview["scope"], {"company_count": 1})
        self.assertEqual(
            preview["task"]["items"],
            [{"custom_id": "1", "input": {"domain": "example.com"}}],
        )
        order = api.sent("POST /v1/orders")
        self.assertEqual(order["buyer_cap_micros"], 2000000)
        self.assertEqual(order["execution_context"], {"file_contract_hash": "fch-1"})

    def test_missing_scope_is_reported_before_quoting(self):
        api = FakeApi({f"GET /v1/services/{SERVICE_ID}": SERVICE})
        with self.assertRaises(DelegateError) as caught:
            api.quote(SERVICE_ID, input={"domain": "example.com"})
        self.assertEqual(caught.exception.code, "missing_scope")
        self.assertIn("section_count", str(caught.exception))
        self.assertEqual(len(api.calls), 1)


class ResultTest(unittest.TestCase):
    def test_maps_conversation_detail_to_a_job_state(self):
        cases = [
            (
                {
                    "conversation": {"status": "delivered"},
                    "jobs": [
                        {"status": "delivered", "result_payload": {"content": "ok"}}
                    ],
                },
                "delivered",
                None,
            ),
            (
                {
                    "conversation": {"status": "delivered"},
                    "jobs": [
                        {
                            "status": "delivered",
                            "result_payload": {
                                "outcome": "failed_provider",
                                "settlement": {"reason": "upstream down"},
                            },
                        }
                    ],
                },
                "failed",
                "upstream down",
            ),
            (
                {
                    "conversation": {"status": "proposed"},
                    "jobs": [{"status": "rejected"}],
                },
                "failed",
                "Job rejected",
            ),
            (
                {
                    "conversation": {"status": "in_progress"},
                    "jobs": [{"status": "in_progress"}],
                    "feedback_requests": [
                        {"status": "pending", "prompt": "Which year?"}
                    ],
                },
                "needs_input",
                None,
            ),
            (
                {
                    "conversation": {"status": "in_progress"},
                    "jobs": [{"status": "in_progress"}],
                },
                "running",
                None,
            ),
        ]
        for detail, state, error in cases:
            view = FakeApi({"GET /v1/conversations/c-1": detail}).result("c-1")
            self.assertEqual((view["state"], view["error"]), (state, error), detail)
        delivered = FakeApi({"GET /v1/conversations/c-1": cases[0][0]}).result("c-1")
        self.assertEqual(delivered["result"], {"content": "ok"})


class RateTest(unittest.TestCase):
    def test_sends_rate_services_over_mcp_for_the_conversations_task_group(self):
        mcp_reply = {
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "content": [
                    {
                        "type": "text",
                        "text": json.dumps({"reviews": [{"status": "saved"}]}),
                    }
                ]
            },
        }
        api = FakeApi(
            {
                "GET /v1/conversations/c-1": {
                    "conversation": {"task_group_id": "tg-1", "service_id": SERVICE_ID}
                },
                "POST /mcp": lambda body: reply(mcp_reply),
            }
        )
        review = api.rate("c-1", quality=5, value=4, note="fast")

        self.assertEqual(review["status"], "saved")
        call = next(c for c in api.calls if c["key"] == "POST /mcp")
        self.assertIn("text/event-stream", call["headers"]["Accept"])
        self.assertEqual(call["body"]["method"], "tools/call")
        self.assertEqual(call["body"]["params"]["name"], "rate_services")
        arguments = call["body"]["params"]["arguments"]
        self.assertEqual(arguments["task_group_id"], "tg-1")
        self.assertEqual(arguments["reviewer_model_name"], "dlgt-sdk")
        entry = dict(arguments["reviews"][0])
        self.assertTrue(entry.pop("submission_id"))
        self.assertEqual(
            entry,
            {
                "service_id": SERVICE_ID,
                "rated_hire_count": 1,
                "quality_rating": 5,
                "value_rating": 4,
                "quality_note": "fast",
            },
        )


class TransportTest(unittest.TestCase):
    def test_download_returns_the_bytes_and_the_servers_filename(self):
        headers = {
            "Content-Type": "text/csv",
            "Content-Disposition": "attachment; filename=\"r_port.csv\"; filename*=UTF-8''r%C3%A9port.csv",
        }
        api = FakeApi(
            {"GET /v1/files/f-1/content": lambda body: (200, headers, b"\x01\x02\x03")}
        )
        file = api.download("delegate-file://f-1")

        self.assertEqual(
            file,
            {
                "filename": "réport.csv",
                "content_type": "text/csv",
                "data": b"\x01\x02\x03",
            },
        )
        self.assertEqual(api.calls[0]["headers"]["Accept"], "*/*")

    def test_api_errors_carry_status_code_and_where_to_fix_them(self):
        api = FakeApi(
            {
                f"GET /v1/services/{SERVICE_ID}": SERVICE,
                "POST /v1/offers/ov-one/pricing-preview": QUOTE,
                "POST /v1/orders": lambda body: reply(
                    {
                        "detail": {
                            "error_type": "insufficient_escrow",
                            "message": "Insufficient escrow balance",
                        }
                    },
                    402,
                ),
            }
        )
        with self.assertRaises(DelegateError) as caught:
            api.hire(SERVICE_ID, input={"section_count": 2}, max_price_usd=1)
        self.assertEqual(
            (caught.exception.status, caught.exception.code),
            (402, "insufficient_escrow"),
        )
        self.assertIn("app.dlgt.io/wallet", str(caught.exception))

    def test_a_missing_api_key_fails_fast_and_says_where_to_get_one(self):
        saved = os.environ.pop("DELEGATE_API_KEY", None)
        try:
            with self.assertRaises(DelegateError) as caught:
                Delegate()
            self.assertEqual(caught.exception.code, "missing_api_key")
            self.assertIn("app.dlgt.io/keys", str(caught.exception))
        finally:
            if saved is not None:
                os.environ["DELEGATE_API_KEY"] = saved


if __name__ == "__main__":
    unittest.main()
