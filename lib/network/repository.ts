import{randomUUID}from"node:crypto";
import{createAdminClient}from"@/lib/supabase/admin";
import{ensureAgentIdentity,signAgentRequest,verifyAgentEnvelopeSignature}from"@/lib/orchestrator/identity";
import{encryptSecret,decryptSecret,hashJson}from"@/lib/vault/crypto";
import{buildNetworkSigningPayload,messagePayloadSizeBytes,validateNetworkEnvelope,MAX_NETWORK_PAYLOAD_BYTES,MAX_NETWORK_TTL_SECONDS,MIN_NETWORK_TTL_SECONDS,NETWORK_PROTOCOL_VERSION,type AgentNetworkMessageKind}from"@/lib/core/network/protocol";
import{assertNetworkPolicy,DEFAULT_NETWORK_POLICY,normalizeNetworkPolicy,type AgentNetworkPolicy}from"@/lib/core/network/policy";
import type{AgentNetworkMessage,AgentNetworkPeer,AgentNetworkStats}from"./types";

function mapPeer(r:any):AgentNetworkPeer{return{id:r.id,organizationId:r.organization_id,sourceAgentId:r.source_agent_id,targetAgentId:r.target_agent_id,allowedMessageTypes:Array.isArray(r.allowed_message_types)?r.allowed_message_types:[],allowedScopes:Array.isArray(r.allowed_scopes)?r.allowed_scopes:[],maxPayloadBytes:Number(r.max_payload_bytes),rateLimitPerMinute:Number(r.rate_limit_per_minute),status:r.status,createdAt:r.created_at,updatedAt:r.updated_at};}
async function decryptPayload(r:any){return JSON.parse(decryptSecret({ciphertext:r.payload_ciphertext,iv:r.payload_iv,authTag:r.payload_auth_tag,keyVersion:Number(r.payload_key_version)}));}
function mapMessage(r:any,payload?:unknown):AgentNetworkMessage{return{id:r.id,messageId:r.message_id,organizationId:r.organization_id,senderAgentId:r.sender_agent_id,recipientAgentId:r.target_agent_id,conversationId:r.conversation_id,correlationId:r.correlation_id??null,replyToMessageId:r.reply_to_message_id??null,rootMessageId:r.root_message_id??r.message_id,taskId:r.task_id??null,stepId:r.step_id??null,delegationDepth:Number(r.delegation_depth??0),hopCount:Number(r.hop_count??0),kind:r.kind,scope:r.scope,subject:r.subject,payloadHash:r.payload_hash,signerKeyVersion:Number(r.signer_key_version),signerFingerprint:r.signer_fingerprint,status:r.status,priority:Number(r.priority),attemptCount:Number(r.attempt_count),availableAt:r.available_at,expiresAt:r.expires_at,deliveredAt:r.delivered_at??null,ackedAt:r.acked_at??null,lastError:r.last_error??null,createdAt:r.created_at,...(payload===undefined?{}:{payload})};}

export async function getNetworkPolicy(organizationId:string):Promise<AgentNetworkPolicy>{
  const db=createAdminClient();
  const{data,error}=await db.from("agent_network_policies").select("*").eq("organization_id",organizationId).maybeSingle();
  if(error)throw new Error(error.message);
  if(data)return normalizeNetworkPolicy({organizationId,...data,allowedMessageTypes:data.allowed_message_types,allowedScopes:data.allowed_scopes,maxDelegationDepth:data.max_delegation_depth,maxPayloadBytes:data.max_payload_bytes,defaultTtlSeconds:data.default_ttl_seconds,maxTtlSeconds:data.max_ttl_seconds,maxHops:data.max_hops,rateLimitPerMinute:data.rate_limit_per_minute});
  const defaults=normalizeNetworkPolicy({organizationId,...DEFAULT_NETWORK_POLICY});
  const{data:created,error:insertError}=await db.from("agent_network_policies").insert({
    organization_id:organizationId,enabled:defaults.enabled,allow_delegation:defaults.allowDelegation,
    allowed_message_types:defaults.allowedMessageTypes,allowed_scopes:defaults.allowedScopes,
    max_delegation_depth:defaults.maxDelegationDepth,max_payload_bytes:defaults.maxPayloadBytes,
    default_ttl_seconds:defaults.defaultTtlSeconds,max_ttl_seconds:defaults.maxTtlSeconds,
    max_hops:defaults.maxHops,rate_limit_per_minute:defaults.rateLimitPerMinute,
  }).select("*").single();
  if(insertError)throw new Error(insertError.message);
  return normalizeNetworkPolicy({organizationId,...created,allowedMessageTypes:created.allowed_message_types,allowedScopes:created.allowed_scopes,maxDelegationDepth:created.max_delegation_depth,maxPayloadBytes:created.max_payload_bytes,defaultTtlSeconds:created.default_ttl_seconds,maxTtlSeconds:created.max_ttl_seconds,maxHops:created.max_hops,rateLimitPerMinute:created.rate_limit_per_minute});
}

export async function updateNetworkPolicy(organizationId:string,input:Partial<AgentNetworkPolicy>){
  const policy=normalizeNetworkPolicy({organizationId,...input});
  const db=createAdminClient();
  const{data,error}=await db.from("agent_network_policies").upsert({
    organization_id:organizationId,enabled:policy.enabled,allow_delegation:policy.allowDelegation,
    allowed_message_types:policy.allowedMessageTypes,allowed_scopes:policy.allowedScopes,
    max_delegation_depth:policy.maxDelegationDepth,max_payload_bytes:policy.maxPayloadBytes,
    default_ttl_seconds:policy.defaultTtlSeconds,max_ttl_seconds:policy.maxTtlSeconds,
    max_hops:policy.maxHops,rate_limit_per_minute:policy.rateLimitPerMinute,
  },{onConflict:"organization_id"}).select("*").single();
  if(error)throw new Error(error.message);
  return normalizeNetworkPolicy({organizationId,...data,allowedMessageTypes:data.allowed_message_types,allowedScopes:data.allowed_scopes,maxDelegationDepth:data.max_delegation_depth,maxPayloadBytes:data.max_payload_bytes,defaultTtlSeconds:data.default_ttl_seconds,maxTtlSeconds:data.max_ttl_seconds,maxHops:data.max_hops,rateLimitPerMinute:data.rate_limit_per_minute});
}

export async function listNetworkPeers(organizationId:string){
  const db=createAdminClient();
  const{data,error}=await db.from("agent_network_peers").select("*").eq("organization_id",organizationId).order("created_at",{ascending:true});
  if(error)throw new Error(error.message);
  return(data??[]).map(mapPeer);
}

export async function createNetworkPeer(input:{organizationId:string;sourceAgentId:string;targetAgentId:string;allowedMessageTypes:AgentNetworkMessageKind[];allowedScopes:string[];maxPayloadBytes?:number;rateLimitPerMinute?:number}){
  if(input.sourceAgentId===input.targetAgentId)throw new Error("Agent network peers must connect distinct agents");
  const policy=await getNetworkPolicy(input.organizationId);
  if(!input.allowedMessageTypes.every((kind)=>policy.allowedMessageTypes.includes(kind)))throw new Error("Peer permits a message type blocked by organization policy");
  if(input.allowedMessageTypes.includes("delegation")&&!policy.allowDelegation)throw new Error("Delegation is disabled by organization policy");
  const db=createAdminClient();
  const{data,error}=await db.from("agent_network_peers").upsert({
    organization_id:input.organizationId,source_agent_id:input.sourceAgentId,target_agent_id:input.targetAgentId,
    allowed_message_types:input.allowedMessageTypes,allowed_scopes:input.allowedScopes,
    max_payload_bytes:Math.min(Math.min(MAX_NETWORK_PAYLOAD_BYTES,policy.maxPayloadBytes),Math.max(1024,input.maxPayloadBytes??MAX_NETWORK_PAYLOAD_BYTES)),
    rate_limit_per_minute:Math.min(600,policy.rateLimitPerMinute,Math.max(1,input.rateLimitPerMinute??60)),status:"active"
  },{onConflict:"organization_id,source_agent_id,target_agent_id"}).select("*").single();
  if(error)throw new Error(error.message);
  return mapPeer(data);
}

export async function revokeNetworkPeer(organizationId:string,peerId:string){
  const db=createAdminClient();
  const{data,error}=await db.from("agent_network_peers").update({status:"revoked"}).eq("organization_id",organizationId).eq("id",peerId).select("*").single();
  if(error)throw new Error(error.message);
  return mapPeer(data);
}

export async function sendAgentMessage(input:{
  organizationId:string;senderAgentId:string;recipientAgentId:string;subject:string;payload:unknown;scope?:string;kind?:AgentNetworkMessageKind;
  conversationId?:string|null;correlationId?:string|null;replyToMessageId?:string|null;rootMessageId?:string|null;ttlSeconds?:number;priority?:number;
  taskId?:string|null;stepId?:string|null;delegationDepth?:number;hopCount?:number;
}){
  const policy=await getNetworkPolicy(input.organizationId);
  const kind=input.kind??"event";
  const payloadSize=messagePayloadSizeBytes(input.payload);
  const ttl=Math.min(policy.maxTtlSeconds,MAX_NETWORK_TTL_SECONDS,Math.max(MIN_NETWORK_TTL_SECONDS,Math.round(input.ttlSeconds??policy.defaultTtlSeconds)));
  const taskId=input.taskId??null;
  const stepId=input.stepId??null;
  const delegationDepth=Math.max(0,Math.round(Number(input.delegationDepth??0)));
  const hopCount=Math.max(0,Math.round(Number(input.hopCount??0)));
  const createdAt=new Date().toISOString();
  const expiresAt=new Date(Date.now()+ttl*1000).toISOString();
  const messageId="net_"+randomUUID();
  const nonce=randomUUID();
  let rootMessageId=input.rootMessageId??messageId;
  if(input.replyToMessageId&&!input.rootMessageId){
    const db=createAdminClient();
    const{data:prior}=await db.from("agent_network_messages").select("root_message_id,message_id,task_id").eq("organization_id",input.organizationId).eq("message_id",input.replyToMessageId).maybeSingle();
    if(!prior)throw new Error("Reply target was not found");
    if(taskId!==null&&prior.task_id!==taskId)throw new Error("Reply task lineage mismatch");
    rootMessageId=prior.root_message_id??prior.message_id;
  }
  const correlationId=input.correlationId??null;
  if(kind==="response"&&!correlationId)throw new Error("Responses require a correlation id");
  const envelope={
    protocolVersion:NETWORK_PROTOCOL_VERSION,organizationId:input.organizationId,messageId,
    senderAgentId:input.senderAgentId,recipientAgentId:input.recipientAgentId,
    conversationId:input.conversationId??messageId,correlationId,replyToMessageId:input.replyToMessageId??null,
    rootMessageId,taskId,stepId,delegationDepth,hopCount,kind,scope:input.scope??"task.coordination",
    subject:input.subject,payloadHash:hashJson(input.payload),createdAt,expiresAt,nonce
  } as const;
  assertNetworkPolicy(policy,{kind,scope:envelope.scope,payloadBytes:payloadSize,ttlSeconds:ttl,delegationDepth,hopCount});
  validateNetworkEnvelope(envelope);
  await ensureAgentIdentity(input.organizationId,input.senderAgentId);
  const signed=await signAgentRequest({organizationId:input.organizationId,agentId:input.senderAgentId,payload:envelope});
  if(!(await verifyAgentEnvelopeSignature({organizationId:input.organizationId,agentId:input.senderAgentId,keyVersion:signed.keyVersion,fingerprint:signed.fingerprint,payload:buildNetworkSigningPayload(envelope),signature:signed.signature})))throw new Error("Agent message signature verification failed before enqueue");
  const encrypted=encryptSecret(JSON.stringify(input.payload));
  const db=createAdminClient();
  const{data,error}=await db.from("agent_network_messages").insert({
    organization_id:input.organizationId,message_id:messageId,nonce,sender_agent_id:input.senderAgentId,target_agent_id:input.recipientAgentId,
    conversation_id:envelope.conversationId,correlation_id:envelope.correlationId,reply_to_message_id:envelope.replyToMessageId,
    task_id:envelope.taskId,step_id:envelope.stepId,root_message_id:envelope.rootMessageId,
    delegation_depth:envelope.delegationDepth,hop_count:envelope.hopCount,kind:envelope.kind,scope:envelope.scope,subject:envelope.subject,
    payload_ciphertext:encrypted.ciphertext,payload_iv:encrypted.iv,payload_auth_tag:encrypted.authTag,payload_key_version:encrypted.keyVersion,
    payload_hash:envelope.payloadHash,payload_size_bytes:payloadSize,signature:signed.signature,signer_key_version:signed.keyVersion,
    signer_fingerprint:signed.fingerprint,status:"queued",priority:Math.min(100,Math.max(0,Math.round(input.priority??50))),
    available_at:createdAt,expires_at:expiresAt,last_actor_agent_id:input.senderAgentId
  }).select("*").single();
  if(error){if(error.code==="23505")throw new Error("Network message already exists or nonce was replayed");throw new Error(error.message);}
  return mapMessage(data,input.payload);
}

export async function expireNetworkMessages(organizationId:string){
  const db=createAdminClient();
  const now=new Date().toISOString();
  const{error}=await db.from("agent_network_messages").update({status:"expired",last_actor_agent_id:null,last_error:"Message TTL expired"}).eq("organization_id",organizationId).in("status",["queued","delivered"]).lte("expires_at",now);
  if(error)throw new Error(error.message);
}

export async function listNetworkMessages(input:{organizationId:string;agentId?:string|null;limit?:number;includePayload?:boolean;taskId?:string|null}){
  await expireNetworkMessages(input.organizationId);
  const db=createAdminClient();
  let q=db.from("agent_network_messages").select("*").eq("organization_id",input.organizationId).order("created_at",{ascending:false}).limit(Math.min(100,Math.max(1,input.limit??50)));
  if(input.agentId)q=q.or("sender_agent_id.eq."+input.agentId+",target_agent_id.eq."+input.agentId);
  if(input.taskId)q=q.eq("task_id",input.taskId);
  const{data,error}=await q;
  if(error)throw new Error(error.message);
  const rows=data??[];
  if(!input.includePayload)return rows.map((r:any)=>mapMessage(r));
  return Promise.all(rows.map(async(r:any)=>mapMessage(r,await decryptPayload(r))));
}

export async function listNetworkEvents(input:{organizationId:string;messageId?:string|null;taskId?:string|null;limit?:number}){
  const db=createAdminClient();
  let q=db.from("agent_network_events").select("*").eq("organization_id",input.organizationId).order("created_at",{ascending:false}).limit(Math.min(100,Math.max(1,input.limit??100)));
  if(input.messageId)q=q.eq("message_id",input.messageId);
  if(input.taskId)q=q.eq("task_id",input.taskId);
  const{data,error}=await q;
  if(error)throw new Error(error.message);
  return data??[];
}

export async function claimNetworkMessages(input:{organizationId:string;agentId:string;limit?:number}){
  const db=createAdminClient();
  const{data,error}=await db.rpc("claim_agent_network_messages",{p_organization_id:input.organizationId,p_agent_id:input.agentId,p_limit:Math.min(50,Math.max(1,input.limit??20)),p_now:new Date().toISOString()});
  if(error)throw new Error(error.message);
  return Promise.all((data??[]).map(async(r:any)=>mapMessage(r,await decryptPayload(r))));
}

export async function claimAgentDelegation(input:{organizationId:string;agentId:string;messageId?:string|null}){
  const db=createAdminClient();
  const{data,error}=await db.rpc("claim_agent_network_delegations",{p_organization_id:input.organizationId,p_agent_id:input.agentId,p_message_id:input.messageId??null,p_now:new Date().toISOString()});
  if(error)throw new Error(error.message);
  const row=data?.[0];
  return row?mapMessage(row,await decryptPayload(row)):null;
}

export async function acknowledgeNetworkMessage(input:{organizationId:string;agentId:string;messageId:string;success:boolean;error?:string|null}){
  const db=createAdminClient();
  const{data,error}=await db.rpc("ack_agent_network_message",{p_organization_id:input.organizationId,p_agent_id:input.agentId,p_message_id:input.messageId,p_success:input.success,p_error:input.error??null,p_now:new Date().toISOString()});
  if(error)throw new Error(error.message);
  const row=data?.[0];
  if(!row)throw new Error("Network acknowledgement was not accepted");
  return mapMessage(row,await decryptPayload(row));
}

export async function networkStats(organizationId:string):Promise<AgentNetworkStats>{
  const db=createAdminClient();
  const[{data:messages,error:me},{data:peers,error:pe}]=await Promise.all([
    db.from("agent_network_messages").select("status,kind").eq("organization_id",organizationId),
    db.from("agent_network_peers").select("status").eq("organization_id",organizationId)
  ]);
  if(me)throw new Error(me.message);if(pe)throw new Error(pe.message);
  const stats:AgentNetworkStats={queued:0,delivered:0,acknowledged:0,failed:0,expired:0,activePeers:0,delegationQueued:0,delegationCompleted:0,delegationFailed:0};
  for(const r of messages??[]){
    if(r.status==="queued")stats.queued++;
    else if(r.status==="delivered")stats.delivered++;
    else if(r.status==="acknowledged")stats.acknowledged++;
    else if(r.status==="failed")stats.failed++;
    else if(r.status==="expired")stats.expired++;
    if(r.kind==="delegation"&&r.status==="queued")stats.delegationQueued++;
    if(r.kind==="response"&&r.status==="acknowledged")stats.delegationCompleted++;
    if(r.kind==="response"&&r.status==="failed")stats.delegationFailed++;
  }
  stats.activePeers=(peers??[]).filter((p:any)=>p.status==="active").length;
  return stats;
}
