from __future__ import annotations

import email.parser
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path

if sys.version_info >= (3, 11):
    import tomllib
else:
    import tomli as tomllib


def check_metadata(content: bytes, name: str, version: str) -> None:
    metadata = email.parser.BytesParser().parsebytes(content)
    assert metadata["Name"] == name, "Unexpected distribution name"
    assert metadata["Version"] == version, "Unexpected distribution version"
    assert metadata["Requires-Python"] == ">=3.10", "Unexpected supported Python versions"
    assert metadata["License-Expression"] == "Apache-2.0", "Missing Apache license metadata"
    dependencies = metadata.get_all("Requires-Dist", [])
    assert len(dependencies) == 1 and re.fullmatch(
        r"pillow>=11\.0", dependencies[0], re.IGNORECASE
    ), "Pillow must be the only runtime dependency"
    assert "#" in metadata.get_payload(), "Missing package README"


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    with (root / "pyproject.toml").open("rb") as stream:
        project = tomllib.load(stream)["project"]
    name, version = project["name"], project["version"]
    assert name == "revyl-verify" and isinstance(version, str), "Unexpected package identity"
    wheels = list((root / "dist").glob("*.whl"))
    sdists = list((root / "dist").glob("*.tar.gz"))
    assert len(wheels) == len(sdists) == 1, "Build exactly one clean wheel and sdist first"
    wheel, sdist = wheels[0], sdists[0]
    assert wheel.name == f"revyl_verify-{version}-py3-none-any.whl", "Unexpected wheel filename"
    assert sdist.name == f"revyl_verify-{version}.tar.gz", "Unexpected sdist filename"
    package_files = {
        path.relative_to(root / "src").as_posix()
        for path in (root / "src/revyl_verify").rglob("*")
        if path.is_file() and (path.suffix == ".py" or path.name == "py.typed")
    }
    assert {"revyl_verify/__init__.py", "revyl_verify/py.typed"} <= package_files
    info = f"revyl_verify-{version}.dist-info"
    wheel_files = package_files | {
        f"{info}/METADATA",
        f"{info}/WHEEL",
        f"{info}/RECORD",
        f"{info}/licenses/LICENSE",
    }
    with zipfile.ZipFile(wheel) as archive:
        assert set(archive.namelist()) == wheel_files, "Unexpected or missing wheel files"
        check_metadata(archive.read(f"{info}/METADATA"), name, version)
        assert archive.read(f"{info}/licenses/LICENSE") == (root / "LICENSE").read_bytes()
        for path in package_files:
            assert archive.read(path) == (root / "src" / path).read_bytes(), path
    sdist_files = {f"src/{path}" for path in package_files} | {
        "pyproject.toml",
        "README.md",
        "LICENSE",
        "uv.lock",
        "PKG-INFO",
        ".gitignore",
    }
    sdist_files |= {path.relative_to(root).as_posix() for path in (root / "tests").rglob("*.py")}
    sdist_files |= {
        path.relative_to(root).as_posix() for path in (root / "tests/fixtures").glob("*.json")
    }
    sdist_files |= {path.relative_to(root).as_posix() for path in (root / "scripts").glob("*.py")}
    prefix = f"revyl_verify-{version}/"
    with tarfile.open(sdist, "r:gz") as archive:
        members = archive.getmembers()
        assert all(member.isfile() for member in members), "Only regular files belong in sdist"
        assert {member.name for member in members} == {prefix + path for path in sdist_files}, (
            "Unexpected or missing sdist files"
        )
        for path in sdist_files:
            member_stream = archive.extractfile(prefix + path)
            assert member_stream is not None, path
            content = member_stream.read()
            if path == "PKG-INFO":
                check_metadata(content, name, version)
            elif path == ".gitignore":
                ignore_file = root / path if (root / path).is_file() else root.parent / path
                assert content == ignore_file.read_bytes(), path
            else:
                assert content == (root / path).read_bytes(), path
    smoke = root / "tests/wheel_smoke.py"
    assert smoke.is_file(), "Missing installed-wheel fake-server smoke"
    with tempfile.TemporaryDirectory(prefix="verify-wheel-") as temporary:
        directory = Path(temporary)
        environment = {
            key: value
            for key, value in os.environ.items()
            if key in {"PATH", "SYSTEMROOT", "SSL_CERT_FILE", "SSL_CERT_DIR"}
        }
        environment["HOME"] = str(directory)
        environment["PIP_CONFIG_FILE"] = os.devnull
        subprocess.run(
            [sys.executable, "-I", "-m", "venv", str(directory / "venv")],
            check=True,
            timeout=60,
            cwd=directory,
            env=environment,
        )
        python = directory / "venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        subprocess.run(
            [
                str(python),
                "-I",
                "-m",
                "pip",
                "--isolated",
                "install",
                "--disable-pip-version-check",
                "--index-url",
                "https://pypi.org/simple",
                str(wheel),
            ],
            check=True,
            timeout=180,
            cwd=directory,
            env=environment,
        )
        subprocess.run(
            [str(python), "-I", str(smoke)],
            check=True,
            timeout=120,
            cwd=directory,
            env=environment,
        )
        source = directory / "source"
        source.mkdir()
        with tarfile.open(sdist, "r:gz") as archive:
            for member in archive.getmembers():
                destination = source / member.name.removeprefix(prefix)
                destination.parent.mkdir(parents=True, exist_ok=True)
                member_stream = archive.extractfile(member)
                assert member_stream is not None
                destination.write_bytes(member_stream.read())
        uv = shutil.which("uv")
        assert uv is not None, "uv is required to validate extracted-sdist tests"
        subprocess.run(
            [uv, "sync", "--frozen", "--project", str(source), "--python", sys.executable],
            check=True,
            timeout=180,
            cwd=directory,
            env=environment,
        )
        source_python = (
            source / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        )
        subprocess.run(
            [str(source_python), "-I", "-m", "pytest", "tests"],
            check=True,
            timeout=180,
            cwd=source,
            env=environment,
        )
    print(f"{name}@{version}: archives, installed-wheel smoke and extracted-sdist tests passed.")


if __name__ == "__main__":
    main()
