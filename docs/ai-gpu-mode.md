# Managed AI GPU mode contract

Deployment is the sole lifecycle authority for the opt-in `ai-gpu` resource. The resource has two stable modes:

- `awake`: inference admission is open, `inference-vllm` is running and warmed, and `training-marker` plus `training-axolotl` are stopped.
- `sleep`: training admission is open, the two training GPU workers are running, and `inference-vllm` is stopped.

The manager closes admission and waits for active work to reach zero before stopping a workload. A timeout produces a durable `postponed` receipt; active work is never killed. Failures close both gates, attempt rollback to the prior stable mode, and otherwise persist `degraded`. Startup recovers an interrupted receipt before serving requests. Reconciliation also repairs the selected mode and does not recreate an already-running warmed vLLM when its runtime fingerprint is unchanged.

## Component runtime declarations

TreeAI component releases declare `runtime.modeControl` from the SDK contract:

```json
{
  "resource": "ai-gpu",
  "role": "inference",
  "gate": {
    "service": "inference-api",
    "executable": "/usr/local/bin/treeseed-ai-gpu-gate"
  },
  "services": {
    "base": ["inference-postgres", "inference-migrations", "inference-evaluator", "inference-manager", "inference-api"],
    "gpu": ["inference-vllm"],
    "warm": "inference-vllm"
  }
}
```

Training uses role `training`, gate service `training-api`, base services that do not claim a GPU, and GPU services `training-marker` and `training-axolotl`. The lab uses role `controller`, an empty GPU list, and:

```json
{
  "transport": "mtls",
  "clientCommonName": "client-ai-lab-mode",
  "path": "/v1/ai/mode"
}
```

The inference and training API images must contain `/usr/local/bin/treeseed-ai-gpu-gate`. It accepts only `open`, `close`, or `status` and emits exactly one JSON object with `admission` (`open` or `closed`) and non-negative integer `active`. Closing the training gate stops new Marker/Axolotl claims; closing inference rejects new inference admission while allowing admitted requests to drain. The vLLM image must contain `/usr/local/bin/treeseed-ai-warm`, which returns successfully only after the pinned model can answer a bounded warm-up request.

Compose must permit every `services.base` set to become healthy without starting a GPU service. It must also permit the manager to start or stop the declared GPU services with `docker compose up --no-deps` and `stop`. No other service name or executable is accepted by the privileged supervisor.

## Lab control surface

The lab calls `POST $TREESEED_AI_MODE_URL` with `treeseed.ai-mode-request/v1`. The manager injects the URL and these container secret paths:

- CA: `/run/secrets/ai-mode-ca`
- certificate: `/run/secrets/ai-mode-client-cert`
- private key: `/run/secrets/ai-mode-client-key`

The corresponding Compose secrets use manager-generated sources `/etc/treeseed/credentials/ai-mode-ca.crt`, `/etc/treeseed/credentials/ai-mode-client.crt`, and `/etc/treeseed/credentials/ai-mode-client.key`. The lab attaches `host.docker.internal:host-gateway`; it receives no host bind, Docker socket, bearer manager credential, or general manager permission. A client certificate with CN `client-ai-lab-mode` is rejected from every manager path except `GET` and `POST /v1/ai/mode`.

Example request:

```json
{
  "schemaVersion": "treeseed.ai-mode-request/v1",
  "target": "sleep",
  "idempotencyKey": "library-run-018f",
  "drainTimeoutSeconds": 900
}
```

Operators use the same authority through `trsd ai mode show` and `trsd ai mode set awake|sleep`. Receipts conform to `treeseed.ai-mode-transition-receipt/v1` and are retained under `/var/lib/treeseed/manager/ai-mode`.

When inference or training is disabled, the mode surface reports `unavailable`, no credentials are generated, and no GPU workload or separate mode service is created.
