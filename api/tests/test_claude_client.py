"""Tests for the unified claude_client routing module.

Covers decision 1A (api + subprocess strategies under one entrypoint) and
6A (typed ClaudeAuthExpired exception on subprocess auth failures).
"""
from __future__ import annotations

import base64
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

import claude_client


# ---------------------------------------------------------------------------
# subprocess strategy
# ---------------------------------------------------------------------------


def _completed(stdout: str = "", stderr: str = "", returncode: int = 0):
    return subprocess.CompletedProcess(
        args=["claude"], returncode=returncode, stdout=stdout, stderr=stderr
    )


def test_call_subprocess_strategy_returns_parsed_json():
    with patch("claude_client.subprocess.run") as run:
        run.return_value = _completed(stdout='{"angle": "Benefits"}')
        out = claude_client.call(strategy="subprocess", prompt="hi")
    assert out == {"angle": "Benefits"}


def test_call_subprocess_with_frames_passes_image_flag(tmp_path: Path):
    f1 = tmp_path / "a.png"
    f2 = tmp_path / "b.png"
    f1.write_bytes(b"x")
    f2.write_bytes(b"y")
    with patch("claude_client.subprocess.run") as run:
        run.return_value = _completed(stdout='{"ok": true}')
        claude_client.call(
            strategy="subprocess", prompt="p", frames=[str(f1), str(f2)]
        )
    args = run.call_args[0][0]
    # Each frame must show up as a `--image <path>` pair.
    assert args.count("--image") == 2
    idxs = [i for i, a in enumerate(args) if a == "--image"]
    assert args[idxs[0] + 1] == str(f1)
    assert args[idxs[1] + 1] == str(f2)


def test_call_subprocess_raises_claude_auth_expired_on_auth_stderr():
    with patch("claude_client.subprocess.run") as run:
        run.return_value = _completed(
            stderr="authentication expired, please login", returncode=1
        )
        with pytest.raises(claude_client.ClaudeAuthExpired) as exc:
            claude_client.call(strategy="subprocess", prompt="p")
    assert "authentication expired" in str(exc.value)


def test_call_subprocess_raises_claude_auth_expired_on_401():
    with patch("claude_client.subprocess.run") as run:
        run.return_value = _completed(stderr="401 Unauthorized", returncode=1)
        with pytest.raises(claude_client.ClaudeAuthExpired):
            claude_client.call(strategy="subprocess", prompt="p")


def test_call_subprocess_raises_runtime_error_on_other_nonzero():
    with patch("claude_client.subprocess.run") as run:
        run.return_value = _completed(stderr="some other failure", returncode=2)
        with pytest.raises(RuntimeError) as exc:
            claude_client.call(strategy="subprocess", prompt="p")
    # Must be plain RuntimeError, NOT the ClaudeAuthExpired subclass.
    assert not isinstance(exc.value, claude_client.ClaudeAuthExpired)


def test_call_subprocess_strips_wrap_text_around_json():
    with patch("claude_client.subprocess.run") as run:
        run.return_value = _completed(
            stdout='Sure! Here is the answer: {"angle": "Benefits"} hope that helps.'
        )
        out = claude_client.call(strategy="subprocess", prompt="p")
    assert out == {"angle": "Benefits"}


def test_call_subprocess_raises_value_error_when_no_json_block():
    with patch("claude_client.subprocess.run") as run:
        run.return_value = _completed(stdout="no json here at all")
        with pytest.raises(ValueError):
            claude_client.call(strategy="subprocess", prompt="p")


def test_call_subprocess_concatenates_system_and_prompt():
    with patch("claude_client.subprocess.run") as run:
        run.return_value = _completed(stdout='{"ok": 1}')
        claude_client.call(strategy="subprocess", system="rules", prompt="task")
    args = run.call_args[0][0]
    p_idx = args.index("-p")
    assert args[p_idx + 1] == "rules\n\ntask"


# ---------------------------------------------------------------------------
# api strategy
# ---------------------------------------------------------------------------


def _fake_anthropic_response(text: str):
    """Mimic the anthropic SDK response object shape (`.content[0].text`)."""
    block = SimpleNamespace(text=text)
    return SimpleNamespace(content=[block])


def test_call_api_strategy_returns_parsed_json():
    fake_client = MagicMock()
    fake_client.messages.create.return_value = _fake_anthropic_response(
        '{"angle": "Benefits"}'
    )
    with patch("claude_client.Anthropic", return_value=fake_client), patch(
        "claude_client._get_anthropic_key", return_value="sk-test"
    ):
        out = claude_client.call(strategy="api", prompt="hi")
    assert out == {"angle": "Benefits"}


def test_call_api_with_frames_sends_image_content_blocks(tmp_path: Path):
    img = tmp_path / "frame.png"
    img.write_bytes(b"\x00")
    fake_client = MagicMock()
    fake_client.messages.create.return_value = _fake_anthropic_response('{"ok": 1}')
    with patch("claude_client.Anthropic", return_value=fake_client), patch(
        "claude_client._get_anthropic_key", return_value="sk-test"
    ):
        claude_client.call(strategy="api", prompt="describe", frames=[str(img)])
    kwargs = fake_client.messages.create.call_args.kwargs
    messages = kwargs["messages"]
    # Single user message with a list of content blocks (image + text).
    assert len(messages) == 1
    content = messages[0]["content"]
    image_blocks = [b for b in content if b.get("type") == "image"]
    assert len(image_blocks) == 1
    src = image_blocks[0]["source"]
    assert src["type"] == "base64"
    assert src["media_type"] == "image/png"
    assert src["data"] == base64.standard_b64encode(b"\x00").decode("ascii")


def test_call_api_routes_system_prompt_correctly():
    fake_client = MagicMock()
    fake_client.messages.create.return_value = _fake_anthropic_response('{"ok": 1}')
    with patch("claude_client.Anthropic", return_value=fake_client), patch(
        "claude_client._get_anthropic_key", return_value="sk-test"
    ):
        claude_client.call(strategy="api", prompt="task", system="You are X")
    kwargs = fake_client.messages.create.call_args.kwargs
    assert kwargs.get("system") == "You are X"


# ---------------------------------------------------------------------------
# router
# ---------------------------------------------------------------------------


def test_call_invalid_strategy_raises():
    with pytest.raises(ValueError):
        claude_client.call(strategy="bogus", prompt="p")
