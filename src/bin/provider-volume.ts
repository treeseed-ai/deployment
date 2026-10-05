#!/usr/bin/env node
import { mountProviderSecurityVolume, providerSecurityStatus, unmountProviderSecurityVolume } from '../security/provider-volume.js';

if (process.getuid?.() !== 0) throw new Error('Provider volume lifecycle requires root.');
const action = process.argv[2];
const result = action === 'mount' ? mountProviderSecurityVolume() : action === 'unmount' ? unmountProviderSecurityVolume() : action === 'status' ? providerSecurityStatus() : null;
if (!result) throw new Error('Usage: provider-volume mount|unmount|status'); process.stdout.write(`${JSON.stringify(result)}\n`);
