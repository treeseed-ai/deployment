# Cooperative verified package staging

Deployment owns public `PackageArchiveMaterializer.materializePrivate` and `materialize`,
which preserve checked archive hashes, private no-symlink destination custody and exact member
bytes/modes without importing packages or running lifecycle scripts. Keep both signatures.
The private ArchiveOutput parser must admit bounded portions between real event-loop turns,
honour parser backpressure and stop feeding after failure. An async signature cannot substitute
for yielding: feeding a whole compressed archive can synchronously publish many files and
starve unrelated worker protocol reads despite their unchanged ten-second deadline.

Use the existing pinned tar parser and guards. Retain every path/type/duplicate/member-count,
member/total-size and decompression-ratio restriction, atomic file publication, private output
permissions and final directory verification. Complete the parser only after all input is fed;
settle once on verified end or safe failure and never continue publishing after rejection.
Do not import or execute archive contents. Partial failed destinations require explicit handling;
this change adds no rollback or silent adoption.

Qualify as a built public Node program with a genuine compressed package containing many small
files. A queued observer must repeatedly see partial progress while materialization is pending,
and every completed byte/mode must match. A registration-free fixture supports acceptance and
the regression for the observed starvation; negative integration cases retain integrity guards.
No clock-speed assertion, deadline increase, production error expansion or permanent diagnostic
workflow is needed. Node documents setImmediate as a real turn after I/O callbacks:
https://nodejs.org/docs/latest-v24.x/api/timers.html#timerspromisessetimmediatevalue-options
Check the pinned tar implementation locally; the attempted upstream source fetch timed out.

This is the same coherent package-custody invariant beneath native provider composition, not
another service container or selectable validation bypass. Keep changed methods within twenty
formatted body lines. Existing worker/API deadlines and full installed acceptance stay required.
The API failure is not fixed until a fresh accepted exact owner archive passes that genuine gate.
All issues remain open; Work/model execution remains Task 10; legacy services are untouched.

The feeder supplies at most 256 compressed bytes per turn. The pinned tar parser exposes its
expansion-ratio limit against compressed bytes supplied so far. Scale that intermediate limit
by total input bytes / supplied bytes, retaining the original total-input allowance of 1000
throughout, then restore 1000 at final end. Otherwise a valid dense prefix followed by less
compressible data could be rejected solely because of chunking. A genuine dense-prefix archive
pins that compatibility. Member, metadata and total-output guards remain unchanged.

## Candidate verification

Documentation 487922232 preceded the built Node intended starvation failure 0b8660570 and
regression 6ca79fd79. Hostile archives and whole-input compression accounting were specified
before implementation. Only ArchiveOutput/ArchiveOutputFile and the event helper import change
inside the historical installed module; unrelated source bytes, guards and deadlines remain.
Both classes now have short cohesive methods, with no baseline or exception additions.

After accepted configuration #1051, local checks/build, eight focused cases, complete 19
regression / 228 integration / 82 unit pass. The `.122` archive producer is
`29c801af896bd4bdae2ce310c88319b503a07b50`, with 168 exact source files/modes and SHA-256
`295ec9e2cd9d9e68730867952b222eb1064ac0722cd273dd675957d356d7a95a`.
An empty-cache script-disabled strict TypeScript/Node archive consumer runs the real public
materializer: `cooperative-package-public-ok`. Both complete current-head hosted runs and final
review remain pending. The real API installed gate remains held separately; this local fairness
proof does not establish that its entire failure is resolved.
