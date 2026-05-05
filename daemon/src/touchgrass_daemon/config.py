"""Configuration loading and validation for the touchgrass daemon.

Single source of truth: `~/.touchgrass/config.yaml`. Multi-project from day one — no
single-project shortcut. Validation runs at load time so a malformed config fails fast
with a clear error rather than crashing mid-session.
"""

from __future__ import annotations

from pathlib import Path
from typing import Self

import yaml
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

DEFAULT_CONFIG_PATH = Path("~/.touchgrass/config.yaml")
MIN_BEARER_TOKEN_LENGTH = 16
DEFAULT_PERMISSION_TIMEOUT_SECONDS = 300


class ConfigError(ValueError):
    """Raised when the config file is missing, malformed, or fails validation."""


class ProjectConfig(BaseModel):
    """One project the daemon will accept sessions for."""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1)
    path: Path
    pre_approved_tools: list[str] = Field(default_factory=list)
    pre_denied_tools: list[str] = Field(default_factory=list)

    @field_validator("path", mode="before")
    @classmethod
    def _expand_path(cls, value: object) -> object:
        if isinstance(value, str):
            return Path(value).expanduser()
        return value

    @model_validator(mode="after")
    def _validate_path_is_dir(self) -> Self:
        resolved = self.path.expanduser().resolve()
        if not resolved.exists():
            raise ValueError(f"project path does not exist: {resolved}")
        if not resolved.is_dir():
            raise ValueError(f"project path is not a directory: {resolved}")
        # Re-assign through model_copy machinery so the absolute path is what callers see.
        object.__setattr__(self, "path", resolved)
        return self

    @model_validator(mode="after")
    def _validate_no_tool_overlap(self) -> Self:
        overlap = set(self.pre_approved_tools) & set(self.pre_denied_tools)
        if overlap:
            raise ValueError(
                f"tools cannot be both pre-approved and pre-denied: {sorted(overlap)}"
            )
        return self


class NtfyConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    topic: str = Field(min_length=1)


class Config(BaseModel):
    """Top-level daemon configuration."""

    model_config = ConfigDict(extra="forbid")

    projects: list[ProjectConfig] = Field(min_length=1)
    ntfy: NtfyConfig
    bearer_token: str = Field(min_length=MIN_BEARER_TOKEN_LENGTH)
    permission_timeout_seconds: int = Field(
        default=DEFAULT_PERMISSION_TIMEOUT_SECONDS, gt=0
    )
    bind_address: str = "0.0.0.0"  # noqa: S104 — Tailscale gates network reach
    port: int = Field(default=8765, gt=0, lt=65536)

    @model_validator(mode="after")
    def _validate_unique_project_names(self) -> Self:
        names = [p.name for p in self.projects]
        if len(names) != len(set(names)):
            duplicates = sorted({n for n in names if names.count(n) > 1})
            raise ValueError(f"duplicate project names: {duplicates}")
        return self

    @classmethod
    def load(cls, path: Path | None = None) -> Self:
        """Load config from `path` (default `~/.touchgrass/config.yaml`).

        Raises `ConfigError` for missing files, YAML syntax errors, and validation
        failures. The original `pydantic.ValidationError` is chained as `__cause__`
        when validation fails, so the full field-level detail is still available.
        """
        resolved = (path or DEFAULT_CONFIG_PATH).expanduser()
        if not resolved.exists():
            raise ConfigError(f"config file not found: {resolved}")
        try:
            raw = yaml.safe_load(resolved.read_text())
        except yaml.YAMLError as exc:
            raise ConfigError(f"malformed YAML in {resolved}: {exc}") from exc
        if not isinstance(raw, dict):
            raise ConfigError(
                f"config root must be a mapping, got {type(raw).__name__} in {resolved}"
            )
        try:
            return cls.model_validate(raw)
        except Exception as exc:
            raise ConfigError(f"invalid config in {resolved}: {exc}") from exc
