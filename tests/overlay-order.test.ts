import test from 'node:test';
import assert from 'node:assert/strict';
import {overlayOrderRepair} from '../src/main/overlay-order.ts';
const normal=(hwnd:number)=>({hwnd,topmost:false}),top=(hwnd:number)=>({hwnd,topmost:true});
test('recorded failure: native topmost flag can remain true while an ordinary window is above the overlay',()=>{
  assert.deepEqual(overlayOrderRepair(true,[normal(328970)]),{reason:'ordinary-above',below:null});
  assert.deepEqual(overlayOrderRepair(true,[normal(328970),normal(1377812)]),{reason:'ordinary-above',below:null});
  assert.equal(overlayOrderRepair(true,[]),null,'a corrected overlay needs no further mutations');
});
test('lost native flag is repaired even with no covering windows',()=>{
  assert.deepEqual(overlayOrderRepair(false,[]),{reason:'lost-topmost',below:null});
});
test('legitimate topmost covers are preserved and do not cause a constant fight',()=>{
  assert.equal(overlayOrderRepair(true,[top(1),top(2)]),null);
  assert.deepEqual(overlayOrderRepair(true,[normal(3),top(1),top(2)]),{reason:'ordinary-above',below:1});
  assert.deepEqual(overlayOrderRepair(false,[top(1),top(2)]),{reason:'lost-topmost',below:1});
});
