import type { CommandRunner } from './compose-runtime.js';

const name = 'treeseed-api-api-1';
function state(command: CommandRunner) {
  const value = JSON.parse(String(command('/usr/bin/docker', ['inspect', name, '--format',
    '{"labels":{{json .Config.Labels}},"running":{{json .State.Running}}}'])));
  if (value.labels?.['com.docker.compose.project'] !== 'treeseed-api'
    || value.labels?.['com.docker.compose.service'] !== 'api' || typeof value.running !== 'boolean') {
    throw new Error('Released API ownership does not match the managed service.');
  }
  return value as { running: boolean };
}

/** Only the fixed managed API listener. Vault and operations runner remain independent. */
export function stopReleasedApi(command: CommandRunner, beforeStop: () => void) {
  if (!state(command).running) return false;
  beforeStop(); // durable restoration intent precedes interruption
  command('/usr/bin/docker', ['stop', '--time', '30', name]);
  if (state(command).running) throw new Error('Released API is still running; live alias handoff denied.');
  return true;
}

export function restoreReleasedApi(command: CommandRunner) {
  state(command); // never start an unrelated replacement container
  command('/usr/bin/docker', ['start', name]);
}
