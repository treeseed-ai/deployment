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
