# Supplier workflows: Track H and Track M

## Shared evidence model

Both tracks ultimately append the same core fields to a serialized chain: owner, track, external reference, action/event type, commitment `C`, manifest hash, occurred time, Worker receive time, position, previous proof, event proof, credential identity, idempotency key, and optional domain links. Both receive an immediate Ed25519-signed receipt with `pending_anchor`.

Original content is not stored by the event write path. The legacy nullable `events.encrypted_capsule` column still exists but current append code never writes it.

## Track H: human records through UI and API

Track H is available to a Supplier whose mode is `H` or `both`. It supports both the web UI and authenticated browser-style API calls.

### Event catalog

A Supplier first creates stable event types such as `made-food-delivery`, with display name and optional description. An event type can have instances, such as a particular delivery run, although the present UI creates and lists event types but does not expose event-instance creation. API routes do.

Event types and instances are owner-scoped and can be `active` or lifecycle states defined by D1. Creating them requires an authenticated Supplier, CSRF, and active writer plan.

### Cases

A Track H case has an owner-scoped `case_ref`, title, optional description/category, status, and eventual chain link. References are 3–128 characters and support letters, numbers, dot, underscore, colon, slash, and hyphen. The current UI can create and list cases, select a case, load its timeline, and append evidence.

### Browser hashing and append

For each record the Supplier chooses exactly one local file or structured note. The browser permits up to 128 MiB and:

1. reads the exact file bytes or UTF-8 note;
2. computes `H = SHA-256(content bytes)`;
3. generates a random 32-byte record salt;
4. computes `C = SHA-256(UTF8("OD1|CONTENT|") || rawSalt || rawH)`;
5. creates a canonical local manifest containing version, case ID, event-type reference, action, occurred time, content kind, content length, and `C`;
6. computes the manifest SHA-256;
7. sends only event references, action, time, `C`, and manifest hash to the Worker;
8. receives the signed event result;
9. encrypts a local disclosure capsule using the user-entered passcode;
10. downloads one `.odproof` JSON package.

The Worker rejects original/file/capsule/passcode-related keys even when nested. It requires `Idempotency-Key`, a valid commitment and manifest hash, an open owned case, and a catalog event type if `event_type_ref` is supplied.

### Local capsule contents

The capsule contains `H`, the record salt, content kind, file name/type metadata, and—only for a structured note—the original note. For a file, the original bytes are not inside the capsule. The capsule is PBKDF2-HMAC-SHA-256 (310,000 iterations) plus AES-256-GCM and is bound by authenticated data to the returned event ID.

The passcode, salt used by PBKDF2, encrypted capsule, and downloaded `.odproof` are not sent back to D1 by this flow. The Supplier must retain the proof package, its passcode, and any original file needed for later comparison.

### Corrections

Track H never overwrites an evidence event. A correction appends a new event and stores `corrects_event_id`. The target must belong to the same owner and chain. The UI exposes an optional correction event ID. Current UI submission does not send `correction_reason`, although the API service can merge one into metadata.

## Track M: machine records via API; review through UI

Track M is available to a Supplier whose mode is `M` or `both`. Source and credential management can use the web UI. Machine event writes themselves require a scoped API key; the UI intentionally contains no record-entry form.

### Sources

A Source is a stable owner-scoped identity such as `drone-07`. It has a label, optional type and metadata, one sequence policy, lifecycle state, last sequence, last receive time, and eventual chain link. The policy is:

- `strict`: reject a sequence not greater than the last observed sequence;
- `accept_and_flag`: append it and label it `out_of_order`.

Increasing sequences are labeled `first`, `in_order`, or `gap`. Omitting sequence produces no sequence status.

Source creation accepts either a suitable API key or a Supplier browser session. Session creation requires Track M mode, active plan, and CSRF. Source reads can also use that session, which is why Track M history appears in the UI.

### Machine evidence inputs

A machine record must provide Source ID, uppercase-compatible action, occurred time, idempotency key, and exactly one evidence representation unless it supplies a final commitment directly:

- `commitment`: precomputed `C`; no content/hash/salt may accompany it;
- `content_hash` plus `record_salt`: server receives `H` but not content;
- canonicalizable `json` plus `record_salt`;
- UTF-8 `text` plus `record_salt`;
- padded `content_base64` plus `record_salt`, decoded size at most 10 MiB.

JSON is deterministically canonicalized before hashing. Text and base64 bytes are hashed directly. For all non-commitment forms the Worker calculates the same domain-separated `C` formula as Track H, builds an `OD-MANIFEST-1`, hashes it, appends the event, returns `content_hash`, `commitment`, manifest, manifest hash, and receipt, and then discards transient content variables. The persistent event metadata contains supplied `params` and `metadata`, not the original `json`, `text`, or base64 field.

Paths, URLs, passcodes, encrypted capsules, and file objects are explicitly rejected, including when nested. Track M therefore supports hashing MP3, MP4, PDF, PNG, or arbitrary bytes only when a client sends their base64 bytes within the 10 MiB request limit or computes `H`/`C` locally for larger content.

### Optional classification fields

Records may link to Supplier event type and event instance, delivery ID, sequence, source-key ID/signature, params, and metadata. If an instance reference is supplied, an event-type reference is mandatory. Current code stores source signatures but does not cryptographically verify them.

### Batch writes

`POST /api/v1/records:batch` requires `record:batch` plus record authorization. The request-level idempotency key is expanded into deterministic per-record keys `<batch-key>:<index>`. Already completed records replay safely. The batch counts as one write for per-minute rate limiting, while its record count must fit the plan. Records are processed sequentially; a mid-batch failure can leave an earlier prefix committed, and retry resumes via per-record idempotency.

### Plan limits

| Plan | Price recorded in D1 | Writes/minute | Records/write |
|---|---:|---:|---:|
| A | $99.00 | 2 | 250 |
| B | $299.00 | 4 | 700 |
| C | $799.00 | 10 | 1,150 |
| D | $1,999.00 | 20 | 2,000 |

The code treats these as Supplier subscription plan prices, but billing-plan rows do not encode a billing interval. Stripe Price objects determine recurrence. Track H consumes one rate-limit write per event. Track M single-record and batch calls consume per-minute writes; batch size is capped by records/write.

### Track M reads

With appropriate scope or Supplier session, the system can list Sources, inspect a Source, list up to 200 recent records, fetch a Source chain, fetch all events for a delivery, fetch a receipt, and report current-month records plus current-minute write usage. All reads remain owner-scoped.
