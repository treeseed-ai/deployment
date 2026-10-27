import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CordisComposition, Context } from '@treeseed-cordis/sdk/runtime';
import { DeploymentComposition, DeploymentCapability } from '../../src/composition.js';
export class Receiver {context:Context|null=null;}
export class DeploymentConsumer {static readonly inject=['deployment'];constructor(context:Context,receiver:Receiver){receiver.context=context;}}
