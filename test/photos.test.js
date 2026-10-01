import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_PHOTOS, addPhoto, detectImageType, listPhotos, loadPhotos, photoUrl, removePhoto, reorderPhotos } from '../src/photos.js';
import { createFakeSupabase } from './helpers/fakeSupabase.js';

const jpeg = (size = 100) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size)]);
const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
const webp = () => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(20)]);

test('the file type comes from its bytes, not from what the upload claims', () => {
  assert.equal(detectImageType(jpeg()), 'image/jpeg');
  assert.equal(detectImageType(png()), 'image/png');
  assert.equal(detectImageType(webp()), 'image/webp');
  assert.equal(detectImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')), null);
  assert.equal(detectImageType(Buffer.from('%PDF-1.7 not an image at all')), null);
  assert.equal(detectImageType(Buffer.alloc(3)), null);
  assert.equal(detectImageType('a string'), null);
});

test('photos are added in order, stored in the bucket, and listed cover first', async () => {
  const db = createFakeSupabase();
  const a = await addPhoto(db, 'p1', { buffer: jpeg(), by: 'admin@x.com' });
  const b = await addPhoto(db, 'p1', { buffer: png() });
  assert.deepEqual([a.position, b.position], [0, 1]);
  assert.match(a.path, /^p1\/.+\.jpg$/);
  assert.match(b.path, /^p1\/.+\.png$/);
  assert.equal(db.files.size, 2);
  assert.equal(db.tables.property_photos[0].uploaded_by, 'admin@x.com');

  const listed = await listPhotos(db, 'p1');
  assert.deepEqual(listed.map((p) => p.id), [a.id, b.id]);
  assert.ok(listed[0].url.endsWith(`/storage/v1/object/public/property-photos/${a.path}`));
  assert.equal(photoUrl('x/y.jpg', 'https://h.supabase.co'), 'https://h.supabase.co/storage/v1/object/public/property-photos/x/y.jpg');
});

test('loadPhotos groups several properties in one query', async () => {
  const db = createFakeSupabase();
  await addPhoto(db, 'p1', { buffer: jpeg() });
  await addPhoto(db, 'p2', { buffer: jpeg() });
  await addPhoto(db, 'p1', { buffer: jpeg() });
  const map = await loadPhotos(db, ['p1', 'p2', 'p3', null]);
  assert.equal(map.get('p1').length, 2);
  assert.equal(map.get('p2').length, 1);
  assert.equal(map.has('p3'), false);
  assert.equal((await loadPhotos(db, [])).size, 0);
});

test('things that are not small images are refused, and nothing is stored', async () => {
  const db = createFakeSupabase();
  await assert.rejects(addPhoto(db, 'p1', { buffer: Buffer.from('<svg></svg> not an image here') }), (e) => e.statusCode === 415);
  await assert.rejects(addPhoto(db, 'p1', { buffer: jpeg(5 * 1024 * 1024 + 1) }), (e) => e.statusCode === 413);
  assert.equal(db.files.size, 0);
  assert.equal((db.tables.property_photos ?? []).length, 0);
});

test('a listing holds at most ten photos', async () => {
  const db = createFakeSupabase();
  for (let i = 0; i < MAX_PHOTOS; i++) await addPhoto(db, 'p1', { buffer: jpeg() });
  await assert.rejects(addPhoto(db, 'p1', { buffer: jpeg() }), (e) => e.statusCode === 409);
  assert.equal(db.files.size, MAX_PHOTOS);
});

test('removing a photo deletes the file, closes the gap, and only touches its own listing', async () => {
  const db = createFakeSupabase();
  const a = await addPhoto(db, 'p1', { buffer: jpeg() });
  const b = await addPhoto(db, 'p1', { buffer: jpeg() });
  const c = await addPhoto(db, 'p1', { buffer: jpeg() });
  const other = await addPhoto(db, 'p2', { buffer: jpeg() });

  await assert.rejects(removePhoto(db, 'p1', other.id), (e) => e.statusCode === 404);
  await removePhoto(db, 'p1', b.id);

  const left = await listPhotos(db, 'p1');
  assert.deepEqual(left.map((p) => [p.id, p.position]), [[a.id, 0], [c.id, 1]]);
  assert.equal(db.files.size, 3);
  assert.equal((await listPhotos(db, 'p2')).length, 1);
});

test('photos can be reordered, but only by listing every one exactly once', async () => {
  const db = createFakeSupabase();
  const a = await addPhoto(db, 'p1', { buffer: jpeg() });
  const b = await addPhoto(db, 'p1', { buffer: jpeg() });
  const c = await addPhoto(db, 'p1', { buffer: jpeg() });

  await reorderPhotos(db, 'p1', [c.id, a.id, b.id]);
  assert.deepEqual((await listPhotos(db, 'p1')).map((p) => p.id), [c.id, a.id, b.id]);

  for (const bad of [[a.id, b.id], [a.id, a.id, b.id], [a.id, b.id, c.id, 999], [a.id, b.id, 999]]) {
    await assert.rejects(reorderPhotos(db, 'p1', bad), (e) => e.statusCode === 400);
  }
});
