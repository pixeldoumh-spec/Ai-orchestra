import {createAdminClient} from "@/lib/supabase/admin";
import {sha256} from "@/lib/vault/crypto";
import {extractEvidence} from "./extract";
import type {EvidencePacket} from "./types";

export async function persistEvidencePacket(input:{organizationId:string;taskId:string;stepId:string;model?:string|null;outputText:string;responseItems:unknown[]}):Promise<EvidencePacket>{
 const {citations,searches}=extractEvidence(input.responseItems);
 const sourceKind=citations.length===0?"none":citations.some(c=>c.kind==="url")&&citations.some(c=>c.kind==="file")?"mixed":citations.some(c=>c.kind==="url")?"web":"document";
 const db=createAdminClient();
 const {data:packet,error}=await db.from("evidence_packets").insert({
  organization_id:input.organizationId,task_id:input.taskId,step_id:input.stepId,model:input.model??null,source_kind:sourceKind,
  answer_sha256:input.outputText?sha256(input.outputText):null,citation_count:citations.length,search_count:searches.length
 }).select("id,organization_id,task_id,step_id,model,source_kind,answer_sha256,citation_count,search_count,created_at").single();
 if(error)throw new Error(error.message);
 if(citations.length){
  const rows=citations.slice(0,64).map((c,index)=>({
   packet_id:packet.id,organization_id:input.organizationId,ordinal:index,kind:c.kind,title:c.title,url:c.url,
   external_file_id:c.externalFileId,filename:c.filename,source_sha256:c.sourceSha256,start_index:c.startIndex,end_index:c.endIndex
  }));
  const{error:ce}=await db.from("evidence_citations").insert(rows);if(ce)throw new Error(ce.message);
 }
 if(searches.length){
  const rows=searches.slice(0,32).map((q)=>({packet_id:packet.id,organization_id:input.organizationId,query_sha256:sha256(q),source_count:citations.filter(c=>c.kind==="url").length}));
  const{error:se}=await db.from("evidence_searches").insert(rows);if(se)throw new Error(se.message);
 }
 return{...packet,citations};
}
export async function listTaskEvidencePackets(orgId:string,taskId:string){
 const db=createAdminClient();
 const{data:packets,error}=await db.from("evidence_packets").select("id,organization_id,task_id,step_id,model,source_kind,answer_sha256,citation_count,search_count,created_at,evidence_citations(*)").eq("organization_id",orgId).eq("task_id",taskId).order("created_at",{ascending:true});
 if(error)throw new Error(error.message);
 return (packets??[]).map((p:any)=>({...p,citations:Array.isArray(p.evidence_citations)?p.evidence_citations.map((c:any)=>({kind:c.kind,title:c.title,url:c.url,externalFileId:c.external_file_id,filename:c.filename,startIndex:c.start_index,endIndex:c.end_index,sourceSha256:c.source_sha256})):[]}));
}
