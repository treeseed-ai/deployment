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

## Endpoint descriptor ownership

The server runs in the qualified Bun host runtime. Its native Unix-socket provider loads only an
explicit root-owned SHA-256-pinned ELF socket library through a held no-symlink descriptor. It
binds a fresh socket, then transfers that listening descriptor to the Node-compatible server.
Closing an adopted descriptor leaves pathname cleanup with checked Deployment custody. Ordinary
pathname binding delegates automatic unlink to the runtime and cannot provide that ownership
boundary. The client remains compatible with Node and Bun; invalid host construction fails safely
before loading native code.

An isolated Bun 1.4.4/Linux x64 spike proved a fixed AF_UNIX descriptor can be bound, adopted by
`node:net`, round-trip data and close while leaving its original socket path for verified cleanup.
This is mechanism evidence only; permanent provider and actual hosted default-root tests remain
mandatory. The pinned [libuv pipe close source](https://github.com/libuv/libuv/blob/v1.51.0/src/unix/pipe.c)
explains automatic pathname unlink, while its descriptor-open path carries no pathname ownership.
Socket cleanup must close the known descriptor even if the original path has become foreign;
that foreign state is preserved and disposal reports repair rather than successful removal.

A descriptor returned by the native binder remains endpoint-owned until the server adopts it.
If socket identity validation fails before adoption, close that known descriptor, preserve the
foreign pathname and report failure. Native disposal must not leave a listener open merely
because the endpoint was replaced between binding and adoption.

The channel selects SDK .37, reviewed source dce3108e061ecaf0cfa2915c03698f0e3170a67b,
archive SHA-256 886a9f359148a1aee49997de7e0604c65c87bf16c693d23781c5732f41990384.
It retains the accepted guest backend and the existing sandbox-control family, alongside
the portable worker/guest envelopes consumed by Agent. This selection adds no ungranted
operation or service mount. The owner closure prerequisite must land before this bounded
channel candidate is submitted, keeping its PR within ten files.

Client dialing pins the socket inode through a Linux `O_PATH | O_NOFOLLOW` descriptor and
connects through its `/proc/self/fd` reference. The ordinary selected pathname is still checked
before request publication and accepted reply, so replacement causes a safe failure. The held
reference prevents a transient replacement from redirecting the actual connection, and its
cleanup is mandatory before reporting a successful exchange. This is Linux-only IO, alongside
the qualified local Unix-socket host boundary.

An isolated Node 24.19.0 / Bun 1.4.4 spike connected to the original pinned peer while its pathname
was occupied by a different listening peer. The [Linux open manual](https://man7.org/linux/man-pages/man2/open.2.html)
defines `O_PATH` descriptor metadata semantics; permanent real Unix boundary tests qualify the
actual connect behavior, rather than relying on the manual alone.

Availability binds the host configuration after parsing through the public Kata provider
configuration schema, including its defaults. Consumers compare that normalized configuration
digest; hashing raw input before defaults does not identify the composed host.

An unauthenticated peer receives no response body. The client classifies an empty EOF as
`SANDBOX_PROVIDER_UNAVAILABLE`; a nonempty malformed or mismatched reply remains
`SANDBOX_RESPONSE_MISMATCH`. Both paths close held descriptors and expose no credential detail.
