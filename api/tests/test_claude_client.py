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


def test_call_subprocess_with_frames_fails_loud_before_cli(tmp_path: Path):
    f1 = tmp_path / "a.png"
    f2 = tmp_path / "b.png"
    f1.write_bytes(b"x")
    f2.write_bytes(b"y")
    with patch("claude_client.subprocess.run") as run:
        with pytest.raises(RuntimeError) as exc:
            claude_client.call(
                strategy="subprocess", prompt="p", frames=[str(f1), str(f2)]
            )
    assert "not supported" in str(exc.value)
    run.assert_not_called()


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


def test_call_subprocess_nonzero_uses_stdout_when_stderr_empty():
    with patch("claude_client.subprocess.run") as run:
        run.return_value = _completed(
            stdout='{"type":"result","is_error":true,"result":"permission denied"}',
            stderr="",
            returncode=1,
        )
        with pytest.raises(RuntimeError) as exc:
            claude_client.call(strategy="subprocess", prompt="p")
    assert "permission denied" in str(exc.value)


def test_call_subprocess_nonzero_detects_auth_in_stdout():
    with patch("claude_client.subprocess.run") as run:
        run.return_value = _completed(
            stdout='{"type":"result","is_error":true,"result":"401 auth expired"}',
            stderr="",
            returncode=1,
        )
        with pytest.raises(claude_client.ClaudeAuthExpired):
            claude_client.call(strategy="subprocess", prompt="p")


def test_call_subprocess_strips_wrap_text_around_json():
    with patch("claude_client.subprocess.run") as run:
        run.return_value = _completed(
            stdout='Sure! Here is the answer: {"angle": "Benefits"} hope that helps.'
        )
        out = claude_client.call(strategy="subprocess", prompt="p")
    assert out == {"angle": "Benefits"}


def test_call_subprocess_unwraps_claude_cli_result_json():
    """Claude Code --output-format=json wraps model text under `result`."""
    with patch("claude_client.subprocess.run") as run:
        run.return_value = _completed(
            stdout=(
                '{"type":"result","subtype":"success","is_error":false,'
                '"result":"{\\"recipes\\":[{\\"recipe_id\\":\\"r1\\"}]}"}'
            )
        )
        out = claude_client.call(strategy="subprocess", prompt="p")
    assert out == {"recipes": [{"recipe_id": "r1"}]}


def test_call_subprocess_error_result_wrapper_raises_runtime_error():
    with patch("claude_client.subprocess.run") as run:
        run.return_value = _completed(
            stdout=(
                '{"type":"result","subtype":"error","is_error":true,'
                '"result":"model refused"}'
            )
        )
        with pytest.raises(RuntimeError) as exc:
            claude_client.call(strategy="subprocess", prompt="p")
    assert "model refused" in str(exc.value)


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
    assert args == ["claude", "-p", "--output-format=json"]
    assert run.call_args.kwargs["input"] == "rules\n\ntask"


def test_call_subprocess_runs_outside_repo_context():
    with patch("claude_client.subprocess.run") as run:
        run.return_value = _completed(stdout='{"ok": 1}')
        claude_client.call(strategy="subprocess", prompt="task")
    assert Path(run.call_args.kwargs["cwd"]) == Path.home()
    assert run.call_args.kwargs["env"]["PWD"] == str(Path.home())


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


# ---------------------------------------------------------------------------
# TODO-004 / TODO-005 hardening
# ---------------------------------------------------------------------------


def test_parse_json_loose_returns_first_balanced_block():
    """TODO-004: greedy regex would match `{"a":1} actual: {"angle":...}` and
    fail JSONDecode. Brace-depth scanner returns the FIRST balanced block."""
    out = claude_client._parse_json_loose(
        'Example: {"a": 1} actual: {"angle": "Benefits"}'
    )
    assert out == {"a": 1}


def test_parse_json_loose_handles_braces_inside_strings():
    """Closing braces inside string literals must NOT close the object."""
    out = claude_client._parse_json_loose('Here: {"k": "value with } inside"}')
    assert out == {"k": "value with } inside"}


def test_subprocess_timeout_raises_runtime_error():
    """TODO-005 #1: subprocess.TimeoutExpired → RuntimeError, not raw."""
    with patch("claude_client.subprocess.run") as run:
        run.side_effect = subprocess.TimeoutExpired(cmd="claude", timeout=120)
        with pytest.raises(RuntimeError) as exc:
            claude_client.call(strategy="subprocess", prompt="p", timeout=120)
    assert "timed out" in str(exc.value).lower()


def test_subprocess_empty_stdout_raises_runtime_error():
    """TODO-005 #2: returncode=0 + empty stdout → clear RuntimeError."""
    with patch("claude_client.subprocess.run") as run:
        run.return_value = _completed(stdout="   \n", returncode=0)
        with pytest.raises(RuntimeError) as exc:
            claude_client.call(strategy="subprocess", prompt="p")
    assert "empty stdout" in str(exc.value).lower()


def test_mime_for_unknown_extension_raises_value_error(tmp_path: Path):
    """TODO-005 #3: unknown frame ext fails fast, not silent image/png."""
    bad = tmp_path / "x.webp"
    bad.write_bytes(b"\x00")
    with pytest.raises(ValueError) as exc:
        claude_client._mime_for(str(bad))
    assert "webp" in str(exc.value).lower()
