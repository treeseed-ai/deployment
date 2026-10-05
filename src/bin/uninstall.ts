import { executeHostUninstall, uninstallReceiptPath, writeUninstallReceipt } from '../supervisor/uninstall.js';

const value = (name: string) => process.argv.slice(2).find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
const operationId = value('operation-id') ?? '', purgeSecurity = value('purge-security');
const receiptPath = uninstallReceiptPath(operationId);
if (process.getuid?.() !== 0) throw new Error('Host uninstall finalization must run as root.');
if (purgeSecurity !== 'true' && purgeSecurity !== 'false') throw new Error('Host uninstall security selection is invalid.');

try {
	executeHostUninstall(purgeSecurity === 'true', { operationId, receiptPath });
} catch {
	const receipt = { schemaVersion: 'treeseed.host-uninstall-receipt/v1', receiptId: operationId, state: 'failed', purgedSecurity: purgeSecurity === 'true', error: { code: 'uninstall_incomplete' }, completedAt: new Date().toISOString() };
	writeUninstallReceipt(receiptPath, receipt);
	process.exitCode = 1;
}
