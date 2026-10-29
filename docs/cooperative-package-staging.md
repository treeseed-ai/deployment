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
