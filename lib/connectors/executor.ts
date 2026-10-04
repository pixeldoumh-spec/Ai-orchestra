import {createHash,createHmac} from "node:crypto";
import {createAdminClient} from "@/lib/supabase/admin";
import {decryptSecret} from "@/lib/vault/crypto";
import {recordConnectorOutcome} from "./repository";

const MAX_RESPONSE_BYTES=64_000;
const MAX_ACTION_PATH=512;
const ALLOWED_METHODS=new Set(["GET","POST","PUT","PATCH","DELETE"]);

function rejectPrivateHost(url:URL){
 const host=url.hostname.toLowerCase();
 if(host==="localhost"||host.endsWith(".localhost")||host.endsWith(".local")||host.endsWith(".internal"))throw new Error("Connector host is not allowed");
 if(/^127\./.test(host)||host==="0.0.0.0"||host==="::1"||host==="[::1]"||host==="169.254.169.254")throw new Error("Connector host is not allowed");
 const ipv4=host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
 if(ipv4){
  const [a,b]=[Number(ipv4[1]),Number(ipv4[2])];
  if(a===10||a===127||a===169&&b===254||a===192&&b===168||a===172&&b>=16&&b<=31)throw new Error("Connector host is not allowed");
 }
 if(host.startsWith("fc")||host.startsWith("fd")||host.startsWith("fe80:"))throw new Error("Connector host is not allowed");
}

export function parseExternalAction(action:string,input:string){
 const trimmed=action.trim();const match=trimmed.match(/^([A-Za-z]+)[ \t]+([^\s]+)$/);
 if(!match)throw new Error("External action must use 'METHOD /relative/path' format");
 const method=match[1].toUpperCase();const path=match[2];
 if(!ALLOWED_METHODS.has(method))throw new Error("External connector method is not allowed");
 if(!path.startsWith("/")||path.length>MAX_ACTION_PATH||path.includes("\\")||path.includes("//")||path.includes("..")||/[\u0000-\u001F\u007F]/.test(path))throw new Error("External connector path is invalid");
 let payload:unknown=null;
 try{payload=input.trim()?JSON.parse(input):null;}catch{throw new Error("External connector input must be valid JSON");}
 const serialized=JSON.stringify(payload??null);
 if(serialized.length>40_000)throw new Error("External connector input exceeds 40,000 characters");
 return{method,path,payload};
}

function boundedBody(value:unknown){
 const raw=typeof value==="string"?value:JSON.stringify(value??null);
 if(raw.length<=MAX_RESPONSE_BYTES)return raw;
 return raw.slice(0,MAX_RESPONSE_BYTES)+"\n[truncated]";
}

function responseHeaders(headers:Headers){
 const allowed=["content-type","content-length","etag","last-modified","x-request-id","request-id"];
 const out:Record<string,string>={};
 for(const key of allowed){const value=headers.get(key);if(value)out[key]=value.slice(0,400);}
 return out;
}

export async function executeConnectorRequest(input:{organizationId:string;connectorRequestId:string;actor:string}){
 const db=createAdminClient();
 const {data:req,error}=await db.from("connector_requests").select("id,organization_id,connector_id,credential_id,request_id,nonce,signature,key_version,status,expires_at,action_method,action_path,action_payload_ciphertext,action_payload_iv,action_payload_auth_tag,action_payload_key_version").eq("id",input.connectorRequestId).eq("organization_id",input.organizationId).single();
 if(error||!req)throw new Error("Connector request not found");
 if(req.status!=="approved")throw new Error(`Connector request is not executable in state ${req.status}`);
 if(Date.parse(req.expires_at)<=Date.now()){await db.from("connector_requests").update({status:"expired",completed_at:new Date().toISOString()}).eq("id",req.id).eq("status","approved");throw new Error("Connector request expired");}
 const {data:connector,error:ce}=await db.from("connectors").select("id,base_url,status,auth_scheme").eq("organization_id",input.organizationId).eq("id",req.connector_id).single();
 if(ce||!connector)throw new Error("Connector not found");
 if(connector.status==="disabled"||!connector.base_url)throw new Error("Connector is not executable");
 const base=new URL(connector.base_url);rejectPrivateHost(base);
 const method=String(req.action_method??"").toUpperCase();const path=String(req.action_path??"");
 if(!ALLOWED_METHODS.has(method)||!path.startsWith("/"))throw new Error("Stored connector action is invalid");
 const target=new URL(path,base);if(target.origin!==base.origin)throw new Error("Connector action escaped the configured base URL");rejectPrivateHost(target);
 if(!req.action_payload_ciphertext||!req.action_payload_iv||!req.action_payload_auth_tag||!req.action_payload_key_version)throw new Error("Connector action payload is unavailable");
 const payloadRaw=decryptSecret({ciphertext:req.action_payload_ciphertext,iv:req.action_payload_iv,authTag:req.action_payload_auth_tag,keyVersion:Number(req.action_payload_key_version)});
 const payload=payloadRaw==="null"?null:JSON.parse(payloadRaw);const body=method==="GET"||method==="DELETE"?undefined:JSON.stringify(payload??null);
 let headers:Record<string,string>={"Accept":"application/json","X-AI-Orchestra-Request-Id":req.request_id,"X-AI-Orchestra-Nonce":req.nonce};
 if(body!==undefined){headers["Content-Type"]="application/json";headers["Content-Length"]=String(Buffer.byteLength(body));}
 if(req.credential_id){
  const {data:cred,error:qe}=await db.from("connector_credentials").select("secret_ciphertext,secret_iv,secret_auth_tag,key_version,auth_scheme,status,expires_at").eq("organization_id",input.organizationId).eq("connector_id",req.connector_id).eq("id",req.credential_id).single();
  if(qe||!cred)throw new Error("Connector credential not found");
  if(cred.status!=="active"||(cred.expires_at&&Date.parse(cred.expires_at)<=Date.now()))throw new Error("Connector credential is inactive or expired");
  const secret=decryptSecret({ciphertext:cred.secret_ciphertext,iv:cred.secret_iv,authTag:cred.secret_auth_tag,keyVersion:Number(cred.key_version)});
  if(cred.auth_scheme==="bearer")headers.Authorization=`Bearer ${secret}`;
  else if(cred.auth_scheme==="api_key")headers["X-API-Key"]=secret;
  else if(cred.auth_scheme==="hmac"){
   const timestamp=String(Date.now());const digest=createHmac("sha256",secret).update([timestamp,method,path,body??""].join("\n")).digest("hex");
   headers["X-AI-Orchestra-Timestamp"]=timestamp;headers["X-AI-Orchestra-Signature"]=digest;
  }
 }
 const started=Date.now();
 try{
  const response=await fetch(target,{method,headers,body,redirect:"error"});
  const raw=await response.text();const latencyMs=Date.now()-started;const excerpt=boundedBody(raw);
  const responseHash=createHash("sha256").update(raw,"utf8").digest("hex");
  await db.from("connector_requests").update({status:response.ok?"executed":"failed",http_status:response.status,response_hash:responseHash,latency_ms:latencyMs,completed_at:new Date().toISOString()}).eq("id",req.id).eq("status","approved");
  await recordConnectorOutcome({organizationId:input.organizationId,connectorId:req.connector_id,success:response.ok,latencyMs,httpStatus:response.status,errorClass:response.ok?null:`HTTP_${response.status}`,source:"external.action"});
  return{ok:response.ok,status:response.status,headers:responseHeaders(response.headers),body:excerpt,requestId:req.request_id,connectorId:req.connector_id,latencyMs};
 }catch(error){
  const latencyMs=Date.now()-started;const message=error instanceof Error?error.message:"Connector request failed";
  await db.from("connector_requests").update({status:"failed",latency_ms:latencyMs,completed_at:new Date().toISOString()}).eq("id",req.id).eq("status","approved");
  await recordConnectorOutcome({organizationId:input.organizationId,connectorId:req.connector_id,success:false,latencyMs,httpStatus:null,errorClass:message.slice(0,120),source:"external.action"});
  throw new Error("Connector execution failed");
 }
}
