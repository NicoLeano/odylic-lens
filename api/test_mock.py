"""Optional test-only Meta mocker.

Activated when `LENS_TEST_MOCK_META=1`. Intercepts every Meta Graph
call and returns canned data so Playwright (or anyone) can drive the
full UI end-to-end without real credentials. Production code paths are
unchanged when the env var is absent.
"""
from __future__ import annotations

import json
import os
import time
from typing import Any, Optional


def _make_payload(url: str, params: Optional[dict]) -> dict:
    """Route on URL substring → canned Meta response."""
    # OAuth token exchange
    if "oauth/access_token" in url:
        return {"access_token": "mock_token_xyz", "expires_in": 5_184_000}
    # User identity
    if url.endswith("/me") or "/me?" in url:
        return {"id": "fb_mock_user", "name": "Test User", "email": "test@example.com"}
    # Ad accounts list
    if "/me/adaccounts" in url:
        return {
            "data": [
                {
                    "id": "act_1001", "name": "Acme Brand", "currency": "USD",
                    "timezone_name": "America/Los_Angeles", "account_status": 1,
                    "amount_spent": "123456",
                    "business": {"id": "biz_a", "name": "Acme Group"},
                },
                {
                    "id": "act_1002", "name": "Beta Co", "currency": "USD",
                    "timezone_name": "America/New_York", "account_status": 1,
                    "amount_spent": "45678",
                    "business": {"id": "biz_a", "name": "Acme Group"},
                },
                {
                    "id": "act_1003", "name": "Solo Shop", "currency": "EUR",
                    "timezone_name": "Europe/Berlin", "account_status": 1,
                    "amount_spent": "9876",
                    "business": None,
                },
            ],
        }
    # Insights. different shape depending on level=
    if "/insights" in url:
        level = (params or {}).get("level", "account")
        if level == "ad":
            return {
                "data": [
                    _ad_insights_row("ad_a1", "Spring Sale UGC", "Acme Spring", "Top Performers", 4250, 200000, 8800, 4.4, 21.25, 0.48, 95),
                    _ad_insights_row("ad_a2", "Brand Story", "Acme Spring", "Top Performers", 1850, 110000, 3200, 2.9, 16.82, 0.58, 30),
                    _ad_insights_row("ad_a3", "Carousel - 3 Hero", "Always-On", "Retargeting", 980, 60000, 1900, 3.2, 16.33, 0.52, 18),
                ],
            }
        return {
            "data": [{
                "spend": "7080.00",
                "impressions": "370000",
                "clicks": "13900",
                "reach": "210000",
                "frequency": "1.76",
                "cpm": "19.13",
                "cpc": "0.51",
                "ctr": "3.76",
                "actions": [
                    {"action_type": "lead", "value": "143"},
                    {"action_type": "post_engagement", "value": "21000"},
                ],
            }],
        }
    # Ads list with creatives
    if "/ads" in url and "/insights" not in url:
        return {
            "data": [
                _ad_meta("ad_a1", "Spring Sale UGC", "ACTIVE"),
                _ad_meta("ad_a2", "Brand Story", "ACTIVE"),
                _ad_meta("ad_a3", "Carousel - 3 Hero", "ACTIVE"),
                _ad_meta("ad_a4", "Old Promo (paused)", "PAUSED"),
            ],
        }
    # Pixels
    if "/adspixels" in url:
        now_iso = time.strftime("%Y-%m-%dT%H:%M:%S+0000", time.gmtime(time.time() - 3600 * 2))
        return {"data": [{"id": "px_1", "name": "Main", "last_fired_time": now_iso}]}
    # Account meta object (GET /act_XXX)
    if url.rstrip("/").endswith(tuple(f"act_{n}" for n in (1001, 1002, 1003))):
        return {
            "id": "act_1001", "name": "Acme Brand", "currency": "USD",
            "timezone_name": "America/Los_Angeles", "account_status": 1,
        }
    return {"error": {"code": 999, "message": f"mock: no rule for {url}"}}


def _ad_insights_row(ad_id, ad_name, campaign, adset, spend, imp, clicks, ctr, cpm, cpc, leads):
    return {
        "ad_id": ad_id, "ad_name": ad_name,
        "campaign_id": "c_1", "campaign_name": campaign,
        "adset_id": "as_1", "adset_name": adset,
        "spend": str(spend), "impressions": str(imp), "clicks": str(clicks),
        "ctr": str(ctr), "cpm": str(cpm), "cpc": str(cpc),
        "reach": str(int(imp * 0.7)), "frequency": "1.5",
        "actions": [{"action_type": "lead", "value": str(leads)}],
    }


def _ad_meta(ad_id, name, status):
    return {
        "id": ad_id, "name": name,
        "effective_status": status, "configured_status": status,
        "adset_id": "as_1", "campaign_id": "c_1",
        "updated_time": "2026-05-18T10:00:00+0000",
        "creative": {
            "id": f"cr_{ad_id}", "name": f"Creative {ad_id}",
            "thumbnail_url": "https://placehold.co/64x64",
            "image_url": "https://placehold.co/200x200",
            "title": f"Headline for {name}",
            "body": "Save big this season. Click to shop.",
            "call_to_action_type": "SHOP_NOW",
            "link_url": "https://example.com/landing",
        },
    }


def install_if_enabled() -> bool:
    """Monkey-patch Meta calls when LENS_TEST_MOCK_META is set."""
    if os.environ.get("LENS_TEST_MOCK_META") != "1":
        return False
    import meta_client
    import auth as auth_module

    def _mock_get(url, params=None, max_attempts=3, use_cache=True):
        return _make_payload(url, params)
    meta_client._get_with_retry = _mock_get

    class _FakeResp:
        def __init__(self, data): self._data = data
        def json(self): return self._data
    def _fake_requests_get(url, params=None, timeout=None):
        return _FakeResp(_make_payload(url, params))
    auth_module.requests.get = _fake_requests_get
    return True
