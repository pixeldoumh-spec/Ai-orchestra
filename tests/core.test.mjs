import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAdaptiveFallbackPlan, readyStepIds, selectParallelBatch, validatePlan } from '../.tmp-core/workflow.js';
import { canUsePermission, requiresApproval } from '../.tmp-core/policy.js';
import { effectiveCircuitState, nextCircuitState, selectConnectorCandidate } from '../.tmp-core/connector.js';
import { computeTrustScore, isCapabilityContractValid, negotiateCapabilities, normalizeCapabilities, supportsCapabilities, trustScoreSatisfies } from '../.tmp-core/network.js';

test('V3 fallback plan has explicit parallel branches and verification coverage',()=>{
  const plan=buildAdaptiveFallbackPlan('make report',{research:'research',analysis:'analysis',writer:'writer',verifier:'verifier'});
  assert.equal(plan.version,'v3');
  assert.equal(plan.steps.length,5);
  assert.deepEqual(plan.steps[2].dependsOn,['research_primary','research_secondary']);
  assert.deepEqual(plan.steps[4].verifies,['writer']);
});

test('workflow validator rejects cycles and missing dependencies',()=>{
  const base={version:'v3',steps:[
    {id:'a1',agentId:'research',objective:'a',dependsOn:['b1'],maxAttempts:3,kind:'work'},
    {id:'b1',agentId:'research',objective:'b',dependsOn:['a1'],maxAttempts:3,kind:'work'},
    {id:'v1',agentId:'verifier',objective:'verify',dependsOn:['a1','b1'],maxAttempts:3,kind:'verification',verifies:['a1','b1']}
  ]};
  assert.throws(()=>validatePlan(base,new Set(['research','verifier'])),/cycle/i);
  const missing={...base,steps:base.steps.map((s,i)=>i===0?{...s,dependsOn:['missing']}:s)};
  assert.throws(()=>validatePlan(missing,new Set(['research','verifier'])),/Missing dependency/);
});

test('ready steps respect dependencies and retry delays',()=>{
  assert.deepEqual(readyStepIds([{id:'a',status:'queued',depends_on:[]},{id:'b',status:'queued',depends_on:['a']}]),['a']);
  assert.deepEqual(readyStepIds([{id:'a',status:'verified',depends_on:[]},{id:'b',status:'queued',depends_on:['a']}]),['b']);
  assert.deepEqual(readyStepIds([{id:'a',status:'queued',depends_on:[],run_after:new Date(2_000).toISOString()}],1_000),[]);
  assert.deepEqual(readyStepIds([{id:'a',status:'queued',depends_on:[],run_after:new Date(500).toISOString()}],1_000),['a']);
});

test('parallel batch stays inside configured budget ceiling',()=>{
  assert.deepEqual(selectParallelBatch(['a','b','c'],new Map([['a',100],['b',120],['c',120]]),240),['a','b']);
  assert.deepEqual(selectParallelBatch(['a','b'],new Map([['a',150],['b',150]]),100),[]);
});

test('high and critical risk require explicit approval',()=>{
  assert.equal(requiresApproval('high'),true);
  assert.equal(requiresApproval('critical'),true);
  assert.equal(canUsePermission({agentPermissions:['x'],requestedPermission:'x',risk:'high',approvalGranted:false}),false);
  assert.equal(canUsePermission({agentPermissions:['x'],requestedPermission:'x',risk:'high',approvalGranted:true}),true);
});

test('V4 circuit breaker opens after the failure threshold and later enters half-open probe state',()=>{
  const state=nextCircuitState({current:'closed',consecutiveFailures:2,success:false,failureThreshold:3,cooldownSeconds:30,now:1000});
  assert.equal(state.state,'open');
  assert.equal(effectiveCircuitState({state:state.state,consecutiveFailures:state.consecutiveFailures,cooldownUntil:state.cooldownUntil},1500),'open');
  assert.equal(effectiveCircuitState({state:state.state,consecutiveFailures:state.consecutiveFailures,cooldownUntil:state.cooldownUntil},31000),'half_open');
});

test('V4 fallback routing skips an open primary but permits a cooled primary probe',()=>{
  const snaps=new Map([['primary',{state:'open',consecutiveFailures:3,cooldownUntil:new Date(60000).toISOString()}],['fallback',{state:'closed',consecutiveFailures:0,cooldownUntil:null}]]);
  assert.equal(selectConnectorCandidate(['primary','fallback'],snaps,10000),'fallback');
  assert.equal(selectConnectorCandidate(['primary','fallback'],new Map([['primary',{state:'open',consecutiveFailures:3,cooldownUntil:new Date(1000).toISOString()}],['fallback',{state:'closed',consecutiveFailures:0,cooldownUntil:null}]]),10000),'primary');
});

test('V5 capability normalization and negotiation never widen requested access',()=>{
  assert.deepEqual(normalizeCapabilities([' Research ','research','WRITE','']),['research','write']);
  assert.deepEqual(negotiateCapabilities(['research','write','summarize'],['research','admin','write'],['research','write']),['research','write']);
  assert.equal(supportsCapabilities(['research','write'],['research','write']),true);
  assert.equal(supportsCapabilities(['research'],['research','write']),false);
});

test('V5 capability contracts only contain requested and provider-supported capabilities',()=>{
  assert.equal(isCapabilityContractValid(['research','write'],['research'],['research']),true);
  assert.equal(isCapabilityContractValid(['research'],['research','write'],['research']),false);
});

test('V5 reputation uses a bounded Bayesian-style prior and threshold checks',()=>{
  assert.equal(computeTrustScore({total:0,completed:0,failed:0}),50);
  assert.equal(computeTrustScore({total:10,completed:10,failed:0}),69.23);
  assert.equal(trustScoreSatisfies(75,75),true);
  assert.equal(trustScoreSatisfies(74.99,75),false);
});
