# Private service sandbox control

Deployment owns the authenticated local sandbox transport beneath the Agent worker's typed
SDK sandbox-control client. This is a distinct native capability and endpoint, never an extension
of the observer socket. It exposes only ready/create/inspect/assign/execute/destroy messages.
Trusted host composition selects the existing Kata provider and exact immutable environments.
No worker request supplies runtime configuration, image references, commands or host paths.

The public package entry is `@treeseed-cordis/deployment/sandbox-control`. The real default
`SandboxControlApplication` constructs a native root with the Kata provider and control endpoint.
`SandboxSocketClient` supplies SDK's typed interface. Scope binds the installation, service and
provider/service generations to a host-owned expiring grant. The actual manager/worker/guest
composition and process readiness are separate SDK capacity-protocol evidence, not a claim made
by transport availability.

## Custody and framing

The host reads an owner-private authority record containing the SDK grant and an opaque 256-bit
service credential. The channel never generates credentials. Installation/seed application owns
issuance and explicit service mounts; that integration remains required. This initial transport
slice is not proof of installed container grants or live team authority.

The endpoint directory is owner-private mode 0700 and contains a mode-0600 Unix socket. Bind only
a fresh endpoint. Descriptor-anchored directory/file checks reject symlinks, hardlinks, wrong
ownership/modes and identity replacement. Cleanup stops the known listener, drains or cancels
known requests, verifies endpoint identity and removes only its original socket. Foreign state
survives with an explicit repair failure. Do not replace a live or uncertain endpoint silently.

Each connection carries one bounded strict JSON newline frame with the credential and SDK
request. Compare credential bytes in constant time; reject malformed/duplicate keys, trailing
frames, oversized data, ungranted operations, expired/revoked grants and scope changes before
host effects. Raw credentials and provider error text never enter replies or logs. Authentication
is independent of the socket's private filesystem boundary. Fresh authority/endpoint validation
also precedes accepted replies; cancellation and expiry propagate to the bounded host operation.

The client resolves only its explicit private authority and endpoint configuration, verifies
identities around connection, sends one SDK request, validates one matching reply and closes its
own socket. No ambient installation/account fallback or unbounded command path exists. Caller
abort closes its connection; a lost reply does not authorize duplicate allocation or adoption.
The host's existing assignment/phase/destruction journal remains owner authority for retries.

## Native lifetime and verification

One selected native control plugin acquires the selected Kata capability through Cordis, with
leases retained through each operation and awaited disposal. The locator remains a facade;
transport connections are tracked for drain, not cached service instances or another scheduler.
Worker/provider replacement remains restart-only until exact transition qualification.

Ordinary tests run built public denial paths and genuine Unix peer/authentication/identity
boundaries. The actual default root and client must additionally round-trip the real pinned
Kata backend on hosted Ubuntu 26.04 x64/KVM, assign and prepare an offline guest, reject wrong
scope/credential, and verify physical destruction and native/socket cleanup. Injected providers
alone cannot qualify default construction. Retain all historical owner checks, test tiers and
smoke partitions. Real pool/guest programs, allow-list egress, live enrollment, seed/CLI and
installed final assembly remain required. Keep every issue open; Work/models remain Task 10.
