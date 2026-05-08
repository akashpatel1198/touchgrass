from __future__ import annotations

import time
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from touchgrass_daemon.api import create_app
from touchgrass_daemon.config import Config
from touchgrass_daemon.store import SessionStore

BEARER = "test-bearer-token-of-sufficient-length"
HEADERS = {"Authorization": f"Bearer {BEARER}"}


@pytest.fixture
def project_dir(tmp_path: Path) -> Path:
    project = tmp_path / "myproj"
    project.mkdir()
    (project / "main.py").write_text("print('hi')\n")
    (project / "lib").mkdir()
    (project / "lib" / "util.py").write_text("def f(): pass\n")
    return project


@pytest.fixture
def config(project_dir: Path) -> Config:
    return Config.model_validate(
        {
            "projects": [{"name": "myproj", "path": str(project_dir)}],
            "ntfy": {"topic": "touchgrass-test-12345"},
            "bearer_token": BEARER,
        }
    )


@pytest.fixture
def store(tmp_path: Path) -> Iterator[SessionStore]:
    s = SessionStore(tmp_path / "files.db")
    yield s
    s.close()


class _FakeSummary:
    """Counts calls so we can assert cache hit/miss behavior without hitting the SDK."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    async def __call__(self, *, rel_path: str, contents: str) -> str:
        self.calls.append((rel_path, contents))
        return f"summary of {rel_path} ({len(contents)} chars)"


@pytest.fixture
def summary() -> _FakeSummary:
    return _FakeSummary()


@pytest.fixture
def client(
    config: Config, store: SessionStore, summary: _FakeSummary
) -> Iterator[TestClient]:
    app = create_app(config, store=store, summary_generator=summary)
    with TestClient(app) as c:
        yield c


def test_tree_requires_bearer(client: TestClient) -> None:
    assert client.get("/projects/myproj/tree").status_code == 401


def test_tree_root(client: TestClient) -> None:
    response = client.get("/projects/myproj/tree", headers=HEADERS)
    assert response.status_code == 200
    names = [e["name"] for e in response.json()]
    assert "lib" in names
    assert "main.py" in names


def test_tree_subdir(client: TestClient) -> None:
    response = client.get(
        "/projects/myproj/tree", params={"path": "lib"}, headers=HEADERS
    )
    assert response.status_code == 200
    assert [e["name"] for e in response.json()] == ["util.py"]


def test_tree_unknown_project(client: TestClient) -> None:
    assert client.get("/projects/ghost/tree", headers=HEADERS).status_code == 404


def test_tree_traversal_rejected(client: TestClient) -> None:
    response = client.get(
        "/projects/myproj/tree", params={"path": "../"}, headers=HEADERS
    )
    assert response.status_code == 400


def test_file_raw_contents(client: TestClient) -> None:
    response = client.get(
        "/projects/myproj/file",
        params={"path": "main.py", "summary": "false"},
        headers=HEADERS,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["contents"] == "print('hi')\n"
    assert body["size"] == len("print('hi')\n")


def test_summary_cache_miss_then_hit(
    client: TestClient, summary: _FakeSummary
) -> None:
    first = client.get(
        "/projects/myproj/file",
        params={"path": "main.py", "summary": "true"},
        headers=HEADERS,
    ).json()
    assert first["cached"] is False
    assert first["summary"].startswith("summary of main.py")
    assert len(summary.calls) == 1

    second = client.get(
        "/projects/myproj/file",
        params={"path": "main.py", "summary": "true"},
        headers=HEADERS,
    ).json()
    assert second["cached"] is True
    assert second["summary"] == first["summary"]
    assert len(summary.calls) == 1  # still — cache hit


def test_summary_cache_invalidates_on_mtime_change(
    client: TestClient, summary: _FakeSummary, project_dir: Path
) -> None:
    client.get(
        "/projects/myproj/file",
        params={"path": "main.py", "summary": "true"},
        headers=HEADERS,
    )
    assert len(summary.calls) == 1

    time.sleep(0.01)  # ensure mtime resolution distinguishes
    (project_dir / "main.py").write_text("print('updated')\n")

    refreshed = client.get(
        "/projects/myproj/file",
        params={"path": "main.py", "summary": "true"},
        headers=HEADERS,
    ).json()
    assert refreshed["cached"] is False
    assert len(summary.calls) == 2
    assert summary.calls[1][1] == "print('updated')\n"


def test_file_traversal_rejected(client: TestClient) -> None:
    response = client.get(
        "/projects/myproj/file",
        params={"path": "../../etc/passwd", "summary": "false"},
        headers=HEADERS,
    )
    assert response.status_code == 400
