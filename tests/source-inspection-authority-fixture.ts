import type {SourceWorkspaceAuthorization} from '@treeseed/sdk/capacity-provider/sandbox';
type Owner=Pick<SourceWorkspaceAuthorization,'assignmentId'|'providerId'|'attempt'>&{teamId:string;projectId:string};
/** Canonical historical job authority for the same cheap and native inspection cases. */
export function sourceInspectionAuthority(owner:Owner,source:SourceWorkspaceAuthorization['source'],branch:string):SourceWorkspaceAuthorization{
 return {schemaVersion:'treeseed.source-workspace-authorization/v1',id:'inspection-authority-'+owner.assignmentId,assignmentId:owner.assignmentId,providerId:owner.providerId,attempt:owner.attempt,
  source:{...source,teamId:owner.teamId,projectId:owner.projectId},mode:'work',acquisition:'upstream-public',publication:'simulation-branch',publicationRef:branch,
  issuedAt:'2026-10-16T00:00:00.000Z',expiresAt:'2026-10-16T01:00:00.000Z'};
}
