// Conversation memory: the last messages per Lead, kept in chat_messages.

export const HISTORY_LIMIT = 20;

export async function loadHistory(supabase, customerId, limit = HISTORY_LIMIT) {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('role,content,created_at')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data.reverse().map(({ role, content }) => ({ role, content }));
}

export async function saveMessage(supabase, customerId, role, content, meta = {}) {
  const { error } = await supabase
    .from('chat_messages')
    .insert({ customer_id: customerId, role, content, meta });
  if (error) throw error;
}

export async function clearHistory(supabase, customerId) {
  const { error } = await supabase.from('chat_messages').delete().eq('customer_id', customerId);
  if (error) throw error;
}
