# Local Docs Indexer

`TOOL_ID=llms-docs-indexer`. Build a compact, deterministic JSON index of local documentation exports. Each entry contains only declared purpose, owner and scope, an explicit review date and freshness state, a SHA-256 content hash, and a local link that the CLI verifies inside the supplied root. The tool never invents a capability from document prose, claims its own authority, fetches a URL, or writes to a source system. It has no dependencies.

## Run

```sh
node bin/llms-docs-indexer.mjs --root examples --manifest manifest.json --policy policy.json
node bin/llms-docs-indexer.mjs --root examples --manifest stale-manifest.json --policy policy.json
npm run check
```

The first example exits 0/pass and omits the internal note from a public index. The second exits 1/fail because the source is one day beyond the freshness limit. JSON goes to stdout only. `--help` lists options. Inputs are relative to `--root`; resolving a symlink outside that real root makes the run incomplete or invalid. No output-file option exists, so evidence cannot be overwritten.

## Input and policy

The manifest is `{ "schemaVersion":"1", "complete":true, "sources":[...] }`. `complete:true` is an explicit assertion by the exporter that the list is complete for its chosen corpus; the tool cannot verify that assertion. A source has exactly `path`, `purpose`, `owner`, `scope`, `dataClass`, and `reviewedOn`. Paths are relative local file names without traversal segments. Purpose, owner and scope are nonblank validated text, each at most 200 UTF-16 units. `dataClass` is `public`, `internal`, or `restricted`. `reviewedOn` is an exact calendar date. Unknown fields or classes are not silently ignored.

The separate policy is `{ "schemaVersion":"1", "audience":"public", "asOf":"2026-01-31", "maxAgeDays":30, "stale":"exclude" }`. Audience is `public` or `internal`. A public index can emit only public sources; an internal index can emit public and internal sources; restricted sources are always omitted. Omitted private sources are counted without publishing their paths or hashes. `maxAgeDays` is a whole number from 0 through 3650. A source at exactly the age limit is current; one day older is stale. `stale` may be `exclude` or `include-flagged`: both raise a failing `stale-source` finding, while the latter emits a visibly `stale` entry. Future review dates are incomplete evidence. The as-of date is supplied, never read from the host clock.

The JSON report has `schemaVersion`, `tool`, `status`, `summary`, `findings`, and `index`. Index rows are sorted by UTF-16 path order. A row has `link`, `purpose`, `owner`, `scope`, `dataClass`, `reviewedOn`, `freshness`, and `sha256`. The CLI resolves every emitted link, then hashes its verified UTF-8 content. Excluded private or stale sources are not opened; omitted private paths and hashes never appear. Findings use the logical `@manifest` source role and a pointer to the source ordinal, never a host path, payload, or parser excerpt. The output is an index of supplied claims, not an endorsement that a document is accurate or that a corpus truly is complete. Treat internal-audience reports as internal data.

Direct library callers may use `buildIndex(manifest, policy, loadSource, { now })` with a trusted source adapter. The adapter must return `{ bytes, identity, linkVerified: true }` only after independently resolving the named link inside its root; bare byte arrays or an unverified link make the result incomplete. The library checks text bytes and bounds itself but cannot prove a caller's attestation about a filesystem it was not given. For filesystem provenance, use the CLI.

| Rule | Outcome | Meaning |
| --- | --- | --- |
| `manifest-unreadable`, `manifest-invalid`, `manifest-partial` | incomplete, exit 2 | Manifest unavailable, malformed, unsupported or explicitly partial |
| `source-invalid`, `source-unknown`, `source-future`, `source-unreadable`, `source-duplicate` | incomplete, exit 2 | A source cannot be safely identified, authorized, or read |
| `record-limit`, `depth-limit`, `source-byte-limit`, `total-byte-limit`, `time-limit` | incomplete, exit 2 | Processing limit exceeded |
| `stale-source` | fail, exit 1 | A permitted source exceeds the declared review age |

Invalid CLI usage or policy is exit 2 with empty stdout. Unreadable manifest or source evidence is exit 2 with an incomplete report. A clean evaluated index is exit 0/pass. Paths and metadata of allowed documents are intentionally in the report; review its audience before sharing it.

Limits: 262,144 manifest bytes, 65,536 policy bytes, 262,144 bytes per source, 4,194,304 total source bytes, 100 sources, manifest JSON depth 3, 200 UTF-16 units per prose field, 256 path characters, max review age policy 3650 days, and 5,000 ms processing time. Exact bounds are accepted; the next unit is refused. Source contents must decode as UTF-8 text without NUL. The tool cannot authenticate exporter permissions, discover unlisted documents, verify ownership, or read remote links. MIT license; see [LICENSE](./LICENSE).
