import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttachmentStore, validatePhoto, MAX_PHOTO_BYTES, MAX_PHOTOS, PHOTO_BUCKET, photoPath, uploadOrderPhoto, downloadOrderPhotos, deleteOrderPhoto } from '../order-attachments.js';
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

test('添付写真は注文のクラウドpayloadへ含めず、非公開Storageで注文ごとに扱う', () => {
  const payload=payloadForOrder({type:'spot',attachments:[{url:'blob:private-photo'}]});
  assert.ok(!JSON.stringify(payload).includes('private-photo'));
  const css=readFileSync(new URL('../styles.css',import.meta.url),'utf8');
  assert.ok(css.includes('.shareAttachmentPages { display: none; }'));
  assert.ok(css.includes('body[data-print-copy="sharing"] .shareAttachmentPages { display: block !important; }'));
  assert.ok(!css.includes('.receiptCopy[data-copy="customer"] { display: none'));
  const source=readFileSync(new URL('../app.js',import.meta.url),'utf8');
  assert.ok(source.includes('capture="environment"'));
  assert.ok(source.includes('uploadOrderPhoto'));
  assert.ok(source.includes('downloadOrderPhotos'));
});

test('写真の保存・復元・削除は注文専用のStorageパスを使う', async () => {
  const orderId = '11111111-1111-4111-8111-111111111111';
  const photoId = '22222222-2222-4222-8222-222222222222';
  const path = photoPath(orderId, photoId, 1727660000000);
  assert.equal(path, `${orderId}/1727660000000-${photoId}.jpg`);
  const calls = [];
  const bucket = {
    upload: async (...args) => { calls.push(['upload', ...args]); return { error: null }; },
    list: async (...args) => { calls.push(['list', ...args]); return { data: [{ name: `1727660000000-${photoId}.jpg` }], error: null }; },
    download: async (...args) => { calls.push(['download', ...args]); return { data: new Blob(['photo']), error: null }; },
    remove: async (...args) => { calls.push(['remove', ...args]); return { error: null }; },
  };
  const storage = { from: name => { assert.equal(name, PHOTO_BUCKET); return bucket; } };
  const uploaded = await uploadOrderPhoto(storage, orderId, { id: photoId, blob: new Blob(['photo']) });
  assert.ok(uploaded.startsWith(`${orderId}/`));
  const photos = await downloadOrderPhotos(storage, orderId, () => 'blob:restored');
  assert.equal(photos.length, 1);
  assert.equal(photos[0].path, path);
  assert.equal(photos[0].url, 'blob:restored');
  await deleteOrderPhoto(storage, photos[0]);
  assert.deepEqual(calls.map(call => call[0]), ['upload', 'list', 'download', 'remove']);
  const migration = readFileSync(new URL('../supabase/migrations/20260930000949_private_simple_order_photos.sql', import.meta.url), 'utf8');
  assert.ok(migration.includes("false, 10485760, array['image/jpeg']"));
  assert.ok(migration.includes("o.event_name = 'exhibition-order-simple'"));
});

test('添付は見出しを含めA4の1ページ内に収め、写真を切り取らない', () => {
  const css=readFileSync(new URL('../styles.css',import.meta.url),'utf8');
  const pageRule=css.match(/\.shareAttachmentPage \{([^}]+)\}/)[1];
  const imageRule=css.match(/\.shareAttachmentPage img \{([^}]+)\}/)[1];
  assert.match(pageRule, /display: block !important/);
  assert.match(pageRule, /position: relative !important/);
  assert.match(pageRule, /height: 200mm !important/);
  assert.match(pageRule, /overflow: hidden !important/);
  assert.match(pageRule, /page-break-inside: avoid !important/);
  assert.match(pageRule, /page-break-after: auto !important/);
  assert.match(imageRule, /position: absolute !important/);
  assert.match(imageRule, /top: 20mm !important/);
  assert.match(imageRule, /height: 180mm !important/);
  assert.match(imageRule, /object-fit: contain !important/);
  assert.ok(!pageRule.includes('grid'));
  assert.ok(!imageRule.includes('height: 100%'));
  assert.equal(20 + 180,200);
  assert.ok(200 < 297 - 8 * 2);
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
  store.replace('b',[{id:'fresh',url:'blob:fresh'}]);
  assert.ok(revoked.includes('blob:b'));
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
