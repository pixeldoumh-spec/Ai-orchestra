import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { ensureAgentIdentity, signAgentRequest } from "@/lib/orchestrator/identity";
import { effectiveCircuitState } from "@/lib/core/connector";
import { encryptSecret, hashJson } from "@/lib/vault/crypto";
import type { AgentDefinition, ToolInvocation, ToolResult } from "@/lib/orchestrator/types";
import type { AgentConnectorBinding, ConnectorCredentialMetadata, ConnectorDefinition } from "./types";

function mapConnector(row: any): ConnectorDefinition {
  return { id: row.id, organizationId: row.organization_id, name: row.name, kind: row.kind, baseUrl: row.base_url ?? null, status: row.status,
    authScheme: row.auth_scheme, version: row.version, circuitState: row.circuit_state, consecutiveFailures: Number(row.consecutive_failures ?? 0),
    failureThreshold: Number(row.failure_threshold ?? 3), cooldownSeconds: Number(row.cooldown_seconds ?? 60), cooldownUntil: row.cooldown_until ?? null,
    fallbackConnectorId: row.fallback_connector_id ?? null, lastSuccessAt: row.last_success_at ?? null, lastFailureAt: row.last_failure_at ?? null };
}
function mapBinding(row: any): AgentConnectorBinding {
  return { id: row.id, organizationId: row.organization_id, agentId: row.agent_id, connectorId: row.connector_id, credentialId: row.credential_id ?? null,
    allowedTools: Array.isArray(row.allowed_tools) ? row.allowed_tools : [], scopes: Array.isArray(row.scopes) ? row.scopes : [], priority: Number(row.priority ?? 100), status: row.status };
}
export async function listConnectors(organizationId: string): Promise<ConnectorDefinition[]> {
  const db=createAdminClient(); const {data,error}=await db.from("connectors").select("*").eq("organization_id",organizationId).order("created_at",{ascending:true});
  if(error)throw new Error(error.message); return (data??[]).map(mapConnector);
}
export async function listBindings(organizationId: string): Promise<AgentConnectorBinding[]> {
  const db=createAdminClient(); const {data,error}=await db.from("agent_connector_bindings").select("*").eq("organization_id",organizationId).order("priority",{ascending:true});
  if(error)throw new Error(error.message); return (data??[]).map(mapBinding);
}
export async function createConnector(input:{organizationId:string;name:string;kind:"reserved"|"http";baseUrl?:string|null;authScheme:"none"|"bearer"|"api_key"|"hmac";version?:string;fallbackConnectorId?:string|null}) {
  if(input.baseUrl&&!input.baseUrl.startsWith("https://"))throw new Error("Connector baseUrl must use HTTPS");
  const db=createAdminClient(); const {data,error}=await db.from("connectors").insert({organization_id:input.organizationId,name:input.name,kind:input.kind,base_url:input.baseUrl??null,status:"active",auth_scheme:input.authScheme,version:input.version??"1.0.0",failure_threshold:3,cooldown_seconds:60,fallback_connector_id:input.fallbackConnectorId??null}).select("*").single();
  if(error)throw new Error(error.message); return mapConnector(data);
}
export async function setConnectorStatus(orgId:string,id:string,status:"active"|"degraded"|"disabled"){const db=createAdminClient();const{data,error}=await db.from("connectors").update({status}).eq("organization_id",orgId).eq("id",id).select("*").single();if(error)throw new Error(error.message);return mapConnector(data);}
export async function resetConnectorCircuit(orgId:string,id:string){const db=createAdminClient();const{data,error}=await db.from("connectors").update({circuit_state:"closed",consecutive_failures:0,cooldown_until:null,status:"active"}).eq("organization_id",orgId).eq("id",id).select("*").single();if(error)throw new Error(error.message);return mapConnector(data);}
export async function bindAgentConnector(input:{organizationId:string;agentId:string;connectorId:string;credentialId?:string|null;allowedTools:string[];scopes:string[];priority?:number}) {
  const db=createAdminClient();
  const {data:agent,error:ae}=await db.from("agents").select("id").eq("organization_id",input.organizationId).eq("id",input.agentId).maybeSingle();if(ae)throw new Error(ae.message);if(!agent)throw new Error("Agent not found");
  const {data:connector,error:ce}=await db.from("connectors").select("id").eq("organization_id",input.organizationId).eq("id",input.connectorId).maybeSingle();if(ce)throw new Error(ce.message);if(!connector)throw new Error("Connector not found");
  if(input.credentialId){const{data:cred,error}=await db.from("connector_credentials").select("id").eq("organization_id",input.organizationId).eq("connector_id",input.connectorId).eq("id",input.credentialId).maybeSingle();if(error)throw new Error(error.message);if(!cred)throw new Error("Credential not found for connector");}
  const{data,error}=await db.from("agent_connector_bindings").upsert({organization_id:input.organizationId,agent_id:input.agentId,connector_id:input.connectorId,credential_id:input.credentialId??null,allowed_tools:input.allowedTools,scopes:input.scopes,priority:input.priority??100,status:"active"},{onConflict:"organization_id,agent_id,connector_id"}).select("*").single();
  if(error)throw new Error(error.message);return mapBinding(data);
}
export async function storeConnectorCredential(input:{organizationId:string;connectorId:string;name:string;secret:string;scopes:string[];authScheme:"none"|"bearer"|"api_key"|"hmac";expiresAt?:string|null}) {
  const db=createAdminClient();const{data:connector,error:ce}=await db.from("connectors").select("id,auth_scheme").eq("organization_id",input.organizationId).eq("id",input.connectorId).maybeSingle();if(ce)throw new Error(ce.message);if(!connector)throw new Error("Connector not found");
  if(connector.auth_scheme!==input.authScheme)throw new Error("Credential auth scheme must match connector auth scheme");
  const encrypted=encryptSecret(input.secret);
  const{data,error}=await db.from("connector_credentials").insert({organization_id:input.organizationId,connector_id:input.connectorId,name:input.name,scopes:input.scopes,auth_scheme:input.authScheme,status:"active",secret_ciphertext:encrypted.ciphertext,secret_iv:encrypted.iv,secret_auth_tag:encrypted.authTag,key_version:encrypted.keyVersion,expires_at:input.expiresAt??null}).select("id,connector_id,organization_id,name,scopes,auth_scheme,status,key_version,expires_at").single();
  if(error)throw new Error(error.message);return data as ConnectorCredentialMetadata;
}
export async function listConnectorCredentials(orgId:string,connectorId:string){const db=createAdminClient();const{data,error}=await db.from("connector_credentials").select("id,connector_id,organization_id,name,scopes,auth_scheme,status,key_version,expires_at,created_at,rotated_at").eq("organization_id",orgId).eq("connector_id",connectorId).order("created_at",{ascending:false});if(error)throw new Error(error.message);return data??[];}
export async function resolveConnectorRoute(input:{organizationId:string;agentId:string;toolId:string}) {
  const db=createAdminClient();const{data,error}=await db.from("agent_connector_bindings").select("*").eq("organization_id",input.organizationId).eq("agent_id",input.agentId).eq("status","active").order("priority",{ascending:true});if(error)throw new Error(error.message);
  const bindings=(data??[]).map(mapBinding).filter((b)=>b.allowedTools.includes(input.toolId));if(bindings.length===0)return null;
  for(const binding of bindings){const visited=new Set<string>();let connectorId:string|null=binding.connectorId;
    for(let depth=0;connectorId&&depth<5;depth++){if(visited.has(connectorId))break;visited.add(connectorId);
      const{data:row,error:re}=await db.from("connectors").select("*").eq("organization_id",input.organizationId).eq("id",connectorId).maybeSingle();if(re)throw new Error(re.message);if(!row)break;
      const connector=mapConnector(row);if(connector.status!=="disabled"&&effectiveCircuitState(connector)!=="open"){
        if(connector.authScheme!=="none"&&!binding.credentialId)throw new Error(`Connector ${connector.name} requires a scoped credential`);
        if(binding.credentialId){const{data:cred,error:qe}=await db.from("connector_credentials").select("id,status,expires_at,scopes,auth_scheme").eq("organization_id",input.organizationId).eq("connector_id",connectorId).eq("id",binding.credentialId).maybeSingle();if(qe)throw new Error(qe.message);
          if(!cred||cred.status!=="active"||(cred.expires_at&&Date.parse(cred.expires_at)<=Date.now()))throw new Error("Bound connector credential is not active");
          if(cred.auth_scheme!==connector.authScheme)throw new Error("Credential auth scheme mismatch");
          const scopes=Array.isArray(cred.scopes)?cred.scopes:[];if(scopes.length&&!scopes.includes(input.toolId))throw new Error(`Credential is not scoped for ${input.toolId}`);
        }
        return{connector,binding,fallbackDepth:depth};
      } connectorId=connector.fallbackConnectorId;
    }
  } return null;
}
export async function prepareConnectorRequest(input:{organizationId:string;taskId:string;stepId:string;agent:AgentDefinition;toolInvocation:ToolInvocation}) {
  const route=await resolveConnectorRoute({organizationId:input.organizationId,agentId:input.agent.id,toolId:input.toolInvocation.toolId});if(!route)throw new Error("No healthy connector route is available for this agent/tool");
  await ensureAgentIdentity(input.organizationId,input.agent.id);
  const requestId=`req_${randomUUID()}`,nonce=randomUUID(),timestamp=new Date().toISOString(),payloadHash=hashJson({toolId:input.toolInvocation.toolId,input:input.toolInvocation.input});
  const signed=await signAgentRequest({organizationId:input.organizationId,agentId:input.agent.id,payload:{agentId:input.agent.id,connectorId:route.connector.id,requestId,timestamp,nonce,payloadHash}});
  const db=createAdminClient();const{data,error}=await db.from("connector_requests").insert({organization_id:input.organizationId,task_id:input.taskId,step_id:input.stepId,agent_id:input.agent.id,connector_id:route.connector.id,credential_id:route.binding.credentialId,request_id:requestId,nonce,payload_hash:payloadHash,signature:signed.signature,key_version:signed.keyVersion,status:"prepared",expires_at:new Date(Date.now()+300000).toISOString()}).select("id,request_id,connector_id,credential_id,key_version,expires_at").single();
  if(error)throw new Error(error.message);return{...data,fingerprint:signed.fingerprint,fallbackDepth:route.fallbackDepth};
}
export async function recordToolInvocation(input:{organizationId:string;taskId:string;stepId:string;agentId:string;toolId:string;invocation:ToolInvocation;status:"requested"|"approval_required"|"approved"|"denied"|"executed"|"failed";connectorRequestId?:string|null;result?:ToolResult|null}) {
  const db=createAdminClient();const{data,error}=await db.from("tool_invocations").insert({organization_id:input.organizationId,task_id:input.taskId,step_id:input.stepId,agent_id:input.agentId,tool_id:input.toolId,connector_request_id:input.connectorRequestId??null,status:input.status,input_hash:hashJson(input.invocation.input),output_hash:input.result?.output==null?null:hashJson(input.result.output),policy_decision:input.status,completed_at:["executed","failed","denied"].includes(input.status)?new Date().toISOString():null}).select("id").single();if(error)throw new Error(error.message);return data.id as string;
}
export async function updateConnectorRequestStatus(id:string,status:"approved"|"denied"|"executed"|"failed"){const db=createAdminClient();const{error}=await db.from("connector_requests").update({status,completed_at:["executed","failed","denied"].includes(status)?new Date().toISOString():null}).eq("id",id).in("status",["prepared","approved"]);if(error)throw new Error(error.message);}
export async function listConnectorHealth(orgId:string){const db=createAdminClient();const{data,error}=await db.from("connector_health_events").select("id,connector_id,outcome,latency_ms,http_status,error_class,source,created_at").eq("organization_id",orgId).order("created_at",{ascending:false}).limit(50);if(error)throw new Error(error.message);return data??[];}
export async function recordConnectorOutcome(input:{organizationId:string;connectorId:string;success:boolean;latencyMs?:number;httpStatus?:number|null;errorClass?:string|null;source?:string}){const db=createAdminClient();const{data,error}=await db.rpc("record_connector_outcome",{p_organization_id:input.organizationId,p_connector_id:input.connectorId,p_success:input.success,p_latency_ms:Math.max(0,Math.round(input.latencyMs??0)),p_http_status:input.httpStatus??null,p_error_class:input.errorClass??null,p_source:input.source??"connector-runtime",p_now:new Date().toISOString()});if(error)throw new Error(error.message);return data?.[0]??null;}
