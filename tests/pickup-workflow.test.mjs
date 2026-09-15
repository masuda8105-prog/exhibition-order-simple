import test from 'node:test';
import assert from 'node:assert/strict';
import { isPickupOrder, needsSlackShare, setSlackShared, workflowStatus, pickupNumber, prepareOrder, confirmOrder, confirmationError, isOrderConfirmed } from '../order-domain.js';
import { orderFromRow, orderMatches, payloadForOrder } from '../order-sync.js';

test('Slackチェックは後日受取・配送だけに表示し、状態と確認日時を保持する', () => {
  for (const handoff of ['later','hotel','ship']) {
    const draft = {type:'spot',handoff};
    assert.equal(needsSlackShare(draft),true);
    const shared = setSlackShared(draft,true,'2026-09-14T00:00:00Z');
    assert.equal(workflowStatus(shared),'active');
    assert.equal(shared.submissionState,'pending');
    assert.equal(setSlackShared(shared,true,'later').slackSharedAt,shared.slackSharedAt);
    assert.equal(setSlackShared(shared,false).slackSharedAt,'');
    assert.equal(workflowStatus(setSlackShared(shared,false)),'active');
    assert.equal(payloadForOrder(shared).slackShared,true);
  }
  assert.equal(needsSlackShare({type:'normal',handoff:'later'}),false);
  assert.equal(needsSlackShare({type:'spot',handoff:'now'}),false);
  assert.equal(workflowStatus({type:'spot',handoff:'later',delivered:true}),'active');
  assert.equal(workflowStatus({type:'spot',handoff:'later',delivered:true,slackShared:true,pickupNumber:'1'}),'done');
});

test('番号発行→共有確認→確定が必要で、共有チェックだけでは確定しない', () => {
  for (const handoff of ['later','hotel','ship']) {
    const draft = { type:'spot', handoff, store:'試験', phone:'0', customer:'試験', paymentMethod:'cash', pickupDate:'2026-09-16', shipAddress:'試験住所', items:[{code:'TEST',name:'架空試験',price:1,qty:1}] };
    const prepared = prepareOrder(draft);
    assert.equal(isOrderConfirmed(prepared),false);
    assert.throws(()=>confirmOrder(prepared));
    const saved = {...prepared,localId:'id',editingId:'id'};
    assert.throws(()=>confirmOrder(saved));
    const numbered = {...saved,pickupNumber:handoff === 'later' ? '1' : ''};
    assert.match(confirmationError(numbered),/Slack/);
    const shared = setSlackShared(numbered,true,'2026-09-15T01:00:00Z');
    assert.equal(isOrderConfirmed(shared),false);
    assert.equal(workflowStatus(shared),'active');
    const confirmed = confirmOrder(shared,'2026-09-15T01:01:00Z');
    assert.equal(isOrderConfirmed(confirmed),true);
    assert.equal(workflowStatus(confirmed),handoff === 'later' ? 'waiting' : 'done');
    const row = orderFromRow({id:'id',simple_pickup_number:handoff === 'later' ? 1 : null,payload:payloadForOrder(confirmed)});
    assert.equal(row.submissionState,'confirmed');
    assert.equal(row.confirmedAt,'2026-09-15T01:01:00Z');
    assert.equal(isOrderConfirmed(row),true);
    assert.equal(isOrderConfirmed(setSlackShared(confirmed,false)),false);
    assert.equal(isOrderConfirmed(prepareOrder({...confirmed,paid:true,delivered:true},confirmed)),true);
    for (const change of [{notes:'変更'},{pickupDate:'2026-09-17'},{items:[{...draft.items[0],qty:2}]}]) {
      const edited = prepareOrder({...confirmed,...change},confirmed);
      assert.equal(edited.slackShared,false);
      assert.equal(edited.confirmedAt,'');
      assert.equal(isOrderConfirmed(edited),false);
      assert.equal(edited.pickupNumber,confirmed.pickupNumber);
    }
    const retried = prepareOrder(shared,shared);
    assert.equal(retried.slackShared,true);
    assert.equal(retried.submissionState,'pending');
  }
});

test('従来の確定済み共有注文は書換え不要、未共有の旧注文はチェック後に確定が必要', () => {
  const legacy = {type:'spot',handoff:'later',pickupNumber:'4',slackShared:true};
  assert.equal(isOrderConfirmed(legacy),true);
  assert.equal(isOrderConfirmed(prepareOrder(legacy,legacy)),true);
  assert.equal(isOrderConfirmed(setSlackShared({...legacy,slackShared:false},true)),false);
  assert.equal(isOrderConfirmed({type:'normal'}),true);
  assert.equal(isOrderConfirmed({type:'spot',handoff:'now'}),true);
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
