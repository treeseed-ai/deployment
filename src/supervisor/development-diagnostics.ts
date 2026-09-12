/** Structured metadata only: never forward raw container messages, SQL, or values. */
export function developmentDiagnosticEvents(output: string) {
  const events = output.split('\n').slice(-200).flatMap(line => {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (!['operation.internal-error', 'operation.failed', 'operation.output-contract-invalid'].includes(String(value.event))) return [];
      const result: Record<string, string | number> = { event: String(value.event) };
      for (const key of ['operationId', 'requestId', 'name', 'code', 'constraint']) {
        const field = value[key];
        if (typeof field === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(field)) result[key] = field;
      }
      if (typeof value.status === 'number' && value.status >= 400 && value.status <= 599) result.status = value.status;
      return [result];
    } catch { return []; }
  });
  const code=developmentStartupCode(output);
  if(code)events.push({event:'development.startup-error',code});
  return events;
}

/** Fixed classifications only; module paths, SQL and raw application values never leave the supervisor. */
export function developmentStartupCode(log:string):string {
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
      [/['"]yaml['"]/u, 'YAML_MODULE_MISSING'],
      [/['"]zod['"]/u, 'ZOD_MODULE_MISSING'],
    ] as const) if (pattern.test(log)) return code;
  }
  return log.match(/\b(ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|EACCES|ECONNREFUSED|ENOTFOUND)\b/)?.[1]??
    (/does not provide an export named/.test(log)?'EXPORT_MISSING':/SyntaxError/.test(log)?'SYNTAX_ERROR':/duplicate key|already exists/.test(log)?'DATABASE_CONFLICT':/permission denied/.test(log)?'DATABASE_PERMISSION':/relation .*does not exist/.test(log)?'DATABASE_RELATION_MISSING':'');
}
