import test from 'node:test';
import assert from 'node:assert/strict';
import { isPickupOrder, needsSlackShare, workflowStatus, pickupNumber, prepareOrder, isOrderConfirmed } from '../order-domain.js';
import { orderFromRow, orderMatches, payloadForOrder } from '../order-sync.js';

test('後日受取・配送の既存データを判定し、保存時はSlackチェックを要求しない', () => {
  for (const handoff of ['later','hotel','ship']) {
    const draft = {type:'spot',handoff,items:[]};
    assert.equal(needsSlackShare(draft),true);
    const prepared = prepareOrder(draft);
    assert.equal(prepared.submissionState,'confirmed');
    assert.equal(prepared.slackShared,false);
    assert.equal(payloadForOrder(prepared).slackShared,false);
  }
  assert.equal(needsSlackShare({type:'normal',handoff:'later'}),false);
  assert.equal(needsSlackShare({type:'spot',handoff:'now'}),false);
  assert.equal(workflowStatus({type:'spot',handoff:'later',delivered:true}),'active');
  assert.equal(workflowStatus({type:'spot',handoff:'later',delivered:true,slackShared:true,pickupNumber:'1'}),'done');
});

test('保存時に直接確定し、後日受取だけは採番後にPDFを作れる', () => {
  for (const handoff of ['later','hotel','ship']) {
    const draft = { type:'spot', handoff, store:'試験', phone:'0', customer:'試験', paymentMethod:'cash', pickupDate:'2026-09-16', shipAddress:'試験住所', items:[{code:'TEST',name:'架空試験',price:1,qty:1}] };
    const prepared = prepareOrder(draft);
    assert.equal(prepared.submissionState,'confirmed');
    assert.equal(prepared.slackShared,false);
    assert.equal(isOrderConfirmed(prepared),handoff !== 'later');
    const row = orderFromRow({id:'id',simple_pickup_number:handoff === 'later' ? 1 : null,payload:payloadForOrder(prepared)});
    assert.equal(row.submissionState,'confirmed');
    assert.ok(row.confirmedAt);
    assert.equal(isOrderConfirmed(row),true);
    assert.equal(workflowStatus(row),handoff === 'later' ? 'waiting' : 'done');
    assert.equal(isOrderConfirmed(prepareOrder({...row,paid:true,delivered:true},row)),true);
    for (const change of [{notes:'変更'},{pickupDate:'2026-09-17'},{items:[{...draft.items[0],qty:2}]}]) {
      const edited = prepareOrder({...row,...change},row);
      assert.equal(edited.slackShared,false);
      assert.ok(edited.confirmedAt);
      assert.equal(isOrderConfirmed(edited),true);
      assert.equal(edited.pickupNumber,row.pickupNumber);
    }
  }
});

test('従来の確定済み注文は書換え不要で、未確定の旧注文は編集保存時に新方式へ移る', () => {
  const legacy = {type:'spot',handoff:'later',pickupNumber:'4',slackShared:true};
  assert.equal(isOrderConfirmed(legacy),true);
  assert.equal(isOrderConfirmed(prepareOrder(legacy,legacy)),true);
  assert.equal(isOrderConfirmed({...legacy,slackShared:false}),false);
  assert.equal(isOrderConfirmed(prepareOrder({...legacy,slackShared:false},legacy)),true);
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
  const afterReset = orderFromRow({id:'another-order',simple_pickup_number:22,simple_pickup_run_number:1,simple_pickup_generation:2,payload});
  assert.equal(pickupNumber(afterReset),'JEX-2-1');
  assert.equal(orderMatches(afterReset,'jex-2-1'),true);
  const restarted = orderFromRow({id:'restarted-order',simple_pickup_number:24,simple_pickup_run_number:1,simple_pickup_generation:5,payload});
  assert.equal(pickupNumber(restarted),'JEX-1');
  assert.equal(orderMatches(restarted,'jex-1'),true);
  assert.equal(pickupNumber({...restarted,pickupGeneration:6}),'JEX-1');
  assert.equal(Object.hasOwn(payloadForOrder(afterReset),'pickupGeneration'),false);
});
