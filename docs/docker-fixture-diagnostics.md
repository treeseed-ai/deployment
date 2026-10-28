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

## Evidence from the exact failed invocation

`DockerCommands.failure` retains only the most recent failed invocation's fixed command category
(`context`, `engine`, `compose`, `other`), failure kind, elapsed milliseconds, bounded exit status
and a recognized termination signal. A new invocation clears the record; successful commands
leave it null. The property contains no executable path, arguments, context/endpoint names,
environment, stdout/stderr or exception text. Returned records are immutable. Missing executables,
timeouts, output limits, other spawn failures and nonzero exits remain distinct fixed kinds.

The existing execute contract still returns trimmed output or null. Its five-second timeout,
one-MiB output limit, environment and command selection remain unchanged. There is no automatic
retry, logging, new diagnostic envelope or credential handling. A fixture may explicitly pass the
real default `DockerCommands` instance into its host and inspect this record immediately after a
failure; other default-construction acceptance remains intact.

The worker-handoff regression qualifies a real compiled child. Its preparation now retains safe
command evidence if Docker planning fails before launch, while preserving the original error as
the cause. This distinguishes the hosted #1028 job 123154357704 planning failure from the separate
unproven local child exit-3 observation in #1032. The latter is not diagnosed by this change.
Neither case permits weaker assertions or deadlines. Verify built public, integration and unit
consumers before the complete owner/hosted gates. All issues remain open.
