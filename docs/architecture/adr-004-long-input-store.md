# ADR-004: Local authoritative store for large input

- Status: Accepted
- Date: 2026-07-29
- Owners: EnvCAD input application layer

## Context

The v1 transport has a 2 MiB WebSocket message limit and embeds the full prompt
in one provider request. Raising that limit would not remove provider context
windows and would make reconnect, rendering, and privacy behavior worse.

## Decision

Composer text and reference documents use a chunked local ingestion protocol:
`input_begin`, `input_chunk`, `input_commit`, and `input_abort`. A committed
artifact returns an `InputReference` with exact length, media type, chunk count,
source name, and SHA-256 digest.

The content store is authoritative. It preserves exact bytes and UTF-8
character offsets; a summary never replaces source content. Each chunk and the
complete artifact are hashed. Instructions and reference documents are
separate inputs.

Providers receive bounded retrieval capabilities only:

- `get_input_outline`
- `search_input`
- `read_input_chunk`
- `read_input_range`
- `get_input_metadata`

`ContextBudgetManager` measures every provider request and substitutes indexed
references before an envelope would overflow. Summaries cite exact source
ranges. The UI renders metadata, ingestion progress, and retrieval state rather
than the entire large body.

Disk capacity and quota are checked before provider execution. Quota failure
preserves the draft and returns an actionable failure. Persistent content is
encrypted when a platform-backed key is available and has an explicit clear
operation.

## Verification

The release fixture is at least 100 MiB of UTF-8 content, with unique sentinels
at the beginning, middle, and end. Tests prove exact retrieval, complete hash
validation, quota behavior, and bounded provider envelopes.

## Rejected alternatives

- Arbitrary truncation violates exact retrievability.
- A summary-only store loses authoritative user content.
- Sending the complete artifact to every provider turn is neither unlimited
  nor privacy-preserving.
