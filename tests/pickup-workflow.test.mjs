import test from 'node:test';
import assert from 'node:assert/strict';
import { isPickupOrder, needsSlackShare, setSlackShared, workflowStatus, pickupNumber } from '../order-domain.js';
import { orderFromRow, orderMatches, payloadForOrder } from '../order-sync.js';

test('Slackチェックは後日受取・配送だけに表示し、状態と確認日時を保持する', () => {
  for (const handoff of ['later','hotel','ship']) {
    const draft = {type:'spot',handoff};
    assert.equal(needsSlackShare(draft),true);
    const shared = setSlackShared(draft,true,'2026-09-14T00:00:00Z');
    assert.equal(workflowStatus(shared),handoff === 'later' ? 'waiting' : 'done');
    assert.equal(setSlackShared(shared,true,'later').slackSharedAt,shared.slackSharedAt);
    assert.equal(setSlackShared(shared,false).slackSharedAt,'');
    assert.equal(workflowStatus(setSlackShared(shared,false)),'active');
    assert.equal(payloadForOrder(shared).slackShared,true);
  }
  assert.equal(needsSlackShare({type:'normal',handoff:'later'}),false);
  assert.equal(needsSlackShare({type:'spot',handoff:'now'}),false);
  assert.equal(workflowStatus({type:'spot',handoff:'later',delivered:true}),'done');
});

test('お渡し番号はサーバー列だけを採用し、後日受取にJEX番号を表示・検索する', () => {
  const payload = {type:'spot',handoff:'later',pickupNumber:'9999'};
  const saved = orderFromRow({id:'test-order',simple_pickup_number:12,payload});
  assert.equal(pickupNumber(saved),'JEX-12');
  assert.equal(isPickupOrder(saved),true);
  assert.equal(orderMatches(saved,'jex-12'),true);
  assert.equal(pickupNumber(orderFromRow({payload})), '');
  assert.equal(pickupNumber({...saved,handoff:'hotel'}),'');
  assert.equal(pickupNumber({...saved,type:'normal'}),'');
  assert.equal(pickupNumber({...saved,pickupNumber:'0'}),'');
  assert.equal(Object.hasOwn(payloadForOrder(saved),'pickupNumber'),false);
  assert.equal(pickupNumber(orderFromRow({simple_pickup_number:12,payload:payloadForOrder({...saved,pickupDate:'2030-01-02'})})),'JEX-12');
});
