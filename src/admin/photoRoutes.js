// Listings and their photos, for the lead board's Listings tab.
import express from 'express';
import { config } from '../config.js';
import { MAX_BYTES, MAX_PHOTOS, addPhoto, listPhotos, loadPhotos, removePhoto, reorderPhotos } from '../photos.js';
import { priceDisplay } from '../money.js';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

export function mountPhotoRoutes(router, { supabase, requireStaff, requireJson }) {
  const propertyOr404 = async (id, response) => {
    const { data, error } = await supabase
      .from(config.propertiesTable)
      .select('property_id,title,location,category,status,price_inr')
      .eq('property_id', id)
      .maybeSingle();
    if (error) throw error;
    if (!data) response.status(404).json({ error: 'not_found' });
    return data;
  };

  router.get('/api/properties', requireStaff(), async (_request, response, next) => {
    try {
      const { data, error } = await supabase
        .from(config.propertiesTable)
        .select('property_id,title,location,category,status,price_inr')
        .limit(1000);
      if (error) throw error;
      const photos = await loadPhotos(supabase, data.map((p) => p.property_id));

      const properties = data
        .map((p) => ({
          id: p.property_id,
          title: p.title,
          location: p.location,
          category: p.category,
          status: p.status,
          price: priceDisplay(p.price_inr),
          photoCount: photos.get(p.property_id)?.length ?? 0,
          cover: photos.get(p.property_id)?.[0]?.url ?? null
        }))
        .sort((a, b) => String(a.title).localeCompare(String(b.title)));
      response.json({ properties });
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/properties/:id/photos', requireStaff(), async (request, response, next) => {
    try {
      const property = await propertyOr404(request.params.id, response);
      if (!property) return;
      const photos = await listPhotos(supabase, property.property_id);
      response.json({
        property: { id: property.property_id, title: property.title, location: property.location, status: property.status },
        photos: photos.map(({ id, url, position }) => ({ id, url, position })),
        max: MAX_PHOTOS
      });
    } catch (error) {
      next(error);
    }
  });

  // One image per request, as the raw file. The server checks the bytes; the header is not trusted.
  router.post(
    '/api/properties/:id/photos',
    requireStaff('admin'),
    express.raw({ type: IMAGE_TYPES, limit: MAX_BYTES + 1024 }),
    async (request, response, next) => {
      try {
        if (!Buffer.isBuffer(request.body) || !request.body.length) {
          return response.status(415).json({ error: 'image_required', message: 'Send one JPEG, PNG or WebP image as the request body.' });
        }
        const property = await propertyOr404(request.params.id, response);
        if (!property) return undefined;
        const photo = await addPhoto(supabase, property.property_id, { buffer: request.body, by: request.staff.email });
        return response.status(201).json({ photo: { id: photo.id, url: photo.url, position: photo.position } });
      } catch (error) {
        return next(error);
      }
    }
  );

  router.delete('/api/properties/:id/photos/:photoId', requireStaff('admin'), async (request, response, next) => {
    try {
      await removePhoto(supabase, request.params.id, Number(request.params.photoId));
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post('/api/properties/:id/photos/order', requireJson, requireStaff('admin'), async (request, response, next) => {
    try {
      const ids = request.body?.ids;
      if (!Array.isArray(ids) || !ids.every(Number.isInteger)) {
        return response.status(400).json({ error: 'invalid_order' });
      }
      await reorderPhotos(supabase, request.params.id, ids);
      return response.json({ ok: true });
    } catch (error) {
      return next(error);
    }
  });
}
