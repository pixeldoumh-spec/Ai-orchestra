import {sha256} from "@/lib/vault/crypto";
import type {EvidenceCitation} from "./types";

type AnyRecord=Record<string,unknown>;

function asRecord(value:unknown):AnyRecord|null{return value&&typeof value==="object"?value as AnyRecord:null;}
function stringOrNull(value:unknown):string|null{return typeof value==="string"?value:null;}
function intOrNull(value:unknown):number|null{return typeof value==="number"&&Number.isInteger(value)?value:null;}

export function extractEvidence(responseItems:unknown[]){
 const citations:EvidenceCitation[]=[];
 const seen=new Set<string>();
 const searches:string[]=[];
 for(const item of responseItems){
  const obj=asRecord(item);
  if(!obj)continue;
  if(obj.type==="web_search_call"){
   const action=asRecord(obj.action);
   const queries=Array.isArray(action?.queries)?action.queries:[];
   for(const q of queries)if(typeof q==="string")searches.push(q);
   const sources=Array.isArray(action?.sources)?action.sources:[];
   for(const source of sources){
    const s=asRecord(source);const url=stringOrNull(s?.url);
    if(!url)continue;
    const key="url:"+url;if(seen.has(key))continue;seen.add(key);
    citations.push({kind:"url",title:null,url,externalFileId:null,filename:null,startIndex:null,endIndex:null,sourceSha256:sha256(url)});
   }
  }
  if(obj.type!=="message")continue;
  const content=Array.isArray(obj.content)?obj.content:[];
  for(const part of content){
   const p=asRecord(part);if(!p)continue;
   const annotations=Array.isArray(p.annotations)?p.annotations:[];
   for(const raw of annotations){
    const a=asRecord(raw);if(!a)continue;
    if(a.type==="url_citation"){
     const c=asRecord(a);const url=stringOrNull(c?.url);if(!url)continue;
     const key="url:"+url;if(seen.has(key))continue;seen.add(key);
     citations.push({kind:"url",title:stringOrNull(c?.title),url,externalFileId:null,filename:null,startIndex:intOrNull(c?.start_index),endIndex:intOrNull(c?.end_index),sourceSha256:sha256(url)});
    }else if(a.type==="file_citation"){
     const c=asRecord(a);const fileId=stringOrNull(c?.file_id);if(!fileId)continue;
     const key="file:"+fileId;if(seen.has(key))continue;seen.add(key);
     citations.push({kind:"file",title:stringOrNull(c?.filename),url:null,externalFileId:fileId,filename:stringOrNull(c?.filename),startIndex:intOrNull(c?.start_index),endIndex:intOrNull(c?.end_index),sourceSha256:sha256(fileId)});
    }
   }
  }
 }
 return {citations,searches};
}
