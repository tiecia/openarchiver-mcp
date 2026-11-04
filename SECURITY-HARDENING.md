# Security hardening in this fork

This fork retains the upstream MIT license and attribution. It is a small read-only MCP wrapper, not an OpenArchiver server or mailbox client. The security work starts from upstream/fork commit `1541f8929c88ae6e79678552c3ae1f9b6410d68a` (v1.3.3). No deployment or image publishing is included in this change.

## Security boundaries

- The archive URL is operator configuration, not a model argument. Production connections require HTTPS and normal certificate validation. Redirects are rejected so `X-API-KEY` cannot follow them to another origin. URL credentials, query strings and fragments are not accepted.
- Only archive search/read/download/integrity operations exist. The OpenArchiver API remains responsible for record authorization. Use a dedicated identity with only `search:archive` and `read:archive`, and test denial of out-of-scope email IDs and storage paths on your installed version. The MCP wrapper's read-only methods do not restrict a stolen overprivileged API key.
- All email-derived content is untrusted, including metadata, filenames, body, attachment text and integrity diagnostic fields. Output labels are provenance reminders, not a prompt-injection defense. Do not combine unsolicited email processing with unrestricted shell, secrets, network-posting or infrastructure tools. Model-provider requests, transcripts and reports can contain private email.
- First-party tool errors must not reflect arbitrary upstream response bodies or exception messages. Operator diagnostics must never log the key or complete sensitive messages.

## Resource and attachment policy

The hardening enforces these fixed limits (the model cannot raise them):

| Resource | Policy |
|---|---|
| Decoded API JSON response | 32 MiB before JSON parsing |
| Raw MIME message | 5 MiB before buffer allocation/MIME parsing |
| MIME/HTML parsing | Worker thread, fixed 3-second deadline; shutdown terminates active workers |
| Parser V8 limits | 128 MiB old generation, 16 MiB young generation, 4 MiB stack; not total RSS/native-memory limits |
| HTML preflight | Conservative linear structural scan: 100 nesting levels, 10,000 nodes/markup candidates, 5 MiB input; ambiguous/malformed markup may be rejected |
| Attachment download | 10 MiB hard cap; inline default 5,000,000 bytes; caller may request less |
| Model-visible text | 64,000 JavaScript UTF-16 code units, including an explicit truncation marker |
| Inline images | Maximum 5 MiB before base64 encoding; larger images return a controlled error suggesting file mode so the MCP transport stays below its receive ceiling |
| Active operations / queued operations | 2 / 8 across all tools, including parsing and writes |
| Temporary attachment storage | 100 files and 100 MiB per process |
| Temporary copy lifetime | 15 minutes; sweeps every minute (deletion can lag by up to one minute) |

The decoded-byte check applies even when Content-Length is missing or the response is compressed. Content-Length is validated but is never the sole limit. A 32 MiB JSON cap does not equal a 32 MiB heap cap: JSON objects/arrays, strings, parser state and copies need additional memory.

Downloading attachments is disabled by default; enabling it is an explicit operator decision via `OPENARCHIVER_ENABLE_ATTACHMENTS=true`. The tool remains discoverable while disabled and returns an error without contacting OpenArchiver.

Attachment file writes are not archive mutations: they create local copies in private process-owned temporary storage. Filenames are sanitized and callers cannot select the destination. Temporary copies are still sensitive data. Normal shutdown cleanup is best effort; SIGKILL, host failure and persistent volumes need an external cleanup policy. Keep the temp root on a dedicated ephemeral filesystem with a storage quota; do not mount shared host directories.

MIME workers provide an interruptible resource boundary, not an OS security sandbox: they share process privileges and can access the process environment/filesystem. Their V8 heap limits do not cap total RSS or native/ArrayBuffer allocations. Container/process memory, CPU, disk and network restrictions remain separate deployment controls. The default worker returns only bounded body text and is terminated on deadline/shutdown; internal injected-parser/worker URL options exist for tests and are not exposed via MCP/environment configuration. Conservative HTML preflight may reject malformed or very complex legitimate mail rather than risk uncontrolled parsing. stdio itself does not isolate the MCP from the Hermes process user or its filesystem.

## Local testing

The only HTTP exception is explicit loopback-only test configuration: `OPENARCHIVER_ALLOW_HTTP_LOOPBACK=true`. Never use it as a production workaround or to disable TLS for remote hosts. Integration tests use a throwaway OpenArchiver stack and dummy credentials; do not run them against production. The existing integration compose stack publishes ports, so isolate it and bind test services to localhost before use on a shared host.

Run:

```sh
npm ci --ignore-scripts
npm test
node scripts/smoke.mjs
npm audit --omit=dev
npm audit
```

Tests should demonstrate refusal of cross-origin redirects, streamed body overflow (including missing/misleading length headers), safe errors, MIME limits, restricted temp files, bounded queueing, disabled attachment behavior and MCP compatibility. A mock-based test does not establish production authorization or real OpenArchiver compatibility. Confirm that separately using synthetic archived mail.

## Dependencies and maintenance

Dependencies are resolved in the committed lockfile; install scripts are disabled for verification. Both `npm audit` and `npm audit --omit=dev` reported zero known vulnerabilities after this lockfile refresh. All resolved packages use registry.npmjs.org and none is marked with an install lifecycle script. These are time-bound checks, not proof that dependency code is benign. Do not use runtime `npx` installation or unreviewed automatic updates. A top-level package version does not pin its transitive dependency graph.

For each upstream update:

1. Review the source diff, lifecycle scripts, dependency changes and release automation.
2. Reapply or remove patches only after the security regressions still pass.
3. Run all tests, MCP smoke and dependency scans.
4. Independently review the final diff before merging.
5. Build and deploy a pinned artifact as a separate reviewed change.

Do not run the inherited upstream npm publishing workflow from this fork without separately configuring/reviewing its publishing identity. This hardening PR does not publish a package or alter the running homelab.
