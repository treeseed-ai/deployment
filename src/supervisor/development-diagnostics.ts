/** Structured metadata only: never forward raw container messages, SQL, or values. */
export function developmentDiagnosticEvents(output: string): Array<Record<string, string | number | boolean>> {
  const events: Array<Record<string, string | number | boolean>> = output.split('\n').slice(-200).flatMap(line => {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (typeof value.claimed === 'boolean' && typeof value.ok === 'boolean') {
        const operation = value.operation && typeof value.operation === 'object' ? value.operation as Record<string, unknown> : {};
        const result: Record<string, string | number | boolean> = { event: 'runner.poll', ok: value.ok, claimed: value.claimed };
        for (const key of ['id', 'namespace', 'operation', 'status']) {
          const field = operation[key];
          if (typeof field === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(field)) result[key === 'id' ? 'operationId' : key] = field;
        }
        const error = value.error && typeof value.error === 'object' ? value.error as Record<string, unknown> : {};
        if (typeof error.code === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(error.code)) result.code = error.code;
        return [result];
      }
      if (!['operation.internal-error', 'operation.failed', 'operation.output-contract-invalid'].includes(String(value.event))) return [];
      const result: Record<string, string | number | boolean> = { event: String(value.event) };
      for (const key of ['operationId', 'requestId', 'name', 'code', 'constraint']) {
        const field = value[key];
        if (typeof field === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(field)) result[key] = field;
      }
      if (typeof value.status === 'number' && value.status >= 400 && value.status <= 599) result.status = value.status;
      return [result];
    } catch { return []; }
  });
  const code=developmentStartupCode(output);
	if(code) {
		const event: Record<string, string> = {event:'development.startup-error',code};
		const packageName = output.match(/Cannot find package ['"](@?[A-Za-z0-9_-]+(?:\/[A-Za-z0-9._-]+)?)['"]/u)?.[1];
		if (packageName && !packageName.includes('..')) event.package = packageName;
		else {
			const modulePath = output.match(/Cannot find module ['"](?:file:\/\/)?(\/app\/[A-Za-z0-9@._+\/-]+)['"]/u)?.[1];
			if (modulePath) {
				event.moduleScope = 'application';
				const relative = modulePath.slice('/app/'.length);
				if (!relative.includes('..') && relative.length <= 192) event.module = relative;
			}
		}
		events.push(event);
	}
  return events;
}

/** Fixed classifications only; only bounded /app-relative public source paths may accompany a module failure. */
export function developmentStartupCode(log:string):string {
  for (const code of ['openbao_not_ready', 'bootstrap_http_403', 'bootstrap_recovery_required', 'bootstrap_state_mismatch',
    'os_credential_unavailable', 'key_unavailable'] as const) {
    if (log.includes(`(${code})`)) return code.toUpperCase();
  }
  for(const line of log.split('\n').slice(-200).reverse()) {
    try {
      const event=JSON.parse(line) as Record<string,unknown>;
      if(event.event==='operation.internal-error' && typeof event.operationId==='string' && event.operationId.startsWith('api.startup.')
        && typeof event.code==='string' && /^[A-Z0-9_]{1,32}$/u.test(event.code)) {
        const stage=event.operationId.slice('api.startup.'.length).replace(/[^A-Za-z]/gu,'').toUpperCase().slice(0,32);
        return `API_${stage}_${event.code}`;
      }
    } catch { /* Non-JSON startup failures are classified below. */ }
  }
  if (/\bEACCES\b/.test(log)) {
    for (const [path, code] of [['/data/operations-runner', 'RUNNER_STATE_PERMISSION'],
      ['/data/published-knowledge', 'KNOWLEDGE_STATE_PERMISSION'],
      ['/run/openbao-client', 'CUSTODY_PERMISSION'], ['/run/treeseed-keys', 'KEY_PERMISSION']] as const) {
      if (log.split('\n').some(line => /\bEACCES\b/.test(line) && line.includes(path))) return code;
    }
  }
  if (/\b(?:ERR_)?MODULE_NOT_FOUND\b/u.test(log)) {
    for (const [pattern, code] of [
      [/['"]tsx['"]/u, 'TSX_MODULE_MISSING'],
      [/['"]@treeseed\/sdk(?:\/[^'"]*)?['"]/u, 'SDK_MODULE_MISSING'],
      [/['"]@treeseed\/deployment(?:\/[^'"]*)?['"]/u, 'DEPLOYMENT_MODULE_MISSING'],
      [/['"]@treeseed\/identity(?:\/[^'"]*)?['"]/u, 'IDENTITY_MODULE_MISSING'],
	  [/['"]@ai-platform\/common['"]/u, 'AI_COMMON_MODULE_MISSING'],
	  [/['"]@hono\/node-server['"]/u, 'HONO_SERVER_MODULE_MISSING'],
	  [/['"]hono(?:\/[^'"]*)?['"]/u, 'HONO_MODULE_MISSING'],
	  [/['"]pg['"]/u, 'POSTGRES_MODULE_MISSING'],
	  [/['"]@aws-sdk\/client-s3['"]/u, 'S3_MODULE_MISSING'],
      [/['"]yaml['"]/u, 'YAML_MODULE_MISSING'],
      [/['"]zod['"]/u, 'ZOD_MODULE_MISSING'],
    ] as const) if (pattern.test(log)) return code;
  }
  return log.match(/\b(ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|EACCES|ECONNREFUSED|ENOTFOUND)\b/)?.[1]??
    (/does not provide an export named/.test(log)?'EXPORT_MISSING':/SyntaxError/.test(log)?'SYNTAX_ERROR':/duplicate key|already exists/.test(log)?'DATABASE_CONFLICT':/permission denied/.test(log)?'DATABASE_PERMISSION':/relation .*does not exist/.test(log)?'DATABASE_RELATION_MISSING':'');
}

/** Classify captured command failures without forwarding output that may contain custody data. */
export function boundedDiagnosticFailureCode(output: string, executable: string, arguments_: readonly string[]) {
  if (/drain active workdays/iu.test(output)) return 'ACTIVE_WORKDAYS_REQUIRE_DRAIN';
  if (/drain active assignments/iu.test(output)) return 'ACTIVE_ASSIGNMENTS_REQUIRE_DRAIN';
  if (/cannot drop .* because other objects depend on it/iu.test(output)) return 'DATABASE_DEPENDENCY_CONFLICT';
  if (/invalid input syntax for type json|invalid json/iu.test(output)) return 'DATABASE_INVALID_JSON';
  if (/permission denied/iu.test(output)) return 'PERMISSION_DENIED';
  if (/relation .* does not exist/iu.test(output)) return 'DATABASE_RELATION_MISSING';
  if (/constraint .* (?:already exists|is violated)|duplicate key/iu.test(output)) return 'DATABASE_CONFLICT';
  if (/syntax error/iu.test(output)) return 'SYNTAX_ERROR';
  if (/Cannot find (?:package|module)|(?:ERR_)?MODULE_NOT_FOUND/iu.test(output)) return 'MODULE_NOT_FOUND';
  if (/no space left on device/iu.test(output)) return 'STORAGE_EXHAUSTED';
  if (/connection refused|ECONNREFUSED/iu.test(output)) return 'CONNECTION_REFUSED';
  if (/timeout|timed out/iu.test(output)) return 'TIMEOUT';
  if (executable === '/usr/bin/docker' && arguments_[0] === 'run') return 'CONTAINER_FAILED';
  return 'COMMAND_FAILED';
}
