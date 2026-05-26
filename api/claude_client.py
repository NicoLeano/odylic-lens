"""Unified Claude client with routing strategy (decision 1A).

`call(strategy="api", ...)` hits the Anthropic SDK (used by audit
tagging — high-volume, paid).

`call(strategy="subprocess", ...)` shells out to the Claude Code CLI
(used by the Analyze stage — Max-subscription absorbs cost).

Both return a parsed JSON dict. Subprocess auth failures raise the
typed `ClaudeAuthExpired` (decision 6A) so the frontend can render a
re-authenticate button instead of a generic 500.
"""
from __future__ import annotations

import base64
import json
import re
import subprocess
from pathlib import Path
from typing import Literal, Optional

from anthropic import Anthropic

_MIME_BY_EXT = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
}

_AUTH_PATTERNS = (re.compile(r"auth", re.I), re.compile(r"expired", re.I), re.compile(r"401", re.I))


class ClaudeAuthExpired(RuntimeError):
    """Subprocess Claude CLI returned an auth / 401 / expired error."""


def _get_anthropic_key() -> Optional[str]:
    """Resolve the Anthropic key via Lens's existing helper.

    Imported lazily to avoid a circular import with ad_analysis_endpoints.
    """
    from ad_analysis_endpoints import _resolve_anthropic_key

    return _resolve_anthropic_key()


def _mime_for(path: str) -> str:
    ext = Path(path).suffix.lower()
    mime = _MIME_BY_EXT.get(ext)
    if mime is None:
        raise ValueError(f"unsupported frame extension {ext!r}")
    return mime


def _first_balanced_json_block(text: str) -> Optional[str]:
    """Return the first balanced `{...}` substring, honoring string literals.

    Cheap state machine over `text`:
    - tracks brace depth
    - ignores braces inside `"..."` string literals
    - honors backslash escapes inside strings
    Returns None when no balanced block exists.
    """
    depth = 0
    start = -1
    in_string = False
    escape = False
    for i, ch in enumerate(text):
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
            continue
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            if depth == 0:
                continue
            depth -= 1
            if depth == 0 and start != -1:
                return text[start : i + 1]
    return None


def _parse_json_loose(text: str) -> dict:
    """Parse JSON, falling back to the first balanced `{...}` block."""
    stripped = text.strip()
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        pass
    block = _first_balanced_json_block(stripped)
    if block is not None:
        try:
            return json.loads(block)
        except json.JSONDecodeError as e:
            raise ValueError(
                f"first balanced JSON block did not parse: {e}; block={block[:200]!r}"
            )
    raise ValueError(f"No JSON object found in output: {text[:200]!r}")


def _is_auth_error(stderr: str) -> bool:
    return any(p.search(stderr) for p in _AUTH_PATTERNS)


def _call_api(
    *,
    prompt: str,
    model: str,
    system: Optional[str],
    frames: Optional[list[str]],
    max_tokens: int,
    timeout: int,
) -> dict:
    key = _get_anthropic_key()
    client = Anthropic(api_key=key, timeout=float(timeout))

    content: list[dict] = []
    for p in frames or []:
        data = base64.standard_b64encode(Path(p).read_bytes()).decode("ascii")
        content.append(
            {
                "type": "image",
                "source": {"type": "base64", "media_type": _mime_for(p), "data": data},
            }
        )
    content.append({"type": "text", "text": prompt})

    kwargs: dict = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": content}],
    }
    if system is not None:
        kwargs["system"] = system

    msg = client.messages.create(**kwargs)
    parts = [getattr(b, "text", "") for b in msg.content if getattr(b, "text", None)]
    return _parse_json_loose("\n".join(parts))


def _call_subprocess(
    *,
    prompt: str,
    system: Optional[str],
    frames: Optional[list[str]],
    timeout: int,
) -> dict:
    full_prompt = f"{system}\n\n{prompt}" if system else prompt
    args = ["claude", "-p", full_prompt, "--output-format=json"]
    for f in frames or []:
        args.extend(["--image", f])

    try:
        result = subprocess.run(
            args, capture_output=True, text=True, timeout=timeout
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(f"claude CLI timed out after {timeout}s")
    if result.returncode != 0:
        stderr = result.stderr or ""
        if _is_auth_error(stderr):
            raise ClaudeAuthExpired(stderr.strip() or "Claude auth expired")
        raise RuntimeError(f"claude CLI exit {result.returncode}: {stderr.strip()}")
    if not (result.stdout or "").strip():
        raise RuntimeError("claude CLI returned empty stdout")
    return _parse_json_loose(result.stdout)


def call(
    *,
    strategy: Literal["api", "subprocess"],
    prompt: str,
    model: str = "claude-sonnet-4-6",
    system: Optional[str] = None,
    frames: Optional[list[str]] = None,
    max_tokens: int = 4096,
    timeout: int = 120,
) -> dict:
    """Route to the Anthropic SDK or the Claude Code CLI and return parsed JSON."""
    if strategy == "api":
        return _call_api(
            prompt=prompt,
            model=model,
            system=system,
            frames=frames,
            max_tokens=max_tokens,
            timeout=timeout,
        )
    if strategy == "subprocess":
        return _call_subprocess(
            prompt=prompt, system=system, frames=frames, timeout=timeout
        )
    raise ValueError(f"unknown strategy {strategy!r} (expected 'api' or 'subprocess')")
