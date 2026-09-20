import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nominatedLivePlanningDescriptors } from './planning-nominations.js';

test('unrelated warm provider entries cannot fill a fresh task card', () => {
  const live = [{ id: 'cap:resolved:googledrive_find_file:definition:current' }];
  assert.deepEqual(nominatedLivePlanningDescriptors({live, advisory: [{id:'cap:resolved:run_shell_command'}], preferredLiveIds:new Set()}), []);
});
test('stable index nomination selects the live version, never historical descriptor bytes', () => {
  const live = [{id:'cap:resolved:read_file:definition:new', schema:'current'}];
  assert.deepEqual(nominatedLivePlanningDescriptors({live, advisory:[{id:'cap:resolved:read_file:definition:old'}], preferredLiveIds:new Set()}),live);
});
test('exact revalidated learned definitions remain nominated', () => {
  const live = [{id:'local:space_save'}, {id:'unrelated'}];
  assert.deepEqual(nominatedLivePlanningDescriptors({live, advisory:[], preferredLiveIds:new Set(['local:space_save'])}),[live[0]]);
});
test('a historical nomination cannot invent a missing live operation or match a sibling name', () => {
  const live = [{id:'cap:resolved:read_file_metadata'}];
  assert.deepEqual(nominatedLivePlanningDescriptors({live, advisory:[{id:'cap:resolved:read_file'}],preferredLiveIds:new Set()}),[]);
});
