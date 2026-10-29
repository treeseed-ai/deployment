# Bounded durable package publication

Deployment's public `PackageArchiveMaterializer.materializePrivate` and `materialize` retain
their signatures. Cooperative archive feeding fixed starvation, but each synchronous member
publication still waits for file and directory fsync. The local API installed fixture spent
146.631 seconds staging its repeated exact closures and exceeded its unchanged installation
window. A genuine 513-member materialization spent 3104.83 of 3186.94ms inside that publisher
on Node 24.22.1; these are configuration-specific observations, not a portable timing guarantee.

Use a private queue of at most eight outstanding member publications. The pinned tar parser's
ReadEntry starts paused; wait for a free slot before attaching/resuming its content. Preserve
the current 256-byte cooperative feeder, backpressure and all original whole-input expansion,
metadata, member count, member/total size, exact archive hash, path, duplicate and type guards.
Do not buffer an unbounded queue of completed files. Only distinct admitted names may overlap.

Each publication retains an anchored private directory and an exclusive no-follow temporary
file through asynchronous write, file fsync, no-overwrite link, parent-directory fsync, own
temporary unlink and exact read-back. Keep file/ancestor identity, ownership, single-link and
private mode checks. Existing synchronous journal publication is unchanged. No shared-file
writes, skipped fsync, mutable cache, package imports or lifecycle scripts are allowed.

Failure stops feed/admission and aborts the current collecting entry. Wait for every started
publication to settle and close its owned descriptors before rejecting with the existing fixed
safe error. No asynchronous publication may outlive rejection. Never adopt or silently reuse a
partial destination. Final success requires parser end, empty queue, exact read-back and verified
target identity; readable output modes are applied only after that boundary.

## Implementation and review plan

1. Commit this interface and CHANGELOG first. Add a genuine built Node public-program assertion
   that more than one temporary file is observable during pending materialization, at most eight
   are outstanding, and all completed bytes/modes match. This is an overlap assertion, not a
   machine-speed threshold. Record the intended preimplementation failure.
2. Pin the observed serial-publication defect in regression. Exercise real archive/filesystem
   integrity, read-back, existing-name and ancestor-replacement failures, backpressure, terminal
   cleanup and descriptor counts through public interfaces. Shared fixtures register no tests.
3. Refactor only ArchiveOutput's immediate parsing/publication boundary into cohesive small
   classes and a private async publisher/queue. Every changed executable method remains within
   twenty canonical body lines; no baseline additions or exceptions.
4. Run owner checks/build/all lower tiers, existing public fairness tests, exact archive consumer
   and both complete hosted acceptance runs, including genuine installed worker and Kata gates.
   Package identity advances only when the candidate is ready. Requalify API using an accepted
   exact artifact; do not infer its deadline passes from a microbenchmark.

At most ten changed files: this document, CHANGELOG, package identity, installed module, one
private publication module, behavior-named acceptance/regression/integration specifications and
registration-free support. No deadline/assertion changes, permanent diagnostic process change,
seed semantics, Work/model execution, legacy mutation or production action. All issues stay open.

Node documents asynchronous filesystem operations using its threadpool and requires callers to
synchronize writes to a file and explicitly close file handles:
https://github.com/nodejs/node/blob/main/doc/api/fs.md
The implementation must verify the actual pinned tar 7.5.22 paused-entry behavior and Node/Bun
runtime support rather than treating documentation or the disposable probe as qualification.
