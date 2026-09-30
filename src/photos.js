// Property photos: files in a Supabase Storage bucket, listed in the property_photos table.
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

export const BUCKET = 'property-photos';
export const MAX_PHOTOS = 10;
export const MAX_BYTES = 5 * 1024 * 1024;

const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

export function photoUrl(path, base = config.supabaseUrl) {
  return `${base}/storage/v1/object/public/${BUCKET}/${path}`;
}

// What the file really is, from its first bytes. The Content-Type header is not trusted.
export function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

function problem(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

const toPhoto = (row) => ({ id: row.id, url: photoUrl(row.path), position: row.position, path: row.path });

// Photos for several properties at once, cover first: Map(propertyId -> [photo]).
export async function loadPhotos(supabase, propertyIds) {
  const ids = [...new Set(propertyIds.filter(Boolean))];
  const byProperty = new Map();
  if (!ids.length) return byProperty;

  const { data, error } = await supabase
    .from('property_photos')
    .select('id,property_id,path,position')
    .in('property_id', ids)
    .order('position', { ascending: true });
  if (error) throw error;

  for (const row of data) {
    if (!byProperty.has(row.property_id)) byProperty.set(row.property_id, []);
    byProperty.get(row.property_id).push(toPhoto(row));
  }
  return byProperty;
}

export async function listPhotos(supabase, propertyId) {
  return (await loadPhotos(supabase, [propertyId])).get(propertyId) ?? [];
}

export async function addPhoto(supabase, propertyId, { buffer, by }) {
  const type = detectImageType(buffer);
  if (!type) throw problem(415, 'Only JPEG, PNG or WebP images can be uploaded.');
  if (buffer.length > MAX_BYTES) throw problem(413, 'That image is larger than 5 MB.');

  const existing = await listPhotos(supabase, propertyId);
  if (existing.length >= MAX_PHOTOS) throw problem(409, `A listing can have at most ${MAX_PHOTOS} photos.`);

  const path = `${propertyId}/${randomUUID()}.${EXTENSIONS[type]}`;
  const { error: uploadError } = await supabase.storage.from(BUCKET).upload(path, buffer, { contentType: type });
  if (uploadError) throw Object.assign(uploadError, { statusCode: 502 });

  const position = existing.length ? Math.max(...existing.map((p) => p.position)) + 1 : 0;
  const { data, error } = await supabase
    .from('property_photos')
    .insert({ property_id: propertyId, path, position, uploaded_by: by ?? null })
    .select('id,path,position')
    .single();
  if (error) {
    await supabase.storage.from(BUCKET).remove([path]); // do not leave an orphan file behind
    throw Object.assign(error, { statusCode: 502 });
  }
  return toPhoto(data);
}

export async function removePhoto(supabase, propertyId, photoId) {
  const { data: row, error } = await supabase
    .from('property_photos')
    .select('id,path')
    .eq('id', photoId)
    .eq('property_id', propertyId)
    .maybeSingle();
  if (error) throw error;
  if (!row) throw problem(404, 'No such photo.');

  const { error: rowError } = await supabase.from('property_photos').delete().eq('id', photoId);
  if (rowError) throw rowError;
  await supabase.storage.from(BUCKET).remove([row.path]);

  // Close the gap so the order stays 0, 1, 2...
  const rest = await listPhotos(supabase, propertyId);
  await reorderPhotos(supabase, propertyId, rest.map((p) => p.id));
}

export async function reorderPhotos(supabase, propertyId, orderedIds) {
  const current = await listPhotos(supabase, propertyId);
  const known = new Set(current.map((p) => p.id));
  if (orderedIds.length !== known.size || !orderedIds.every((id) => known.has(id)) || new Set(orderedIds).size !== known.size) {
    throw problem(400, 'The order must list every photo of this listing exactly once.');
  }
  for (const [position, id] of orderedIds.entries()) {
    const { error } = await supabase.from('property_photos').update({ position }).eq('id', id);
    if (error) throw error;
  }
}
