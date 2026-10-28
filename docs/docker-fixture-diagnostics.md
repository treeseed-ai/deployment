# Safe Docker fixture failure read-back

The native npm-source acceptance program must retain its real default construction, inputs,
assertions, script/credential canaries and deadlines. If it fails, retain the original blocker
and append bounded read-only Docker prerequisite observations. This is fixture diagnostic
code, not a production error change, a retry or a replacement for any required gate.

The actual default Docker command adapter queries the exact fixture context, engine info and
Compose version after the original failure. Report only fixed category/status and elapsed
milliseconds. Discard raw stdout/stderr, configuration, context names, endpoints, credentials
and environment. Missing/malformed fixture configuration reports a fixed unavailable result.
These observations describe subsequent read-back, not proof of the original failure's cause.

Each existing command remains bounded to five seconds; at most three read-only queries run.
Do not change the original 120-second child or any enclosing CI/test deadline. Successful
scenarios execute no extra probes. No containers, networks, images or host state are changed.
A permanent integration case runs the real default adapter and checks fixed safe output.

Examples motivating this boundary are #1027 job 123072690913 and #1028 jobs 123117656761
and 123123662352, which reported only DOCKER_UNAVAILABLE. Broad workflow/policy changes
remain a separate proposal; this bounded fixture implementation adds no such changes.

## Preserve exact planning failure evidence

The planning host preserves the existing SDK PlanningBlockedError class, DOCKER_UNAVAILABLE
blocker code/message and machine envelope. When the real native Docker adapter returns null,
attach its immutable safe failure record as a non-enumerable standard Error cause. No protocol
field or logging is added. The evidence contains only fixed command category/kind, bounded
status/signal and elapsed time; no arguments, paths, environment, output or exception text.
Custom adapters retain the same null/blocker behavior without fabricated native evidence.

Built default planner consumers must observe that exact cause before any installation state is
created. The npm source fixture retains its original safe blocker/read-back message and appends
only whitelisted cause category/kind. It never prints arbitrary error causes or original blocker
messages, which may be supplied by a provider. An import guard permits safe unit qualification
of this formatter without starting the fixture; the actual compiled program remains tested.

This follow-up depends on exact invocation evidence #1034 and follows documentation, built public
failure tests and sanitizer tests before implementation. It investigates the original failure;
it adds no retries, weaker deadlines, activation, shared workflow changes or issue closure.
