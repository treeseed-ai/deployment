import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const failureMessage = 'Authorized source Git operation failed. Check repository access, exact revision, storage capacity, and fetch timeout.';
const operations = ['init', 'fetch', 'push', 'fsck', 'rev_parse', 'update_ref', 'for_each_ref', 'ls_remote', 'bundle_create', 'bundle_verify', 'bundle_unbundle', 'unknown'];
const systemCodes = ['EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EROFS', 'EBUSY', 'ETIMEDOUT'];
const signals = ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGPIPE'];
const diagnosticPattern = new RegExp(`^source_git_(?:${operations.join('|')})_(?:exit_(?:[1-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])|${systemCodes.map(code => code.toLowerCase()).join('|')}|${signals.map(signal => `signal_${signal.toLowerCase()}`).join('|')}|failed)$`, 'u');

/** A fixed diagnostic carried by the original error, never child output or arguments. */
export function sourceGitFailureDetail(error: unknown): string | undefined {
  return error instanceof Error && error.message === failureMessage && typeof error.cause === 'string'
    && diagnosticPattern.test(error.cause) ? error.cause : undefined;
}

function failureDetail(args: string[], error: unknown) {
  let index = 0;
  while (args[index] === '-c' && index + 1 < args.length) index += 2;
  const command = args[index], operation = command === 'bundle' ? `bundle_${args[index + 1]}` : command?.replaceAll('-', '_');
  const stage = operation && operations.includes(operation) ? operation : 'unknown';
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const outcome = Number.isSafeInteger(value.code) && Number(value.code) > 0 && Number(value.code) <= 255 ? `exit_${value.code}`
    : typeof value.code === 'string' && systemCodes.includes(value.code) ? value.code.toLowerCase()
    : typeof value.signal === 'string' && signals.includes(value.signal) ? `signal_${value.signal.toLowerCase()}` : 'failed';
  return `source_git_${stage}_${outcome}`;
}
export interface SourceGitCredential { username: string; token: string }
export interface SourceGitCommand { args: string[]; env: NodeJS.ProcessEnv; timeout: number }

/** Host-fetch worker only. No ambient Git config, shell, credential helper, hook, redirect, or submodule transport. */
export function sourceGitCommand(repository: string, args: string[], credential?: SourceGitCredential): SourceGitCommand {
  const env: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false', GIT_SSH_COMMAND: '/bin/false',
  };
  const config = ['--git-dir', repository, '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=',
    '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'http.followRedirects=false',
    '-c', 'http.sslVerify=true', '-c', 'fetch.fsckObjects=true', '-c', 'transfer.fsckObjects=true',
    '-c', 'fetch.recurseSubmodules=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0'];
  if (credential) {
    if (!credential.token || credential.token.length > 8192 || /[\r\n\0]/u.test(credential.token + credential.username)
      || credential.username.length > 256 || credential.username.includes(':')) throw new Error('Invalid source Git credential.');
    // Value lives only in this trusted child environment, never argv, on-disk config, output, or guest material.
    env.TREESEED_SOURCE_GIT_HEADER = `Authorization: Basic ${Buffer.from(`${credential.username || 'x-access-token'}:${credential.token}`).toString('base64')}`;
    config.push('--config-env=http.https://github.com/.extraHeader=TREESEED_SOURCE_GIT_HEADER');
  }
  return { args: [...config, ...args], env, timeout: 120_000 };
}

export async function runSourceGit(repository: string, args: string[], credential?: SourceGitCredential) {
  const command = sourceGitCommand(repository, args, credential);
  try {
    return (await execute('/usr/bin/git', command.args, { env: command.env, timeout: command.timeout, maxBuffer: 262_144, encoding: 'utf8' })).stdout.trim();
  } catch (error: unknown) {
    // Git errors may echo authentication headers, remote content, and request URLs. Return a safe operation code only.
    throw new Error(failureMessage, { cause: failureDetail(args, error) });
  } finally { delete command.env.TREESEED_SOURCE_GIT_HEADER; }
}
