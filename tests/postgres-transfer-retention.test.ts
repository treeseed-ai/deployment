import { expect, it } from 'vitest';
import { retiredBackupArchives } from '../src/supervisor/backup.js';

const name = (generation: number) => `generation-${generation}.tar.gz.enc`;
it('retains the exact interrupted transfer restore point despite newer backups', () => {
	const names = Array.from({length:15},(_,index) => name(index+1));
	expect(retiredBackupArchives(names,1)).toEqual([name(5),name(4),name(3),name(2)]);
	expect(retiredBackupArchives(names)).toEqual([name(5),name(4),name(3),name(2),name(1)]);
});
it('never selects unrelated, temporary, or unsafe-number filenames for removal', () => {
	expect(retiredBackupArchives(['recovery.bundle','generation-1.tar.gz.enc.new','generation-9007199254740993.tar.gz.enc',name(1)])).toEqual([]);
	expect(() => retiredBackupArchives([],NaN)).toThrow('pinned');
});
