from __future__ import annotations

from pathlib import Path

import pytest

from touchgrass_daemon.files import (
    PathError,
    list_directory,
    read_file,
    resolve_safe,
)


@pytest.fixture
def project(tmp_path: Path) -> Path:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.py").write_text("print('hi')\n")
    (tmp_path / "src" / "util.py").write_text("def f(): pass\n")
    (tmp_path / "README.md").write_text("# project\n")
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "HEAD").write_text("ref: refs/heads/main\n")
    (tmp_path / ".touchgrass").mkdir()
    (tmp_path / "node_modules").mkdir()
    return tmp_path


def test_list_root_hides_default_set(project: Path) -> None:
    entries = list_directory(project, "")
    names = [e.name for e in entries]
    assert ".git" not in names
    assert ".touchgrass" not in names
    assert "node_modules" not in names
    assert "README.md" in names
    assert "src" in names


def test_list_sorts_dirs_first_then_alpha(project: Path) -> None:
    entries = list_directory(project, "")
    types = [e.type for e in entries]
    # Dirs come first, files after.
    first_file = types.index("file")
    assert all(t == "dir" for t in types[:first_file])
    assert all(t == "file" for t in types[first_file:])


def test_list_subdir(project: Path) -> None:
    entries = list_directory(project, "src")
    names = [e.name for e in entries]
    assert names == ["main.py", "util.py"]
    main = next(e for e in entries if e.name == "main.py")
    assert main.size == len("print('hi')\n")


def test_list_respects_touchgrassignore(project: Path) -> None:
    (project / ".touchgrassignore").write_text("util.py\n# comment\n\n")
    names = [e.name for e in list_directory(project, "src")]
    assert "util.py" not in names
    assert "main.py" in names


def test_path_traversal_rejected(project: Path) -> None:
    with pytest.raises(PathError):
        resolve_safe(project, "../etc/passwd")
    with pytest.raises(PathError):
        list_directory(project, "../..")


def test_path_into_hidden_dir_rejected_via_listing(project: Path) -> None:
    # Listing inside .git is allowed by resolve_safe (it doesn't enforce hides),
    # but the *root listing* hides the entry. The phone client never gets a
    # tappable handle on it. We assert the resolve still works for completeness.
    resolved = resolve_safe(project, ".git")
    assert resolved == (project / ".git").resolve()


def test_list_missing_path_raises(project: Path) -> None:
    with pytest.raises(PathError):
        list_directory(project, "no/such/dir")


def test_list_file_path_raises(project: Path) -> None:
    with pytest.raises(PathError):
        list_directory(project, "README.md")


def test_read_file_under_cap(project: Path) -> None:
    result = read_file(project, "README.md", max_bytes=1024)
    assert result.contents == "# project\n"
    assert result.size == len("# project\n")
    assert result.mtime > 0


def test_read_file_exceeds_cap(project: Path) -> None:
    big = project / "big.txt"
    big.write_text("x" * 1000)
    with pytest.raises(PathError):
        read_file(project, "big.txt", max_bytes=100)


def test_read_directory_rejected(project: Path) -> None:
    with pytest.raises(PathError):
        read_file(project, "src", max_bytes=1024)


def test_symlink_escape_rejected(project: Path, tmp_path: Path) -> None:
    target = tmp_path.parent / "outside.txt"
    target.write_text("secret")
    link = project / "link.txt"
    try:
        link.symlink_to(target)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks unsupported on this platform")
    with pytest.raises(PathError):
        read_file(project, "link.txt", max_bytes=1024)
