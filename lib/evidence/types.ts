export type EvidenceSourceKind="url"|"file";
export interface EvidenceCitation{
 kind:EvidenceSourceKind;
 title:string|null;
 url:string|null;
 externalFileId:string|null;
 filename:string|null;
 startIndex:number|null;
 endIndex:number|null;
 sourceSha256:string;
}
export interface EvidencePacket{
 id:string;
 organizationId:string;
 taskId:string;
 stepId:string;
 model:string|null;
 sourceKind:"none"|"web"|"document"|"mixed";
 answerSha256:string|null;
 citationCount:number;
 searchCount:number;
 citations:EvidenceCitation[];
 createdAt:string;
}
