from __future__ import annotations

from pathlib import Path
from textwrap import dedent

import pytest

from touchgrass_daemon.config import Config, ConfigError


def _write_config(tmp_path: Path, body: str) -> Path:
    config_path = tmp_path / "config.yaml"
    config_path.write_text(dedent(body))
    return config_path


def _project_block(name: str, path: Path) -> str:
    return f"""
      - name: {name}
        path: {path}
    """.rstrip()


def test_load_happy_path(tmp_path: Path) -> None:
    project_dir = tmp_path / "my-app"
    project_dir.mkdir()
    config_path = _write_config(
        tmp_path,
        f"""
        projects:
          - name: my-app
            path: {project_dir}
        ntfy:
          topic: touchgrass-abc12345
        bearer_token: a-very-long-bearer-token-please
        """,
    )
    cfg = Config.load(config_path)
    assert len(cfg.projects) == 1
    assert cfg.projects[0].name == "my-app"
    assert cfg.projects[0].path == project_dir.resolve()
    assert cfg.projects[0].pre_approved_tools == []
    assert cfg.ntfy.topic == "touchgrass-abc12345"
    assert cfg.permission_timeout_seconds == 300


def test_missing_file_raises(tmp_path: Path) -> None:
    with pytest.raises(ConfigError, match="not found"):
        Config.load(tmp_path / "nope.yaml")


def test_malformed_yaml_raises(tmp_path: Path) -> None:
    config_path = _write_config(tmp_path, "projects: [unclosed\n")
    with pytest.raises(ConfigError, match="malformed YAML"):
        Config.load(config_path)


def test_root_must_be_mapping(tmp_path: Path) -> None:
    config_path = _write_config(tmp_path, "- just-a-list\n")
    with pytest.raises(ConfigError, match="must be a mapping"):
        Config.load(config_path)


def test_missing_required_field_raises(tmp_path: Path) -> None:
    project_dir = tmp_path / "app"
    project_dir.mkdir()
    config_path = _write_config(
        tmp_path,
        f"""
        projects:
          - name: app
            path: {project_dir}
        bearer_token: a-very-long-bearer-token-please
        """,
    )
    with pytest.raises(ConfigError, match="ntfy"):
        Config.load(config_path)


def test_duplicate_project_names_rejected(tmp_path: Path) -> None:
    project_a = tmp_path / "a"
    project_b = tmp_path / "b"
    project_a.mkdir()
    project_b.mkdir()
    config_path = _write_config(
        tmp_path,
        f"""
        projects:
          - name: shared
            path: {project_a}
          - name: shared
            path: {project_b}
        ntfy:
          topic: touchgrass-abc12345
        bearer_token: a-very-long-bearer-token-please
        """,
    )
    with pytest.raises(ConfigError, match="duplicate project names"):
        Config.load(config_path)


def test_nonexistent_project_path_rejected(tmp_path: Path) -> None:
    config_path = _write_config(
        tmp_path,
        f"""
        projects:
          - name: ghost
            path: {tmp_path / "does-not-exist"}
        ntfy:
          topic: touchgrass-abc12345
        bearer_token: a-very-long-bearer-token-please
        """,
    )
    with pytest.raises(ConfigError, match="does not exist"):
        Config.load(config_path)


def test_project_path_must_be_directory(tmp_path: Path) -> None:
    file_path = tmp_path / "not-a-dir.txt"
    file_path.write_text("hi")
    config_path = _write_config(
        tmp_path,
        f"""
        projects:
          - name: file-project
            path: {file_path}
        ntfy:
          topic: touchgrass-abc12345
        bearer_token: a-very-long-bearer-token-please
        """,
    )
    with pytest.raises(ConfigError, match="not a directory"):
        Config.load(config_path)


def test_empty_project_list_rejected(tmp_path: Path) -> None:
    config_path = _write_config(
        tmp_path,
        """
        projects: []
        ntfy:
          topic: touchgrass-abc12345
        bearer_token: a-very-long-bearer-token-please
        """,
    )
    with pytest.raises(ConfigError):
        Config.load(config_path)


def test_short_bearer_token_rejected(tmp_path: Path) -> None:
    project_dir = tmp_path / "app"
    project_dir.mkdir()
    config_path = _write_config(
        tmp_path,
        f"""
        projects:
          - name: app
            path: {project_dir}
        ntfy:
          topic: touchgrass-abc12345
        bearer_token: tooshort
        """,
    )
    with pytest.raises(ConfigError, match="bearer_token"):
        Config.load(config_path)


def test_tilde_expansion(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    project_dir = tmp_path / "code" / "thing"
    project_dir.mkdir(parents=True)
    config_path = _write_config(
        tmp_path,
        """
        projects:
          - name: thing
            path: ~/code/thing
        ntfy:
          topic: touchgrass-abc12345
        bearer_token: a-very-long-bearer-token-please
        """,
    )
    cfg = Config.load(config_path)
    assert cfg.projects[0].path == project_dir.resolve()


def test_tool_overlap_rejected(tmp_path: Path) -> None:
    project_dir = tmp_path / "app"
    project_dir.mkdir()
    config_path = _write_config(
        tmp_path,
        f"""
        projects:
          - name: app
            path: {project_dir}
            pre_approved_tools: [Read, Bash]
            pre_denied_tools: [Bash]
        ntfy:
          topic: touchgrass-abc12345
        bearer_token: a-very-long-bearer-token-please
        """,
    )
    with pytest.raises(ConfigError, match="both pre-approved and pre-denied"):
        Config.load(config_path)


def test_unknown_top_level_field_rejected(tmp_path: Path) -> None:
    project_dir = tmp_path / "app"
    project_dir.mkdir()
    config_path = _write_config(
        tmp_path,
        f"""
        projects:
          - name: app
            path: {project_dir}
        ntfy:
          topic: touchgrass-abc12345
        bearer_token: a-very-long-bearer-token-please
        unknown_setting: oops
        """,
    )
    with pytest.raises(ConfigError):
        Config.load(config_path)
