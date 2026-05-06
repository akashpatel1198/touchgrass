.DEFAULT_GOAL := help

UNAME := $(shell uname)

# Wrap the daemon in a sleep-prevention shim. If your laptop sleeps mid-session,
# the SDK process dies and any in-flight tool calls are orphaned. Don't skip this.
ifeq ($(UNAME),Darwin)
RUN_PREFIX := caffeinate -i
else ifeq ($(UNAME),Linux)
RUN_PREFIX := systemd-inhibit --what=sleep --who=touchgrass --why="active Claude Code session"
else
RUN_PREFIX :=
endif

.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

.PHONY: dev
dev: ## Run the daemon under a sleep-prevention shim (caffeinate / systemd-inhibit)
ifeq ($(RUN_PREFIX),)
	@echo "warning: no sleep-prevention shim known for $(UNAME); running bare"
	cd daemon && uv run touchgrass-daemon
else
	@echo "running daemon under: $(RUN_PREFIX)"
	cd daemon && $(RUN_PREFIX) uv run touchgrass-daemon
endif

.PHONY: test
test: ## Run the daemon test suite
	cd daemon && uv run pytest

.PHONY: typecheck
typecheck: ## Run mypy in strict mode against the daemon
	cd daemon && uv run mypy

.PHONY: lint
lint: ## Run ruff against the daemon
	cd daemon && uv run ruff check

.PHONY: format
format: ## Auto-format with ruff
	cd daemon && uv run ruff check --fix && uv run ruff format

.PHONY: check
check: lint typecheck test ## Run lint + typecheck + tests
