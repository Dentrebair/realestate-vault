// Lets an existing Supabase Auth account use the lead board.
//
//   node scripts/add-staff.js someone@company.com admin      can move leads between stages
//   node scripts/add-staff.js someone@company.com viewer     can only look
//
// Create the account first in the Supabase dashboard (Authentication, Users, Add user, Create new user,
// tick "Auto Confirm User"). The password never passes through this script.
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const [emailArg, role = 'viewer'] = process.argv.slice(2);
if (!emailArg || !['admin', 'viewer'].includes(role)) {
  console.error('Usage: node scripts/add-staff.js <email> [admin|viewer]');
  process.exit(1);
}
const email = emailArg.trim().toLowerCase();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

async function findUser() {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const match = data.users.find((u) => u.email?.toLowerCase() === email);
    if (match) return match;
    if (data.users.length < 200) return null;
  }
  return null;
}

const user = await findUser();
if (!user) {
  console.error(`No Supabase Auth account for ${email}. Create it in the dashboard first (Authentication, Users, Add user).`);
  process.exit(1);
}

const { error } = await supabase.from('staff').upsert({ user_id: user.id, email, role }, { onConflict: 'user_id' });
if (error) {
  console.error(`Could not save: ${error.message}`);
  if (/staff/.test(error.message)) console.error('Run sql/002_admin.sql in the Supabase SQL editor first.');
  process.exit(1);
}
console.log(`${email} can now sign in to the lead board as ${role}.`);
