// Who on the staff looked at a customer's private details. Opening the same lead again within the window is one entry.
const WINDOW_MS = 30 * 60 * 1000;

export async function recordAccess(supabase, { staffEmail, customerId, phone, conversation, now = Date.now() }) {
  if (!phone && !conversation) return;
  const since = new Date(now - WINDOW_MS).toISOString();

  const { data: recent, error } = await supabase
    .from('audit_log')
    .select('id')
    .eq('staff_email', staffEmail)
    .eq('customer_id', customerId)
    .eq('action', 'view_lead')
    .gt('created_at', since)
    .limit(1);
  if (error) throw error;
  if (recent.length) return;

  const { error: insertError } = await supabase
    .from('audit_log')
    .insert({ staff_email: staffEmail, action: 'view_lead', customer_id: customerId, created_at: new Date(now).toISOString(), detail: { phone: Boolean(phone), conversation: Boolean(conversation) } });
  if (insertError) throw insertError;
}

export async function listAccess(supabase, { limit = 200 } = {}) {
  const { data, error } = await supabase.from('audit_log').select('*').order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data.map((r) => ({
    id: r.id, staff: r.staff_email, action: r.action, customerId: r.customer_id,
    sawPhone: r.detail?.phone === true, sawConversation: r.detail?.conversation === true, at: r.created_at
  }));
}
