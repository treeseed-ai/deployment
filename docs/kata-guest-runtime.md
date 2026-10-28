# Exact guest runtime admission

Deployment's `GuestRuntimeArchive` reads one explicitly selected immutable NPM archive through
`@treeseed-cordis/deployment/sandbox`. Configuration binds an owner-private directory,
single archive filename/hash/size and expected package name/version. `read(signal)` returns the
SDK-validated manifest and verified executable bytes. It creates no files, imports no package,
executes no lifecycle script or binary and starts no sandbox or host process.

Admission is a coherent host invariant, not a replaceable trust decision. Future native sandbox
providers may select accepted runtime artifacts but cannot bypass these checks. Agent owns the
guest program and manifest producer; Deployment owns custody and guest-only staging. Actual
session readiness, assignment authority, environment receipts and physical destruction remain
separate required gates. This module alone proves no active capacity.

Use SDK's `treeseed.guest-runtime/v1` binding. Inspect the complete archive under the existing
64 MiB aggregate / 8 MiB member limits before collecting the exact `dist/bin/guest-runtime.json`
and declared `dist/bin/trsd-agent-guest.NNN.gzpart` files. Reject duplicate/unsafe archive members,
wrong package identity, undeclared runtime chunks, bad hashes/sizes/modes, mutable references,
malformed JSON and interrupted reads. Read custody through descriptor-anchored no-symlink
primitives; require owner-private directory and file. Never extract the archive.

Verify every part, aggregate gzip digest/size and bounded 128 MiB expansion. Expanded identity
must match the manifest. Parse ELF64 little-endian amd64 program/dynamic headers without an
external executable: require the exact GNU interpreter and exact five declared dynamic library
names. Reject out-of-range/ambiguous headers, unsafe strings, missing or extra dependencies.
An ELF check is structural admission; only actual hosted Kata execution qualifies compatibility.

Outside-in tests run the built public reader against a genuine prepared NPM test archive using
the pinned Bun toolchain ELF as a harmless fixture payload, never as an Agent implementation.
Lower tiers cover archive tampering/foreign custody/cancellation and ELF/manifest rejection.
The separate genuine accepted Agent archive consumer must pass before review. Keep all existing
owner/hosted gates. This slice consumes accepted SDK #502 and is submitted only after the exact
SDK owner closure integrates, retaining the ten-file gate. All issues stay open; Work stays Task 10.
