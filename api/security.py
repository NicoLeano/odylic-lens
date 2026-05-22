"""Security middleware for Odylic Lens.

Two pieces:
  - SecurityHeadersMiddleware: adds OWASP-baseline headers (CSP, XFO, XCTO,
    Referrer-Policy, Permissions-Policy) to every response. Set tight enough
    to prevent clickjacking + mixed-content + framing exploits without
    breaking React or Google Fonts.
  - RateLimiter: per-IP token bucket for the credential-handling endpoints
    (configure/check). Cheap brute-force defense; doesn't replace a real
    WAF if you put Lens on a public IP.
"""
from __future__ import annotations

import os
import threading
import time
from collections import defaultdict, deque
from typing import Callable

from fastapi import HTTPException, Request, Response
from starlette.middleware.base import BaseHTTPMiddleware


# Content-Security-Policy:
#   default-src 'self'. only same-origin resources by default.
#   script-src 'self' + 'unsafe-inline' for Vite's dev injects (turn off in prod).
#   style-src 'self' 'unsafe-inline' + fonts.googleapis.com for our Inter/Fraunces fonts.
#   font-src + connect-src fonts.gstatic.com.
#   img-src 'self' + data: + https:. creatives load thumbnails from many fb CDNs.
#   connect-src 'self' + Vite/HMR + Meta Graph for client-side fetches.
#   frame-ancestors 'none'. can't be iframed (clickjacking).
_CSP = (
    "default-src 'self'; "
    "script-src 'self' 'unsafe-inline'; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "font-src 'self' https://fonts.gstatic.com data:; "
    "img-src 'self' data: blob: https:; "
    "media-src 'self' data: blob: https:; "
    "connect-src 'self' https://graph.facebook.com http://localhost:* ws://localhost:*; "
    # Facebook public-plugin iframes (post + video preview) used as a
    # fallback in AdDetailPanel when the direct Meta CDN URL expires.
    # Without this Chrome shows "This content is blocked" placeholder.
    "frame-src https://www.facebook.com https://web.facebook.com; "
    "frame-ancestors 'none'; "
    "base-uri 'self'; "
    "form-action 'self' https://www.facebook.com"
)


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: Callable):
        resp: Response = await call_next(request)
        h = resp.headers
        # Cheap but high-leverage hardening:
        h.setdefault("X-Content-Type-Options", "nosniff")
        h.setdefault("X-Frame-Options", "DENY")
        h.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        h.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        # Only emit CSP when we're not in dev (Vite HMR needs eval); detected by
        # presence of WEB_ORIGIN ending in a custom hostname or LENS_COOKIE_SECURE.
        if os.environ.get("LENS_CSP", "").lower() != "off":
            h.setdefault("Content-Security-Policy", _CSP)
        # HSTS only when HTTPS (signal: cookie-secure flag).
        if os.environ.get("LENS_COOKIE_SECURE") == "1":
            h.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        return resp


# ─── Per-IP rate limiter ───────────────────────────────────────────────
#
# Simple sliding window: store request timestamps per (route, ip). Reject
# when the window has more than `limit` entries.
#
# This is process-local; behind a load balancer with multiple workers you
# want Redis. For self-hosted single-process Lens, in-memory is fine.

_RATE_LIMIT_WINDOW_SEC = 60.0
_RATE_LIMIT_BUCKETS: dict[tuple[str, str], deque] = defaultdict(deque)
_RATE_LIMIT_LOCK = threading.Lock()


def _client_ip(request: Request) -> str:
    """Trust X-Forwarded-For only when LENS_TRUSTED_PROXY is set (so a
    public exposure doesn't let attackers spoof via the header)."""
    if os.environ.get("LENS_TRUSTED_PROXY") == "1":
        fwd = request.headers.get("x-forwarded-for")
        if fwd:
            return fwd.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def rate_limited(route: str, limit: int = 10, window_sec: float = _RATE_LIMIT_WINDOW_SEC):
    """Decorator-style factory. Apply via FastAPI Dependency:
        deps = [Depends(rate_limited("auth/configure", limit=5))]
    Raises 429 when limit is exceeded; otherwise returns None.
    """
    def _dep(request: Request):
        ip = _client_ip(request)
        key = (route, ip)
        now = time.time()
        with _RATE_LIMIT_LOCK:
            bucket = _RATE_LIMIT_BUCKETS[key]
            # Evict timestamps outside the window
            while bucket and (now - bucket[0]) > window_sec:
                bucket.popleft()
            if len(bucket) >= limit:
                retry_after = int(window_sec - (now - bucket[0])) + 1
                raise HTTPException(
                    status_code=429,
                    detail=f"Too many requests. Retry in {retry_after}s.",
                    headers={"Retry-After": str(retry_after)},
                )
            bucket.append(now)
        return None  # pass. request continues
    return _dep


def get_rate_limit_state() -> dict:
    """For tests / debug. current bucket sizes per (route, ip)."""
    with _RATE_LIMIT_LOCK:
        return {f"{r}:{ip}": len(d) for (r, ip), d in _RATE_LIMIT_BUCKETS.items()}
