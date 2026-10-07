// Site visit times for each listing: set on the Listings tab, used by the bot when a customer asks to visit.
import { config } from '../config.js';
import { clearAvailability, describeUpcoming, getAvailability, saveAvailability, validateAvailability } from '../visitSlots.js';

export function mountVisitRoutes(router, { supabase, requireStaff, requireJson }) {
  const propertyOr404 = async (id, response) => {
    const { data, error } = await supabase.from(config.propertiesTable).select('property_id,title').eq('property_id', id).maybeSingle();
    if (error) throw error;
    if (!data) response.status(404).json({ error: 'not_found' });
    return data;
  };

  const shape = (availability) => ({
    availability: availability && { mode: availability.mode, rules: availability.rules, note: availability.note },
    preview: availability?.mode === 'open' ? describeUpcoming(availability.rules, { timeZone: config.businessTimeZone }) : []
  });

  router.get('/api/properties/:id/visits', requireStaff(), async (request, response, next) => {
    try {
      if (!(await propertyOr404(request.params.id, response))) return;
      response.json(shape(await getAvailability(supabase, request.params.id)));
    } catch (error) {
      next(error);
    }
  });

  router.put('/api/properties/:id/visits', requireJson, requireStaff('admin'), async (request, response, next) => {
    try {
      const property = await propertyOr404(request.params.id, response);
      if (!property) return;
      if (request.body?.mode === 'unset') {
        await clearAvailability(supabase, property.property_id);
        return response.json(shape(null));
      }
      const checked = validateAvailability(request.body);
      if (checked.error) return response.status(400).json({ error: 'invalid', message: checked.error });
      await saveAvailability(supabase, property.property_id, checked.value, request.staff?.email ?? null);
      response.json(shape(await getAvailability(supabase, property.property_id)));
    } catch (error) {
      next(error);
    }
  });
}
