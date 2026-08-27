# Large Repository Workflow

The bridge guarantees accounting and reproducible delivery; it does not claim
that one model context can simultaneously retain every line of a large
repository.

## Index Contract

- Git is the file inventory source. Every tracked path has an explicit status.
- Text is split by line and UTF-8-safe byte boundaries. Large files and large
  single lines are supported.
- A snapshot is bound to the canonical worktree path, branch, commit, dirty
  file hashes, and chunk hashes.
- TypeScript, JavaScript, and Python receive AST symbol coverage. Other
  languages remain raw-text searchable and are reported as unsupported by the
  symbol index.
- CodeGraph supplies symbol relationships and impact context only when its
  status matches the current worktree. Its file count is not the repository
  completeness metric.

## ChatGPT Pro Sequence

```text
repo_open(projectPath)
repo_map(snapshotId) until complete
repo_context(snapshotId, task) for task-focused orientation
repo_scan(action=start, snapshotId)
repeat:
  repo_scan(action=next, scanId)
  read and summarize returned chunks
  repo_scan(action=ack, scanId, chunkIds, summaries)
repo_coverage(snapshotId, scanId)
```

A scan is complete only when all chunks are acknowledged and no chunk failures
remain. Delivered but unacknowledged chunks are intentionally not treated as
read.

## Branches

Create a stable worktree for each branch and call `repo_open` on each worktree.
Use `repo_compare` for branch/ref differences. If a file changes after a
snapshot, `repo_read` fails as stale instead of returning content under the old
snapshot identity.

## Coverage Interpretation

- `trackedFiles == accountedFiles` proves inventory coverage.
- `indexedLines` and `totalChunks` describe raw text coverage.
- `symbolIndex.status=complete` proves parsing completed for supported files;
  `unsupportedFiles` remains explicit.
- `acknowledgedChunks == totalChunks` with zero failures proves the connector
  delivered and the caller acknowledged every indexed chunk.
