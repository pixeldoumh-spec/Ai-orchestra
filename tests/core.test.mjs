import assert from"node:assert/strict";
import test from"node:test";
import{buildAdaptiveFallbackPlan,findFailedCurrentRevisionStep,readyStepIds,selectParallelBatch,validatePlan}from"../.tmp-core/workflow.js";
import{canUsePermission,requiresApproval}from"../.tmp-core/policy.js";
import{effectiveCircuitState,nextCircuitState,selectConnectorCandidate}from"../.tmp-core/connector.js";
import{hasEnterprisePermission,rolePermissions}from"../.tmp-core/enterprise/rbac.js";
import{canonicalJson,validateNetworkEnvelope}from"../.tmp-core/network/protocol.js";
import{assertNetworkPolicy,normalizeNetworkPolicy}from"../.tmp-core/network/policy.js";
import{isDispatchEligible,isDispatchCooldownActive,isHeartbeatFresh,safeWorkerExitStatus,stepNeedsRecovery,isStaleLeaseTakeoverEligible}from"../.tmp-core/runtime.js";
test("V3 fallback plan has parallel branches and verification coverage",()=>{const p=buildAdaptiveFallbackPlan("make report",{research:"research",analysis:"analysis",writer:"writer",verifier:"verifier"});assert.equal(p.steps.length,5);assert.deepEqual(p.steps[2].dependsOn,["research_primary","research_secondary"]);assert.deepEqual(p.steps[4].verifies,["writer"]);});
test("workflow validator rejects cycles and missing dependencies",()=>{const b={version:"v3",steps:[{id:"a1",agentId:"research",objective:"a",dependsOn:["b1"],maxAttempts:3,kind:"work"},{id:"b1",agentId:"research",objective:"b",dependsOn:["a1"],maxAttempts:3,kind:"work"},{id:"v1",agentId:"verifier",objective:"verify",dependsOn:["a1","b1"],maxAttempts:3,kind:"verification",verifies:["a1","b1"]}]};assert.throws(()=>validatePlan(b,new Set(["research","verifier"])),/cycle/i);assert.throws(()=>validatePlan({...b,steps:b.steps.map((s,i)=>i===0?{...s,dependsOn:["missing"]}:s)},new Set(["research","verifier"])),/Missing dependency/);});
test("V6.6.1 convergence detects failed steps only in the active revision",()=>{
 const steps=[{id:"old_fail",status:"failed",plan_revision:1},{id:"current_ok",status:"verified",plan_revision:2},{id:"current_fail",status:"failed",plan_revision:2}];
 assert.equal(findFailedCurrentRevisionStep(steps,2)?.id,"current_fail");
 assert.equal(findFailedCurrentRevisionStep(steps,3),null);
});
test("ready steps honor dependencies and retry timing",()=>{assert.deepEqual(readyStepIds([{id:"a",status:"queued",depends_on:[]},{id:"b",status:"queued",depends_on:["a"]}]),["a"]);assert.deepEqual(readyStepIds([{id:"a",status:"verified",depends_on:[]},{id:"b",status:"queued",depends_on:["a"]}]),["b"]);assert.deepEqual(readyStepIds([{id:"a",status:"queued",depends_on:[],run_after:new Date(2000).toISOString()}],1000),[]);});
test("parallel batches remain under budget",()=>{assert.deepEqual(selectParallelBatch(["a","b","c"],new Map([["a",100],["b",120],["c",120]]),240),["a","b"]);assert.deepEqual(selectParallelBatch(["a","b"],new Map([["a",150],["b",150]]),100),[]);});
test("high and critical risk require approval",()=>{assert.equal(requiresApproval("high"),true);assert.equal(requiresApproval("critical"),true);assert.equal(canUsePermission({agentPermissions:["x"],requestedPermission:"x",risk:"high",approvalGranted:false}),false);assert.equal(canUsePermission({agentPermissions:["x"],requestedPermission:"x",risk:"high",approvalGranted:true}),true);});
test("V4 circuit breaker opens and later becomes half-open",()=>{const s=nextCircuitState({current:"closed",consecutiveFailures:2,success:false,failureThreshold:3,cooldownSeconds:30,now:1000});assert.equal(s.state,"open");assert.equal(effectiveCircuitState({state:s.state,consecutiveFailures:s.consecutiveFailures,cooldownUntil:s.cooldownUntil},31000),"half_open");});
test("V4 fallback skips open primary",()=>{const snaps=new Map([["primary",{state:"open",consecutiveFailures:3,cooldownUntil:new Date(60000).toISOString()}],["fallback",{state:"closed",consecutiveFailures:0,cooldownUntil:null}]]);assert.equal(selectConnectorCandidate(["primary","fallback"],snaps,10000),"fallback");});
test("V5 RBAC separates governance, billing and operations",()=>{assert.equal(hasEnterprisePermission("owner","enterprise.manage"),true);assert.equal(hasEnterprisePermission("operator","enterprise.manage"),false);assert.equal(hasEnterprisePermission("billing","billing.read"),true);assert.equal(hasEnterprisePermission("billing","runtime.run"),false);assert.deepEqual(rolePermissions("viewer"),["enterprise.read","network.read"]);});
test("V6 network RBAC is least privilege",()=>{assert.equal(hasEnterprisePermission("operator","network.send"),true);assert.equal(hasEnterprisePermission("viewer","network.send"),false);assert.equal(hasEnterprisePermission("auditor","network.read"),true);assert.equal(hasEnterprisePermission("auditor","network.payload.read"),false);assert.equal(hasEnterprisePermission("admin","network.manage"),true);});
test("V6.4 envelope is deterministic and bounds signed lineage",()=>{const e={protocolVersion:2,organizationId:"org",messageId:"net_1",senderAgentId:"a",recipientAgentId:"b",conversationId:"c",correlationId:"corr_1",replyToMessageId:null,rootMessageId:"net_1",taskId:"task_1",stepId:"step_1",delegationDepth:0,hopCount:0,kind:"event",scope:"task.coordination",subject:"hello",payloadHash:"0".repeat(64),createdAt:new Date(1000).toISOString(),expiresAt:new Date(301000).toISOString(),nonce:"n"};assert.equal(canonicalJson(e),canonicalJson({...e}));assert.equal(validateNetworkEnvelope(e,2000),true);assert.throws(()=>validateNetworkEnvelope({...e,expiresAt:new Date(9000).toISOString()},2000),/TTL/);assert.throws(()=>validateNetworkEnvelope({...e,expiresAt:new Date(4000000).toISOString()},2000),/TTL/);assert.throws(()=>validateNetworkEnvelope({...e,kind:"delegation",scope:"task.coordination"},2000),/delegation/);assert.equal(validateNetworkEnvelope({...e,kind:"delegation",scope:"agent.delegation.execute",correlationId:"deleg_1"},2000),true);assert.throws(()=>validateNetworkEnvelope({...e,kind:"response",replyToMessageId:null},2000),/response/i);assert.throws(()=>validateNetworkEnvelope({...e,delegationDepth:7},2000),/delegation depth/i);assert.throws(()=>validateNetworkEnvelope({...e,hopCount:13},2000),/hop count/i);});
test("V6.4 organization policy bounds delegation and network hops",()=>{const p=normalizeNetworkPolicy({organizationId:"org",maxDelegationDepth:2,maxHops:4});assert.equal(p.allowDelegation,true);assert.doesNotThrow(()=>assertNetworkPolicy(p,{kind:"delegation",scope:"agent.delegation.execute",payloadBytes:128,ttlSeconds:300,delegationDepth:1,hopCount:1}));assert.throws(()=>assertNetworkPolicy({...p,allowDelegation:false},{kind:"delegation",scope:"agent.delegation.execute",payloadBytes:128,ttlSeconds:300,delegationDepth:1,hopCount:1}),/disabled/);assert.throws(()=>assertNetworkPolicy(p,{kind:"event",scope:"forbidden.scope",payloadBytes:128,ttlSeconds:300}),/blocked/);assert.throws(()=>assertNetworkPolicy(p,{kind:"delegation",scope:"agent.delegation.execute",payloadBytes:128,ttlSeconds:300,delegationDepth:3,hopCount:1}),/depth/i);});


test("V6.6.1 redrive does not duplicate a live running worker",()=>{
 const now=Date.parse("2026-10-05T20:00:00.000Z");
 const task={status:"running",lease_until:"2026-10-05T20:05:00.000Z",last_heartbeat_at:"2026-10-05T20:00:00.000Z",last_dispatched_at:"2026-10-05T19:59:00.000Z"};
 assert.equal(isDispatchEligible(task,now),false);
 assert.equal(isHeartbeatFresh(task,now),true);
});
test("V6.6.1 stale running task becomes redrive eligible only after heartbeat is stale",()=>{
 const now=Date.parse("2026-10-05T20:00:00.000Z");
 const task={status:"running",lease_until:null,last_heartbeat_at:"2026-10-05T19:56:00.000Z",last_dispatched_at:"2026-10-05T19:54:00.000Z"};
 assert.equal(isDispatchEligible(task,now,120000,45000),true);
});
test("V6.6.1 dispatch cooldown blocks duplicate reservations",()=>{
 const now=Date.parse("2026-10-05T20:00:00.000Z");
 const task={status:"queued",run_after:null,lease_until:null,last_heartbeat_at:null,last_dispatched_at:"2026-10-05T19:59:30.000Z"};
 assert.equal(isDispatchCooldownActive(task,now,45000),true);
 assert.equal(isDispatchEligible(task,now,120000,45000),false);
});
test("V6.6.1 worker exit never leaves a running task without a lease",()=>{
 assert.equal(safeWorkerExitStatus({status:"running"}),"queued");
 assert.equal(safeWorkerExitStatus({status:"awaiting_approval"}),"terminal");
 assert.equal(safeWorkerExitStatus({status:"verified"}),"terminal");
});


test("V6.6.1 step recovery detects older or unknown worker generations",()=>{
 assert.equal(stepNeedsRecovery(null,2),true);
 assert.equal(stepNeedsRecovery(1,2),true);
 assert.equal(stepNeedsRecovery(2,2),false);
});


test("V6.6.1 stale active lease becomes eligible after prolonged heartbeat loss",()=>{
 const now=Date.parse("2026-10-05T16:00:00.000Z");
 const task={status:"running",lease_until:"2026-10-05T16:03:00.000Z",last_heartbeat_at:"2026-10-05T15:54:00.000Z"};
 assert.equal(isStaleLeaseTakeoverEligible(task,now,300000),true);
});
test("V6.6.1 active heartbeat never gets forcibly reclaimed",()=>{
 const now=Date.parse("2026-10-05T16:00:00.000Z");
 const task={status:"running",lease_until:"2026-10-05T16:05:00.000Z",last_heartbeat_at:"2026-10-05T15:59:30.000Z"};
 assert.equal(isStaleLeaseTakeoverEligible(task,now,300000),false);
});
