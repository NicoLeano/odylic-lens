"""Regression tests for Meta action parsing gotchas."""
from __future__ import annotations

from ad_analysis_endpoints import _parse_perf, _purchase_count, _purchase_value


def test_parse_perf_uses_canonical_purchase_and_funnel_actions_only():
    """Meta returns duplicate purchase/funnel action aliases; do not sum or
    fall back to alternate buckets."""
    row = {
        "spend": "100",
        "actions": [
            {"action_type": "offsite_conversion.fb_pixel_purchase", "value": "99"},
            {"action_type": "purchase", "value": "3"},
            {"action_type": "omni_purchase", "value": "99"},
            {"action_type": "offsite_conversion.fb_pixel_add_to_cart", "value": "88"},
            {"action_type": "add_to_cart", "value": "6"},
            {
                "action_type": "offsite_conversion.fb_pixel_initiate_checkout",
                "value": "77",
            },
            {"action_type": "initiate_checkout", "value": "4"},
        ],
        "action_values": [
            {"action_type": "offsite_conversion.fb_pixel_purchase", "value": "9900"},
            {"action_type": "purchase", "value": "300"},
            {"action_type": "offsite_conversion.fb_pixel_add_to_cart", "value": "8800"},
            {"action_type": "add_to_cart", "value": "600"},
        ],
    }

    parsed = _parse_perf(row)

    assert parsed["purchases"] == 3
    assert parsed["revenue"] == 300
    assert parsed["roas"] == 3
    assert parsed["add_to_cart"] == 6
    assert parsed["add_to_cart_value"] == 600
    assert parsed["initiate_checkout"] == 4


def test_purchase_helpers_ignore_noncanonical_purchase_aliases():
    actions = [
        {"action_type": "offsite_conversion.fb_pixel_purchase", "value": "99"},
        {"action_type": "purchase", "value": "3"},
    ]
    values = [
        {"action_type": "offsite_conversion.fb_pixel_purchase", "value": "9900"},
        {"action_type": "purchase", "value": "300"},
    ]

    assert _purchase_count(actions) == 3
    assert _purchase_value(values) == 300
