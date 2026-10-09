"""Delegate client: search services, hire one with a price cap, collect the
result, rate it, read your balance. Standard library only.

Everything goes through the public REST API except rating, which only exists
as the MCP tool ``rate_services``: same key, one JSON-RPC POST to /mcp.
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any

__version__ = "0.1.1"
__all__ = ["Delegate", "DelegateError", "__version__"]

DEFAULT_BASE_URL = "https://app.dlgt.io/api"
KEYS_URL = "https://app.dlgt.io/keys"
WALLET_URL = "https://app.dlgt.io/wallet"
MIN_POLL_SECONDS = 3.0
_UUID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I
)


class DelegateError(Exception):
    """Any failure: an API error (status, code) or a refused request (code only)."""

    def __init__(
        self, message: str, status: int = 0, code: str | None = None, body: Any = None
    ):
        super().__init__(message)
        self.status = status
        self.code = code
        self.body = body


class Delegate:
    def __init__(
        self,
        api_key: str | None = None,
        base_url: str | None = None,
        timeout: float = 60.0,
    ):
        """api_key defaults to DELEGATE_API_KEY; base_url to DELEGATE_API_BASE_URL, then app.dlgt.io."""
        self.api_key = api_key or os.environ.get("DELEGATE_API_KEY", "")
        self.base_url = (
            base_url or os.environ.get("DELEGATE_API_BASE_URL") or DEFAULT_BASE_URL
        ).rstrip("/")
        self.timeout = timeout
        if not self.api_key:
            raise DelegateError(
                f"No API key: set DELEGATE_API_KEY or pass api_key=. Create one at {KEYS_URL}",
                code="missing_api_key",
            )

    def search(
        self,
        query: str,
        limit: int | None = None,
        budget_usd: float | None = None,
        tags: list[str] | None = None,
    ) -> dict[str, Any]:
        """Find services for a task, best match first. budget_usd ranks services over it lower; it doesn't filter."""
        budget = (
            None if budget_usd is None else {"max_amount_micros": _micros(budget_usd)}
        )
        return self._json(
            "POST",
            "/v1/services/search",
            {"query": query, "tags": tags, "max_results": limit, "budget": budget},
        )

    def service(self, id_or_key: str) -> dict[str, Any]:
        """Full service details: input schema, offers, price, ratings. Accepts an id or a service key."""
        path = id_or_key if _UUID.match(id_or_key) else f"by-key/{_q(id_or_key)}"
        return self._json("GET", f"/v1/services/{path}")

    def quote(
        self,
        service: str,
        input: dict[str, Any] | None = None,
        items: list[dict[str, Any]] | None = None,
        offer: str | None = None,
        scope: dict[str, Any] | None = None,
        title: str | None = None,
        summary: str | None = None,
    ) -> dict[str, Any]:
        """Exact price for this input. Nothing is reserved or charged."""
        _, offer_version, _, preview = self._prepare(
            service, input, items, offer, scope, title, summary
        )
        return {
            "price_usd": preview["resolution"]["total_micros"] / 1e6,
            "offer_key": offer_version["definition"]["offer_key"],
            "offer_version_id": offer_version["offer_version_id"],
            "funding": preview["funding"],
            "expires_at": preview["expires_at"],
            "raw": preview,
        }

    def hire(
        self,
        service: str,
        *,
        max_price_usd: float,
        input: dict[str, Any] | None = None,
        items: list[dict[str, Any]] | None = None,
        offer: str | None = None,
        scope: dict[str, Any] | None = None,
        title: str | None = None,
        summary: str | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Quote and order in one step. Raises before ordering when the quote is above max_price_usd."""
        if max_price_usd is None or max_price_usd < 0:
            raise DelegateError("max_price_usd is required", code="max_price_required")
        svc, offer_version, task, preview = self._prepare(
            service, input, items, offer, scope, title, summary
        )
        cap = _micros(max_price_usd)
        total = preview["resolution"]["total_micros"]
        if total > cap:
            raise DelegateError(
                f"Quoted ${total / 1e6} is above max_price_usd ${max_price_usd}; nothing was ordered",
                code="price_above_max",
                body=preview,
            )
        # Snapshot-only services must name the file contract they were quoted against.
        snapshot_only = svc.get("filesystem_runtime_modes") == ["snapshot_v1"]
        body: dict[str, Any] = {
            "schema_version": 2,
            "offer_version_id": offer_version["offer_version_id"],
            "scope": preview["canonical_scope"],
            "task": task,
            "pricing_resolution_id": preview["pricing_resolution_id"],
            "idempotency_key": idempotency_key,
            "execution_context": (
                {"file_contract_hash": svc.get("file_contract_hash")}
                if snapshot_only
                else {}
            ),
        }
        funding = preview["funding"]
        if funding["kind"] == "buyer_cap":
            body["buyer_cap_micros"] = min(cap, funding["maximum_cap_micros"])
            if body["buyer_cap_micros"] < max(total, funding["minimum_cap_micros"]):
                raise DelegateError(
                    f"max_price_usd is below this offer's minimum cap of ${funding['minimum_cap_micros'] / 1e6}",
                    code="price_above_max",
                    body=preview,
                )
        order = self._json("POST", "/v1/orders", body)
        if order["status"] in ("rejected", "failed"):
            raise DelegateError(
                f"Order {order['status']}", code=f"order_{order['status']}", body=order
            )
        result = order.get("result") or {}
        return {
            "id": result.get("conversation_id"),
            "job_id": result.get("job_id"),
            "order_id": order["order_id"],
            "task_group_id": order.get("task_group_id"),
            "status": order["status"],
            "price_usd": total / 1e6,
        }

    def result(self, id: str, timeout: float = 0) -> dict[str, Any]:
        """Job state and result. With a timeout (seconds), waits until it's no longer running."""
        deadline = time.monotonic() + timeout
        while True:
            started = time.monotonic()
            wait = min(30, max(0, int(deadline - started)))
            detail = self._json(
                "GET", f"/v1/conversations/{_q(id)}" + (f"?wait={wait}" if wait else "")
            )
            view = _job_view(id, detail)
            if view["state"] != "running" or time.monotonic() >= deadline:
                return view
            elapsed = time.monotonic() - started
            time.sleep(
                max(0.0, min(MIN_POLL_SECONDS - elapsed, deadline - time.monotonic()))
            )

    def download(self, file: str) -> dict[str, Any]:
        """Download a delivered file (a delegate-file:// URI or a file id): filename, content_type, data."""
        file_id = file.removeprefix("delegate-file://")
        headers, data = self._request(
            "GET", f"/v1/files/{_q(file_id)}/content", accept="*/*"
        )
        return {
            "filename": _filename_of(headers.get("Content-Disposition")) or file_id,
            "content_type": headers.get("Content-Type") or "application/octet-stream",
            "data": data,
        }

    def rate(
        self,
        id: str,
        *,
        quality: int,
        value: int,
        note: str | None = None,
        model: str | None = None,
    ) -> dict[str, Any]:
        """Rate a finished job's quality and value from 1 to 5."""
        conversation = self._json("GET", f"/v1/conversations/{_q(id)}")["conversation"]
        out = self._mcp(
            "rate_services",
            {
                "task_group_id": conversation.get("task_group_id"),
                "reviewer_model_name": model or "dlgt-sdk",
                "reviews": [
                    {
                        "service_id": conversation.get("service_id"),
                        "submission_id": str(uuid.uuid4()),
                        "rated_hire_count": 1,
                        "quality_rating": quality,
                        "value_rating": value,
                        "quality_note": note,
                    }
                ],
            },
        )
        review = ((out or {}).get("reviews") or [None])[0]
        if not review or review.get("status") == "error":
            error = (review or {}).get("error") or {}
            raise DelegateError(
                error.get("message", "Rating failed"),
                code=error.get("code", "rating_failed"),
                body=out,
            )
        return review

    def balance(self) -> dict[str, Any]:
        """Prepaid balance: balance_micros, funding_mode."""
        return self._json("GET", "/v1/wallet/balance")

    def _prepare(self, service, input, items, offer, scope, title, summary):
        svc = self.service(service)
        offer_version = _pick_offer(svc, offer, items)
        fulfillment = offer_version["definition"]["fulfillment"]
        task_input = dict(input or {})
        # A batch-only service still takes a single input: one item.
        if items is None and fulfillment.get("batch"):
            items = [{"custom_id": "1", "input": task_input}]
        bound_scope = _build_scope(
            offer_version["definition"],
            task_input,
            len(items) if items else None,
            scope,
        )
        task: dict[str, Any] = {
            "title": (title or svc["title"])[:500],
            "summary": (summary or json.dumps(items or task_input))[:5000],
            "input": {} if items else task_input,
        }
        if items:
            task["items"] = [
                {"custom_id": item["custom_id"], "input": item["input"]}
                for item in items
            ]
        preview = self._json(
            "POST",
            f"/v1/offers/{_q(offer_version['offer_version_id'])}/pricing-preview",
            {"scope": bound_scope, "task": task},
        )
        return svc, offer_version, task, preview

    def _mcp(self, name: str, arguments: dict[str, Any]) -> Any:
        _, raw = self._request(
            "POST",
            "/mcp",
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments},
            },
            accept="application/json, text/event-stream",
        )
        message = json.loads(raw)
        if message.get("error"):
            raise DelegateError(
                message["error"].get("message", "MCP error"),
                code=str(message["error"].get("code")),
                body=message,
            )
        result = message.get("result") or {}
        payload = result.get("structuredContent")
        text = next(
            (
                block.get("text")
                for block in result.get("content") or []
                if block.get("type") == "text"
            ),
            None,
        )
        if payload is None and isinstance(text, str):
            try:
                payload = json.loads(text)
            except ValueError:
                payload = text
        if result.get("isError"):
            detail = (
                {"message": payload}
                if isinstance(payload, str)
                else (payload or {}).get("error") or payload or {}
            )
            raise DelegateError(
                detail.get("message", "Tool call failed"),
                code=detail.get("code", "tool_error"),
                body=payload,
            )
        return payload

    def _json(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        _, raw = self._request(method, path, body)
        return json.loads(raw) if raw else None

    def _request(
        self, method, path, body=None, accept="application/json", retried=False
    ):
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Accept": accept,
            "User-Agent": f"dlgt-io-python/{__version__}",
        }
        data = None
        if body is not None:
            data = json.dumps(
                {key: value for key, value in body.items() if value is not None}
            ).encode()
            headers["Content-Type"] = "application/json"
        status, response_headers, raw = self._send(
            method, self.base_url + path, headers, data
        )
        # Honour Retry-After once. Never hammer: repeated limiter hits get the IP banned.
        retry_after = _float(response_headers.get("Retry-After"))
        if status == 429 and not retried and retry_after and 0 < retry_after <= 30:
            time.sleep(retry_after)
            return self._request(method, path, body, accept, True)
        if status >= 400:
            raise _error_from(status, raw)
        return response_headers, raw

    def _send(self, method: str, url: str, headers: dict[str, str], data: bytes | None):
        """The only network call; tests replace it."""
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return response.status, response.headers, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.headers, error.read()


def _pick_offer(
    svc: dict[str, Any], offer: str | None, items: list | None
) -> dict[str, Any]:
    active = [o for o in svc.get("offer_versions") or [] if o.get("state") == "active"]
    tasks = [o for o in active if o["definition"]["fulfillment"]["kind"] == "task"]
    if offer:
        candidates = [
            o
            for o in active
            if offer in (o["offer_version_id"], o["definition"]["offer_key"])
        ]
    elif items is not None:
        candidates = [o for o in tasks if o["definition"]["fulfillment"].get("batch")]
    else:
        candidates = [
            o for o in tasks if not o["definition"]["fulfillment"].get("batch")
        ] or tasks
    if len(candidates) != 1:
        keys = ", ".join(o["definition"]["offer_key"] for o in active)
        message = (
            f"Choose an offer with offer=: {keys}"
            if keys
            else "This service has no active offers"
        )
        raise DelegateError(message, code="offer_selection")
    if candidates[0]["definition"]["fulfillment"]["kind"] != "task":
        raise DelegateError(
            "Entitlement offers aren't supported yet", code="unsupported_offer"
        )
    return candidates[0]


def _build_scope(
    definition: dict[str, Any], task_input: dict[str, Any], item_count, override
) -> dict[str, Any]:
    """Scope keys bound to input keys must be equal; fill each side from the other. Mutates task_input."""
    bindings = [
        b
        for b in definition["fulfillment"].get("bindings") or []
        if b.get("task_input_key")
    ]
    scope = {
        b["scope_key"]: task_input[b["task_input_key"]]
        for b in bindings
        if b["task_input_key"] in task_input
    }
    count_key = (definition["fulfillment"].get("batch") or {}).get("count_scope_key")
    if count_key and item_count is not None:
        scope[count_key] = item_count
    scope.update(override or {})
    for b in bindings:
        if b["task_input_key"] not in task_input and b["scope_key"] in scope:
            task_input[b["task_input_key"]] = scope[b["scope_key"]]
    missing = [
        key
        for key in (definition.get("scope") or {}).get("required") or []
        if key not in scope
    ]
    if missing:
        raise DelegateError(
            f"Missing scope: {', '.join(missing)}. Pass them in input or in scope=.",
            code="missing_scope",
        )
    return scope


def _job_view(id: str, detail: dict[str, Any]) -> dict[str, Any]:
    conversation = detail.get("conversation") or {}
    jobs = detail.get("jobs") or []
    job = jobs[-1] if jobs else {}
    payload = (
        job.get("result_payload")
        if isinstance(job.get("result_payload"), dict)
        else None
    )
    questions = [
        r for r in detail.get("feedback_requests") or [] if r.get("status") == "pending"
    ]
    view = {
        "id": id,
        "state": "running",
        "result": None,
        "error": None,
        "questions": questions,
        "raw": detail,
    }
    if payload and (
        job.get("status") == "delivered"
        or conversation.get("status") in ("delivered", "completed")
    ):
        if payload.get("outcome") == "failed_provider":
            reason = (
                (payload.get("settlement") or {}).get("reason")
                or payload.get("content")
                or "The provider failed"
            )
            return {**view, "state": "failed", "error": reason}
        return {**view, "state": "delivered", "result": payload}
    if job.get("status") in ("rejected", "dispatch_failed"):
        return {**view, "state": "failed", "error": f"Job {job['status']}"}
    if conversation.get("status") == "disputed":
        return {**view, "state": "failed", "error": "Disputed"}
    if questions:
        return {**view, "state": "needs_input"}
    return view


def _error_from(status: int, raw: bytes) -> DelegateError:
    text = raw.decode("utf-8", "replace")
    try:
        body: Any = json.loads(text)
    except ValueError:
        body = text
    detail = body.get("detail", body) if isinstance(body, dict) else body
    code = None
    if isinstance(detail, str):
        message = detail
    elif isinstance(detail, list):
        code = "validation_error"
        message = "; ".join(
            f"{'.'.join(map(str, d.get('loc') or []))}: {d.get('msg')}" for d in detail
        )
    else:
        detail = detail or {}
        code = detail.get("code") or detail.get("error_type")
        message = detail.get("message") or text or "Request failed"
    if code == "insufficient_escrow":
        message += f". Top up at {WALLET_URL}"
    return DelegateError(f"{status} {message}", status, code, body)


def _filename_of(disposition: str | None) -> str | None:
    if not disposition:
        return None
    encoded = re.search(r"filename\*=UTF-8''([^;]+)", disposition, re.I)
    if encoded:
        return urllib.parse.unquote(encoded.group(1))
    plain = re.search(r'filename="([^"]+)"', disposition, re.I)
    return plain.group(1) if plain else None


def _micros(usd: float) -> int:
    return round(usd * 1_000_000)


def _float(value: str | None) -> float | None:
    try:
        return float(value) if value else None
    except ValueError:
        return None


def _q(value: str) -> str:
    return urllib.parse.quote(value, safe="")
