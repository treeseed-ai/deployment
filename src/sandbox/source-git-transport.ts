import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
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
  } catch {
    // Git errors may echo authentication headers, remote content, and request URLs. Return a safe operation code only.
    throw new Error('Authorized source Git operation failed. Check repository access, exact revision, storage capacity, and fetch timeout.');
  } finally { delete command.env.TREESEED_SOURCE_GIT_HEADER; }
}
