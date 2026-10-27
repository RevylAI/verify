from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(
        self,
        req: Request,
        fp: object,
        code: int,
        msg: str,
        headers: object,
        newurl: str,
    ) -> None:
        return None


def check_release_tag(version: str, tag: str) -> None:
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError("The Python package needs a stable release version.")
    if tag != f"py/v{version}":
        raise ValueError("The tag must exactly match py/v<package version>.")


def published_version_exists(name: str, version: str) -> bool:
    if name != "revyl-verify" or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", version):
        raise ValueError("Unexpected Python distribution name or version.")
    request = Request(
        f"https://pypi.org/pypi/{name}/{version}/json",
        headers={"Accept": "application/json", "Cache-Control": "no-cache"},
    )
    try:
        response = build_opener(NoRedirects()).open(request, timeout=30)
    except HTTPError as error:
        if error.code == 404:
            return False
        raise RuntimeError(
            f"PyPI lookup failed with HTTP {error.code}; refusing to assume unpublished."
        ) from None
    with response:
        if response.status != 200:
            raise RuntimeError(f"Unexpected PyPI lookup status: {response.status}.")
        metadata: object = json.load(response)
    if not isinstance(metadata, dict):
        raise ValueError("Unexpected PyPI package metadata.")
    info = metadata.get("info")
    if not isinstance(info, dict) or info.get("name") != name or info.get("version") != version:
        raise ValueError("PyPI returned unexpected package/version metadata.")
    urls = metadata.get("urls")
    if not isinstance(urls, list) or not urls:
        raise ValueError("PyPI returned a release without published files.")
    for artifact in urls:
        if not isinstance(artifact, dict):
            raise ValueError("PyPI returned malformed file metadata.")
        filename = artifact.get("filename")
        digests = artifact.get("digests")
        if (
            not isinstance(filename, str)
            or not (
                filename == f"revyl_verify-{version}.tar.gz"
                or (filename.startswith(f"revyl_verify-{version}-") and filename.endswith(".whl"))
            )
            or not isinstance(digests, dict)
            or not isinstance(digests.get("sha256"), str)
            or not re.fullmatch(r"[0-9a-f]{64}", digests["sha256"])
        ):
            raise ValueError("PyPI returned malformed file metadata.")
    return True


def require_ci_publishing(published: bool, enabled: str | None) -> None:
    if not published and enabled != "true":
        raise ValueError(
            "CI publication is disabled. An administrator must protect the pypi environment, "
            "configure its trusted publisher, and enable VERIFY_PYPI_PUBLISH_ENABLED."
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("tag", nargs="?")
    parser.add_argument("--registry", action="store_true")
    parser.add_argument("--require-enabled", action="store_true")
    args = parser.parse_args()
    if args.tag is None and not args.registry:
        parser.error("provide a py/v<version> tag or --registry")
    manifest = Path(__file__).resolve().parents[1] / "pyproject.toml"
    with manifest.open("rb") as stream:
        project = tomllib.load(stream)["project"]
    name, version = project["name"], project["version"]
    if not isinstance(name, str) or not isinstance(version, str):
        raise ValueError("Invalid Python package identity.")
    if args.tag is not None:
        check_release_tag(version, args.tag)
    if args.require_enabled and not args.registry:
        parser.error("--require-enabled requires --registry")
    if args.registry:
        published = published_version_exists(name, version)
        if args.require_enabled:
            require_ci_publishing(published, os.environ.get("VERIFY_PYPI_PUBLISH_ENABLED"))
        if output := os.environ.get("GITHUB_OUTPUT"):
            with Path(output).open("a", encoding="utf-8") as stream:
                stream.write(f"published={str(published).lower()}\n")
        status = "already published; skipping publication" if published else "not published"
        print(f"{name}@{version}: {status}.")
    else:
        print(f"Python release tag matches package version {version}.")


if __name__ == "__main__":
    main()
