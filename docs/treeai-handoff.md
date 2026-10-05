# TreeAI qualification-host handoff

TreeAI publishes immutable component releases. Deployment owns their host packages,
catalogs, APT delivery, and lifecycle. This runbook is the one-time transition from
the retired `treeseed-ai-manager` delivery path to `treeseed-manager`; it is not a
second publisher and never builds TreeAI source or images.

## Accepted input

The accepted managed candidate selects TreeAI `0.11.0-rc7` at source commit
`70c136a9784f7180932febcaf5c8563a630a0ed7`. Its `ai-inference`, `ai-training`,
and `ai-lab` component manifests and Compose files must be acquired through an
exact Platform integration lock. Deployment verifies each SHA-256 before creating
the thin component packages. Image digests remain those declared by TreeAI.

Do not begin the host handoff until the signed Deployment development catalog,
generic bootstrap, and explicit profile-initialization plan resolve to the same
immutable Platform commit.

## Capture and backup

The operator performs these steps with root authority while both managers are still
installed but before enabling the unified manager.

1. Record whether every `treeseed-ai-manager-*` timer and service is enabled and
   active. Record the current release, receipt, container identities, health, and
   the contents and SHA-256 of `/var/lib/treeseed-ai/platform/mode.json`.
2. Create a root-owned, mode `0600` archive containing `/etc/treeseed-ai` and
   `/var/lib/treeseed-ai`. Record its SHA-256 outside the archive.
3. Enumerate every Docker volume attached to the legacy inference, training, and
   lab projects. Archive each volume independently with numeric ownership and record
   the volume name, mount point, size, and SHA-256. This includes databases,
   objects, artifacts, archives, model caches, lab state, Hermes state/workspace,
   and Open WebUI state.
4. Verify all archives before pausing either manager. Never delete or rename the
   legacy directories, packages, volumes, containers, or APT source during this
   candidate.

The resulting evidence manifest is the rollback receipt. It must not contain
credential values; it records only paths, service states, identities, sizes, and
digests.

## Controlled cutover

1. Stop and disable the recorded legacy reconciliation/update timers. Let active
   reconciliation finish, then stop the legacy manager API and supervisor. Do not
   remove the TreeAI workload containers yet.
2. Install the exact generic Deployment development candidate, then explicitly
   initialize the intended opt-in AI profile. The accepted host configuration
   must preserve the recorded awake/sleep mode.
3. Copy required legacy state into the new component data roots under
   `/var/lib/treeseed/components` using the mapping below. Resolve actual legacy
   volume names from Docker inspection; Compose normally prefixes the listed
   suffixes with its project name. Retain the original volumes and archives.

   | Legacy volume suffix | Managed component directory |
   | --- | --- |
   | `inference-state` | `ai-inference/data/inference` |
   | `inference-models` | `ai-inference/data/models` |
   | `training-artifacts` | `ai-training/data/training` |
   | `training-archive` | `ai-training/data/archive` |
   | `training-models` | `ai-training/data/models` |
   | `lab-state` | `ai-lab/data/state` |
   | `hermes-home` | `ai-lab/data/hermes` |
   | `hermes-workspace` | `ai-lab/data/workspace` |
   | `open-webui-data` | `ai-lab/data/open-webui` |

   Preserve `inference-postgres`, `inference-objects`, `training-postgres`, and
   `training-objects` in the rollback archive and a read-only legacy holding area;
   they have no direct bind-mount target in `0.11.0-rc7`. Database or object-store
   conversion belongs to an immutable TreeAI migration/import release and must not
   be improvised by Deployment.
4. Start `treeseed-manager-supervisor.service` and
   `treeseed-manager-api.service`, reconcile once, and require the exact component
   packages, Compose digests, and OCI image digests from the signed catalog.
5. Confirm the recorded mode, data counts, model identities, credentials by
   reference, health gates, and routes. A credential value must never appear in
   logs or evidence.
6. Reconcile again. It must return `noop`; unchanged images, including vLLM, must
   retain their container identity and start timestamp.

Only after the complete acceptance window may the legacy manager remain disabled.
Its packages, APT source, state, and volumes remain available until a later,
separately authorized retirement.

## Rollback

If any state, mode, credential reference, health gate, or identity check fails:

1. Pause unified-manager development reconciliation and stop only the newly
   activated AI component projects.
2. Restore the last accepted Deployment receipt and component-state backup.
3. Re-enable and start exactly the legacy services and timers recorded before the
   cutover.
4. Verify the legacy known-good TreeAI generation, awake/sleep mode, data, routes,
   and health. Leave the failed Deployment catalog and packages immutable as
   evidence.

Rollback never deletes the new or legacy state. A retry requires a new Platform
candidate and, when any artifact identity changes, a new Deployment release.

## Disposable qualification-host cutover

When the operator explicitly declares the legacy host state disposable, do not
spend an integration cycle converting it. Record only the old package/service and
container identities needed to prove that the retired lifecycle is no longer
active. Stop and disable the legacy manager, install the exact generic
Deployment candidate, explicitly initialize the opt-in AI profile with newly generated
credentials and empty managed state, and run the same health, mode, no-op, and
rollback gates. Deleting old packages, containers, volumes, or state remains a
separate explicit cleanup after the new generation is accepted.
