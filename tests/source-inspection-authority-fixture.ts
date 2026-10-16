import type {SourceWorkspaceAuthorization} from '@treeseed/sdk/capacity-provider/sandbox';
type Owner=Pick<SourceWorkspaceAuthorization,'assignmentId'|'providerId'|'attempt'>&{teamId:string;projectId:string};
/** Preserve the original native positive fixture for the cheap regression. */
export function sourceInspectionAuthority(_owner:Owner,_source:SourceWorkspaceAuthorization['source'],_branch:string){
 return {private:'controlled-private-journal-content'};
}
