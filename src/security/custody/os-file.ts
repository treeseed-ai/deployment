import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { CustodyError } from './contracts.js';
/** Read only an explicitly OS-injected private credential file, never an environment fallback. */
export function readOsCredentialFile(path:string):Buffer {
  let fd:number;
  try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);}catch{throw new CustodyError('os_credential_unavailable');}
  try {
    const stat=fstatSync(fd);
    if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o027)||stat.size<24||stat.size>16_384)
      throw new CustodyError('unsafe_os_credential');
    return readFileSync(fd);
  } finally{closeSync(fd);}
}
