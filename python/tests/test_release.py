from __future__ import annotations

import importlib.util
import io
import json
import sys
from email.message import Message
from pathlib import Path
from types import ModuleType
from urllib.error import HTTPError, URLError
from urllib.request import Request

import pytest


def release_module() -> ModuleType:
    path = Path(__file__).resolve().parents[1] / "scripts/check_release.py"
    spec = importlib.util.spec_from_file_location("check_release", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Response(io.BytesIO):
    status = 200


class Opener:
    def __init__(self, content: bytes | Exception) -> None:
        self.content = content

    def open(self, request: Request, *, timeout: int) -> Response:
        assert request.full_url == "https://pypi.org/pypi/revyl-verify/0.1.0/json"
        assert timeout == 30
        if isinstance(self.content, Exception):
            raise self.content
        return Response(self.content)


def patch_registry(
    monkeypatch: pytest.MonkeyPatch, module: ModuleType, content: bytes | Exception
) -> None:
    def build_opener(handler: object) -> Opener:
        assert isinstance(handler, module.NoRedirects)
        return Opener(content)

    monkeypatch.setattr(module, "build_opener", build_opener)


@pytest.mark.parametrize("tag", ["v0.1.0", "go/v0.1.0", "py/0.1.0", "py/v0.1.1", "py/v0.1.0-extra"])
def test_tag_matches_exact_python_version(tag: str) -> None:
    module = release_module()
    module.check_release_tag("0.1.0", "py/v0.1.0")
    with pytest.raises(ValueError, match="exactly match"):
        module.check_release_tag("0.1.0", tag)
    with pytest.raises(ValueError, match="stable release"):
        module.check_release_tag("0.1.0rc1", "py/v0.1.0rc1")


def test_registry_only_skips_exact_published_distribution(monkeypatch: pytest.MonkeyPatch) -> None:
    module = release_module()
    patch_registry(
        monkeypatch,
        module,
        json.dumps(
            {
                "info": {"name": "revyl-verify", "version": "0.1.0"},
                "urls": [
                    {
                        "filename": "revyl_verify-0.1.0-py3-none-any.whl",
                        "digests": {"sha256": "a" * 64},
                    }
                ],
            }
        ).encode(),
    )
    assert module.published_version_exists("revyl-verify", "0.1.0") is True
    patch_registry(monkeypatch, module, HTTPError("", 404, "missing", Message(), None))
    assert module.published_version_exists("revyl-verify", "0.1.0") is False


@pytest.mark.parametrize("status", [301, 302, 401, 403, 429, 500, 503])
def test_registry_http_errors_fail_closed(monkeypatch: pytest.MonkeyPatch, status: int) -> None:
    module = release_module()
    patch_registry(monkeypatch, module, HTTPError("", status, "failure", Message(), None))
    with pytest.raises(RuntimeError, match=f"HTTP {status}"):
        module.published_version_exists("revyl-verify", "0.1.0")


@pytest.mark.parametrize(
    "content",
    [
        b"not json",
        b"[]",
        b"{}",
        b'{"info":{"name":"other","version":"0.1.0"},"urls":[{}]}',
        b'{"info":{"name":"revyl-verify","version":"0.0.1"},"urls":[{}]}',
        b'{"info":{"name":"revyl-verify","version":"0.1.0"},"urls":[]}',
        b'{"info":{"name":"revyl-verify","version":"0.1.0"},"urls":[{}]}',
        b'{"info":{"name":"revyl-verify","version":"0.1.0"},"urls":["invalid"]}',
    ],
)
def test_registry_malformed_metadata_fails_closed(
    monkeypatch: pytest.MonkeyPatch, content: bytes
) -> None:
    module = release_module()
    patch_registry(monkeypatch, module, content)
    with pytest.raises(ValueError):
        module.published_version_exists("revyl-verify", "0.1.0")


def test_registry_transport_errors_fail_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    module = release_module()
    patch_registry(monkeypatch, module, URLError("network unavailable"))
    with pytest.raises(URLError):
        module.published_version_exists("revyl-verify", "0.1.0")


@pytest.mark.parametrize("enabled", [None, "", "false", "TRUE", "1"])
def test_new_publication_needs_explicit_administrator_attestation(enabled: str | None) -> None:
    module = release_module()
    module.require_ci_publishing(True, enabled)
    module.require_ci_publishing(False, "true")
    with pytest.raises(ValueError, match="CI publication is disabled"):
        module.require_ci_publishing(False, enabled)


def test_registry_output_and_dispatch_do_not_require_publication(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    module = release_module()
    output = tmp_path / "output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    monkeypatch.delenv("VERIFY_PYPI_PUBLISH_ENABLED", raising=False)
    monkeypatch.setattr(sys, "argv", ["check_release.py", "--registry"])
    patch_registry(monkeypatch, module, HTTPError("", 404, "missing", Message(), None))
    module.main()
    assert output.read_text() == "published=false\n"
    monkeypatch.setattr(sys, "argv", ["check_release.py", "--registry", "--require-enabled"])
    with pytest.raises(ValueError, match="CI publication is disabled"):
        module.main()


def test_release_cli_requires_tag_or_registry_check(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "argv", ["check_release.py"])
    with pytest.raises(SystemExit) as error:
        release_module().main()
    assert error.value.code == 2


def test_workflow_separates_validation_from_guarded_trusted_publication() -> None:
    workflow_path = Path(__file__).resolve().parents[2] / ".github/workflows/release-python.yml"
    if not workflow_path.is_file():
        pytest.skip("Repository workflow integration check is not included in Python sdist.")
    workflow = workflow_path.read_text()
    assert "tags: ['py/v*']" in workflow
    assert "git merge-base --is-ancestor HEAD origin/main" in workflow
    validate, publish = workflow.split("\n  publish:\n", 1)
    assert "id-token: write" not in validate
    assert "args+=(--require-enabled)" in validate
    assert "if: steps.registry.outputs.published == 'false'" in validate
    assert "python -m twine check --strict dist/*" in validate
    assert "github.event_name == 'push'" in publish
    assert "needs.validate.outputs.published == 'false'" in publish
    assert "vars.VERIFY_PYPI_PUBLISH_ENABLED == 'true'" in publish
    assert "environment: pypi" in publish
    assert "id-token: write" in publish
    assert "pypa/gh-action-pypi-publish@release/v1" in publish
    assert "skip-existing" not in publish
    assert "uv build" not in publish
