# mend-patch-cli

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Patricio1981/mend-patch-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Patricio1981/mend-patch-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

A zero-dependency Node 22 implementation of `mend` (`SPEC.md` version 1) that atomically applies AI-generated patches across all four formats — unified diffs, SEARCH/REPLACE blocks, V4A patches, and JSON edits — with automatic format detection, three-tier whitespace/indentation matching with `P -> F` re-indentation and context preservation, strict mode, CRLF/LF and EOF newline handling, and rename tracking.

## Run it

```sh
# Apply a patch from stdin or a file
node main.ts [--format=auto|unified|search-replace|v4a|json] [--check] [--strict] [PATCH]

# Run the practice suite
node check.ts <path-to-practice.json>
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=v0j7g19a&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
