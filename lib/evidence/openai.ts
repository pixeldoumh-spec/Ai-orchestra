import {createHash} from "node:crypto";
import {createAdminClient} from "@/lib/supabase/admin";
import {sha256} from "@/lib/vault/crypto";

function apiKey(){const key=process.env.OPENAI_API_KEY;if(!key)throw new Error("OPENAI_API_KEY is not configured");return key;}
async function jsonRequest(path:string,init:RequestInit={}){
 const response=await fetch("https://api.openai.com"+path,{...init,headers:{Authorization:`Bearer ${apiKey()}`,...(init.headers??{})}});
 const body=await response.json().catch(()=>null);
 if(!response.ok){const code=body?.error?.code;throw new Error(code==="insufficient_quota"?"OpenAI quota is exhausted":`OpenAI request failed (${response.status})`);}
 return body;
}
async function ensureCollection(orgId:string){
 const db=createAdminClient();
 const {data:existing,error}=await db.from("evidence_collections").select("id,external_vector_store_id,status").eq("organization_id",orgId).maybeSingle();
 if(error)throw new Error(error.message);
 if(existing?.status==="active")return existing;
 const vectorStore=await jsonRequest("/v1/vector_stores",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:`AI Orchestra ${orgId} evidence`})});
 const {data,error:upsertError}=await db.from("evidence_collections").upsert({
  organization_id:orgId,provider:"openai",external_vector_store_id:vectorStore.id,name:String(vectorStore.name??`AI Orchestra ${orgId} evidence`),status:"active",updated_at:new Date().toISOString()
 },{onConflict:"organization_id"}).select("id,external_vector_store_id,status").single();
 if(upsertError)throw new Error(upsertError.message);
 return data;
}
export async function ingestDocument(input:{organizationId:string;userId:string;file:File}){
 const maxBytes=Number(process.env.EVIDENCE_MAX_FILE_BYTES??"20971520");
 if(!Number.isInteger(maxBytes)||maxBytes<1_048_576||input.file.size<1||input.file.size>maxBytes)throw new Error(`Document size must be between 1 byte and ${maxBytes} bytes`);
 const buffer=Buffer.from(await input.file.arrayBuffer());const contentSha256=createHash("sha256").update(buffer).digest("hex");
 const collection=await ensureCollection(input.organizationId);
 const db=createAdminClient();
 const {data:duplicate}=await db.from("evidence_documents").select("id,external_file_id,external_vector_store_file_id,status,filename").eq("organization_id",input.organizationId).eq("content_sha256",contentSha256).maybeSingle();
 if(duplicate)return{document:duplicate,duplicate:true};
 const form=new FormData();
 form.append("purpose","user_data");
 form.append("expires_after[anchor]","created_at");
 form.append("expires_after[seconds]",String(Number(process.env.EVIDENCE_FILE_EXPIRY_SECONDS??2592000)));
 form.append("file",new Blob([buffer],{type:input.file.type||"application/octet-stream"}),input.file.name);
 let uploaded:any;
 try{uploaded=await jsonRequest("/v1/files",{method:"POST",body:form});}
 catch(error){throw error;}
 let vectorFile:any;
 try{
  vectorFile=await jsonRequest(`/v1/vector_stores/${encodeURIComponent(collection.external_vector_store_id)}/files`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({file_id:uploaded.id,attributes:{organization_id:input.organizationId,source_sha256:contentSha256,filename:input.file.name}})});
 }catch(error){
  await jsonRequest(`/v1/files/${encodeURIComponent(uploaded.id)}`,{method:"DELETE"}).catch(()=>null);
  throw error;
 }
 const {data,error}=await db.from("evidence_documents").insert({
  organization_id:input.organizationId,collection_id:collection.id,external_file_id:uploaded.id,external_vector_store_file_id:vectorFile.id,
  filename:input.file.name,mime_type:input.file.type||null,byte_size:input.file.size,content_sha256:contentSha256,
  status:vectorFile.status==="failed"?"failed":"indexing",last_error:vectorFile.last_error?.message??null,created_by:input.userId
 }).select("id,filename,mime_type,byte_size,status,external_file_id,external_vector_store_file_id,created_at").single();
 if(error){
  await jsonRequest(`/v1/vector_stores/${encodeURIComponent(collection.external_vector_store_id)}/files/${encodeURIComponent(uploaded.id)}`,{method:"DELETE"}).catch(()=>null);
  await jsonRequest(`/v1/files/${encodeURIComponent(uploaded.id)}`,{method:"DELETE"}).catch(()=>null);
  throw new Error(error.message);
 }
 return{document:data,duplicate:false};
}
export async function listDocuments(orgId:string){
 const db=createAdminClient();const{data,error}=await db.from("evidence_documents").select("id,filename,mime_type,byte_size,status,external_file_id,external_vector_store_file_id,created_at").eq("organization_id",orgId).order("created_at",{ascending:false}).limit(200);
 if(error)throw new Error(error.message);return data??[];
}
export async function attachTaskEvidenceDocuments(input:{organizationId:string;taskId:string;documentIds:string[]}){
 const ids=[...new Set(input.documentIds)].slice(0,16);if(ids.length===0)return;
 const db=createAdminClient();const{data,error}=await db.from("evidence_documents").select("id").eq("organization_id",input.organizationId).in("id",ids);
 if(error)throw new Error(error.message);const valid=(data??[]).map(x=>x.id);
 if(valid.length!==ids.length)throw new Error("One or more evidence documents are not in this organization");
 const rows=valid.map(documentId=>({organization_id:input.organizationId,task_id:input.taskId,document_id:documentId}));
 const{error:insertError}=await db.from("task_evidence_documents").upsert(rows,{onConflict:"task_id,document_id"});
 if(insertError)throw new Error(insertError.message);
}
export async function listTaskEvidenceVectorStores(input:{organizationId:string;taskId:string}){
 const db=createAdminClient();
 const{data,error}=await db.from("task_evidence_documents").select("document_id,evidence_documents(collection_id,status,evidence_collections(external_vector_store_id,status))").eq("organization_id",input.organizationId).eq("task_id",input.taskId);
 if(error)throw new Error(error.message);
 const ids=new Set<string>();
 for(const row of data??[]){
  const d=Array.isArray(row.evidence_documents)?row.evidence_documents[0]:row.evidence_documents;
  const c=Array.isArray(d?.evidence_collections)?d.evidence_collections[0]:d?.evidence_collections;
  if(d?.status!=="failed"&&c?.status==="active"&&typeof c?.external_vector_store_id==="string")ids.add(c.external_vector_store_id);
 }
 return [...ids].slice(0,8);
}
