import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttachmentStore, validatePhoto, MAX_PHOTO_BYTES, MAX_PHOTOS } from '../order-attachments.js';
import { payloadForOrder } from '../order-sync.js';
import { readFileSync } from 'node:fs';

test('添付写真の形式・サイズを制限し、空ファイルやSVGを拒否する', () => {
  assert.equal(validatePhoto({type:'image/jpeg',name:'photo.jpg',size:100}), '');
  assert.equal(validatePhoto({type:'image/heic',name:'photo.heic',size:100}), '');
  assert.equal(validatePhoto({type:'',name:'photo.PNG',size:100}), '');
  assert.ok(validatePhoto({type:'image/svg+xml',name:'photo.svg',size:100}));
  assert.ok(validatePhoto({type:'application/pdf',name:'photo.pdf',size:100}));
  assert.ok(validatePhoto({type:'image/jpeg',size:MAX_PHOTO_BYTES+1}));
  assert.ok(validatePhoto({type:'image/jpeg',size:0}));
});

test('添付写真は注文のクラウドpayloadへ含めず、通常印刷から除外する', () => {
  const payload=payloadForOrder({type:'spot',attachments:[{url:'blob:private-photo'}]});
  assert.ok(!JSON.stringify(payload).includes('private-photo'));
  const css=readFileSync(new URL('../styles.css',import.meta.url),'utf8');
  assert.ok(css.includes('.shareAttachmentPages { display: none; }'));
  assert.ok(css.includes('body[data-print-copy="sharing"] .shareAttachmentPages { display: block !important; }'));
  assert.ok(!css.includes('.receiptCopy[data-copy="customer"] { display: none'));
  const source=readFileSync(new URL('../app.js',import.meta.url),'utf8');
  assert.ok(source.includes('capture="environment"'));
});

test('添付は見出しを含めA4の1ページ内に収め、写真を切り取らない', () => {
  const css=readFileSync(new URL('../styles.css',import.meta.url),'utf8');
  assert.match(css, /\.shareAttachmentPage \{[^}]*grid-template-rows: 12mm 8mm minmax\(0, 1fr\)[^}]*height: 270mm[^}]*page-break-inside: avoid !important/);
  assert.match(css, /\.shareAttachmentPage img \{[^}]*height: 100%[^}]*min-height: 0[^}]*object-fit: contain/);
  assert.ok(270 < 297 - 8 * 2);
  assert.match(css, /@media screen \{[^}]*\.slackWorkflow #receiptCard,[^}]*\.slackWorkflow #printButton \{ display: none; \}/);
  assert.match(css, /#receiptCard \{ display: block !important; \}/);
});

test('写真を注文ごとに分離し、枚数超過・削除・終了時にURLを解放する', () => {
  const revoked=[];
  const store=createAttachmentStore(url=>revoked.push(url));
  for(let i=0;i<MAX_PHOTOS;i++) assert.equal(store.add('a',{id:String(i),url:`blob:${i}`}),true);
  assert.equal(store.add('a',{id:'extra',url:'blob:extra'}),false);
  assert.equal(store.list('b').length,0);
  store.add('b',{id:'b',url:'blob:b'});
  store.remove('a','0');
  assert.equal(store.list('a').length,MAX_PHOTOS-1);
  assert.equal(store.list('b').length,1);
  const generation=store.generation;
  store.clear();
  assert.equal(store.list('a').length,0);
  assert.equal(store.list('b').length,0);
  assert.equal(store.add('a',{id:'late',url:'blob:late'},generation),false);
  assert.ok(revoked.includes('blob:late'));
  assert.ok(revoked.includes('blob:b'));
  assert.ok(revoked.includes('blob:extra'));
  assert.equal(new Set(revoked).size,revoked.length);
});
