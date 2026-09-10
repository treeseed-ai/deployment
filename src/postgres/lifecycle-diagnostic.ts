import { componentReleaseSchema, deploymentDigest } from '@treeseed/sdk/deployment';
import { z } from 'zod';

/** Fixed categories only: logs can contain credentials, SQL and personal data. */
export function migrationFailureCategories(output: string) {
  const text = output.slice(-131072);
  const patterns: Array<[string, RegExp]> = [
    ['identity-account-migration', /Managed Identity account migration failed/u],
    ['database-permission', /permission denied for|must be owner of/iu],
    ['database-authentication', /password authentication failed|no pg_hba.conf entry/iu],
    ['database-object-missing', /(?:relation|column|database) .+ does not exist/iu],
    ['database-duplicate', /already exists|duplicate key/iu],
    ['module-unavailable', /ERR_MODULE_NOT_FOUND|Cannot find (?:module|package)/u],
    ['invalid-configuration', /ZodError|Invalid input|configuration.+required/iu],
    ['credential-file-unavailable', /ENOENT|EACCES|credential file/iu],
    ['tls-verification', /CERT_|certificate verify|self.signed certificate|unable to verify/iu],
    ['connection-unavailable', /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed/iu],
    ['syntax-error', /SyntaxError/u],
  ];
  return patterns.filter(([,pattern]) => pattern.test(text)).map(([code]) => code);
}

export type DiagnosticDocker = (args: string[]) => Promise<string>;
const stateSchema = z.object({ project:z.string(), service:z.string(), image:z.string(),
  state:z.enum(['created','running','paused','restarting','removing','exited','dead']),
  exitCode:z.number().int(), oomKilled:z.boolean() });
export async function inspectLifecycle(input: unknown, docker: DiagnosticDocker) {
  const component = componentReleaseSchema.parse(input);
  if (deploymentDigest(component.runtime) !== component.runtimeDigest) throw new Error('Exact lifecycle binding required');
  const results = [];
  for (const lifecycle of component.runtime.postgresLifecycle ?? []) {
    const service = lifecycle.migration.composeService;
    const ids = (await docker(['ps','--all','--quiet','--no-trunc','--filter',`label=com.docker.compose.project=${component.runtime.compose.projectName}`,
      '--filter',`label=com.docker.compose.service=${service}`])).trim().split('\n').filter(Boolean);
    if (!ids.length) { results.push({service,state:'absent' as const,reasons:[]}); continue; }
    if (ids.length !== 1 || !/^[a-f0-9]{64}$/u.test(ids[0]!)) throw new Error('Ambiguous migration container');
    const format = '{"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"image":{{json .Config.Image}},"state":{{json .State.Status}},"exitCode":{{json .State.ExitCode}},"oomKilled":{{json .State.OOMKilled}}';
    const state = stateSchema.parse(JSON.parse(await docker(['inspect','--format',format,ids[0]!])));
    if (state.project !== component.runtime.compose.projectName || state.service !== service ||
      !component.images.some(image => state.image === `${image.repository}@${image.digest}`)) throw new Error('Migration container does not match installed release');
    const reasons = migrationFailureCategories(await docker(['logs','--tail','80',ids[0]!]));
    results.push({service,state:state.state,exitCode:state.exitCode,oomKilled:state.oomKilled,reasons});
  }
  return {componentId:component.componentId,release:component.release,services:results};
}
