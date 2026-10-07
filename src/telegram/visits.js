// A customer asks to visit a property once. After the team has been told, the same property is never offered again.
export async function visitAlreadyAsked(supabase, customerId, propertyId) {
  const { data, error } = await supabase
    .from('lead_events')
    .select('id,alerted_at')
    .eq('customer_id', customerId)
    .eq('event_type', 'site_visit_requested')
    .eq('property_id', propertyId)
    .limit(5);
  if (error) return false;
  return data.some((e) => e.alerted_at);
}
