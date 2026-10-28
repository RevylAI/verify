from __future__ import annotations

import json
from pathlib import Path

import pytest
from test_device import APP_ID, PROXY, START, FakeRevyl, Reply, fake, isolated_environment

import revyl_verify as verify
from revyl_verify import Target, VerifyError
from revyl_verify._transport import Client, credentials

__all__ = ["fake", "isolated_environment"]


def write_credentials(home: Path, value: object) -> None:
    directory = home / ".revyl"
    directory.mkdir(exist_ok=True)
    (directory / "credentials.json").write_text(json.dumps(value))


@pytest.mark.parametrize(
    ("environment", "stored", "expected"),
    [
        (" test-env ", {"api_key": "stored"}, "test-env"),
        ("test-env", {"access_token": "browser", "local_auth_override": True}, "browser"),
        ("", {"access_token": "browser"}, "browser"),
        ("", {"access_token": "browser", "expires_at": "2999-01-01T00:00:00Z"}, "browser"),
        (
            "",
            {"api_key": "stored", "access_token": "old", "expires_at": "2020-01-01T00:00:00Z"},
            "stored",
        ),
        ("", {"api_key": "stored", "access_token": "old", "expires_at": "invalid"}, "stored"),
        (
            "test-env",
            {
                "access_token": "old",
                "expires_at": "2020-01-01T00:00:00Z",
                "local_auth_override": True,
            },
            "test-env",
        ),
        ("${{ secrets.REVYL_API_KEY }}", {"api_key": "stored"}, "stored"),
        ("", {"api_key": "stored"}, "stored"),
    ],
)
def test_auth_precedence_on_wire(
    fake: FakeRevyl,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    environment: str,
    stored: object,
    expected: str,
) -> None:
    monkeypatch.setenv("REVYL_API_KEY", environment)
    write_credentials(tmp_path, stored)
    session = fake.open()
    session.close()
    assert fake.calls("POST", START)[0].headers["Authorization"] == "Bearer " + expected
    assert all(r.headers["Authorization"] == "Bearer " + expected for r in fake.requests)


@pytest.mark.parametrize(
    "value",
    [
        None,
        [],
        "secret-token",
        {"api_key": 123},
        {"access_token": False},
        {"expires_at": 123},
        {"local_auth_override": "true"},
    ],
)
def test_invalid_credential_shapes_fail_without_network(
    fake: FakeRevyl,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    value: object,
) -> None:
    monkeypatch.setenv("REVYL_API_KEY", "")
    write_credentials(tmp_path, value)
    with pytest.raises(VerifyError) as caught:
        fake.open()
    assert caught.value.code == "AUTH_MISSING"
    assert "secret-token" not in str(caught.value)
    assert not fake.requests


@pytest.mark.parametrize(
    "environment", ["", " ", "${{ secrets.REVYL_API_KEY }}", "bad\nsecret-token", "non-ascii-é"]
)
def test_missing_placeholder_and_unsafe_tokens(
    fake: FakeRevyl,
    monkeypatch: pytest.MonkeyPatch,
    environment: str,
) -> None:
    monkeypatch.setenv("REVYL_API_KEY", environment)
    with pytest.raises(VerifyError) as caught:
        fake.open()
    assert caught.value.code == "AUTH_MISSING"
    assert "secret-token" not in str(caught.value)
    assert not fake.requests


def test_malformed_credentials_are_redacted(
    fake: FakeRevyl,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("REVYL_API_KEY", "")
    directory = tmp_path / ".revyl"
    directory.mkdir()
    (directory / "credentials.json").write_text("{secret-token")
    with pytest.raises(VerifyError) as caught:
        credentials()
    assert caught.value.code == "AUTH_MISSING"
    assert "secret-token" not in str(caught.value)
    assert not fake.requests


def test_invalid_timezone_offset_cannot_activate_stored_access(
    fake: FakeRevyl,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("REVYL_API_KEY", "")
    write_credentials(
        tmp_path,
        {
            "api_key": "fallback-key",
            "access_token": "invalid-access",
            "expires_at": "2999-01-01T00:00:00+00:99",
        },
    )
    fake.open()
    assert fake.calls("POST", START)[0].headers["Authorization"] == "Bearer fallback-key"


def test_auth_is_snapshotted_per_client_and_home(
    fake: FakeRevyl,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("REVYL_API_KEY", "")
    write_credentials(tmp_path, {"api_key": "first-key"})
    first = fake.open()
    other = tmp_path / "other-home"
    other.mkdir()
    monkeypatch.setenv("HOME", str(other))
    write_credentials(other, {"api_key": "second-key"})
    second = fake.open()
    first.instruction("First session")
    second.instruction("Second session")
    assert [r.headers["Authorization"] for r in fake.calls("POST", START)] == [
        "Bearer first-key",
        "Bearer second-key",
    ]
    assert [r.headers["Authorization"] for r in fake.calls("POST", PROXY + "execute_step")] == [
        "Bearer first-key",
        "Bearer second-key",
    ]


@pytest.mark.parametrize(
    "url",
    [
        "http://public.example.test",
        "https://secret-token@backend.example.test",
        "https://backend.example.test/?token=secret-token",
        "https://backend.example.test/#secret-token",
        "https://backend.example.test:bad",
        "https://backend.example.test\nsecret-token",
    ],
)
def test_bad_backend_configuration_is_redacted(fake: FakeRevyl, url: str) -> None:
    with pytest.raises(VerifyError) as caught:
        Client(url)
    assert caught.value.code == "CONFIG_INVALID"
    assert "secret-token" not in str(caught.value)
    assert not fake.requests


def test_explicit_url_options(
    fake: FakeRevyl,
) -> None:
    session = verify.open(
        Target(platform="ios", app_id=APP_ID),
        backend_url=fake.url,
        app_url="https://custom-viewer.test/prefix/",
    )
    try:
        assert session.viewer_url.startswith("https://custom-viewer.test/prefix/sessions/")
    finally:
        session.close()
    session = verify.open(
        Target(platform="ios", app_id=APP_ID),
        backend_url=fake.url,
        app_url="https://viewer.test",
    )
    try:
        assert session.viewer_url.startswith("https://viewer.test/sessions/")
    finally:
        session.close()


def test_redirect_does_not_forward_authorization(fake: FakeRevyl) -> None:
    other = FakeRevyl()
    try:
        fake.handler = lambda r: Reply(302, {}, {"Location": other.url + "/leak"})
        with pytest.raises(VerifyError) as caught:
            fake.open()
        assert caught.value.code == "API_ERROR"
        assert not other.requests
        assert len(fake.calls("POST", START)) == 1
    finally:
        other.finish()


@pytest.mark.parametrize("status", [401, 403, 500])
def test_backend_errors_never_echo_secrets(fake: FakeRevyl, status: int) -> None:
    fake.handler = lambda r: Reply(status, {"detail": "secret-token https://x/?key=secret-token"})
    with pytest.raises(VerifyError) as caught:
        fake.open()
    assert caught.value.code == ("AUTH_REJECTED" if status in (401, 403) else "API_ERROR")
    assert "secret-token" not in str(caught.value)
    assert "?key=" not in str(caught.value)
