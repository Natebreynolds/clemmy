import {test} from 'node:test';
import assert from 'node:assert/strict';
import {heartbeatStateWords,heartbeatLastCheckWords,liveWorkSummary} from './proactive-status.js';
test('quiet, incomplete, unavailable and unconfirmed remain distinct',()=>{
 assert.equal(heartbeatStateWords({state:'quiet_hours',lastCheck:{state:'failed'}}),'Paused for quiet hours');
 assert.equal(heartbeatLastCheckWords({state:'quiet_hours',lastCheck:{state:'failed'}}),'Last check failed');
 assert.equal(heartbeatLastCheckWords({state:'partial',lastCheck:{state:'partial'}}),'Last check incomplete');
 assert.equal(heartbeatStateWords(undefined),'Check status unavailable');
 assert.equal(heartbeatLastCheckWords({state:'scheduled',lastCheck:{state:'recorded'}}),'Last check recorded');
});
test('not running never implies caught up or a successful background check',()=>{
 assert.deepEqual(liveWorkSummary(['needs_you','stalled']),{label:'1 item needs you',attention:true});
 assert.deepEqual(liveWorkSummary(['stalled']),{label:'1 item needs attention',attention:true});
 assert.deepEqual(liveWorkSummary([]),{label:'Nothing running',attention:false});
 assert.deepEqual(liveWorkSummary([],true),{label:'Work status unavailable',attention:true});
});
