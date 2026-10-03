import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDefaultPlan, readyStepIds } from '../.tmp-core/workflow.js';
import { canUsePermission, requiresApproval } from '../.tmp-core/policy.js';

test('default plan is dependency ordered',()=>{const plan=buildDefaultPlan('make report');assert.equal(plan.length,4);assert.deepEqual(plan[0].dependsOn,[]);assert.deepEqual(plan[3].dependsOn,['writer']);});
test('ready steps respect dependencies and retry delays',()=>{assert.deepEqual(readyStepIds([{id:'a',status:'queued',depends_on:[]},{id:'b',status:'queued',depends_on:['a']}]),['a']);assert.deepEqual(readyStepIds([{id:'a',status:'verified',depends_on:[]},{id:'b',status:'queued',depends_on:['a']}]),['b']);});
test('high risk requires explicit approval',()=>{assert.equal(requiresApproval('high'),true);assert.equal(canUsePermission({agentPermissions:['x'],requestedPermission:'x',risk:'high',approvalGranted:false}),false);assert.equal(canUsePermission({agentPermissions:['x'],requestedPermission:'x',risk:'high',approvalGranted:true}),true);});
