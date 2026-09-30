// Staff sign-in. Supabase Auth checks the password; our `staff` table decides who is allowed in.
// Tokens stay in HttpOnly cookies, so nothing on the page can read them.
import { createClient } from '@supabase/supabase-js';

const ACCESS = 're_access';
const REFRESH = 're_refresh';
const REFRESH_MAX_AGE = 60 * 60 * 24 * 7;

// The part that talks to Supabase Auth. Tests replace it with a stub.
export function createSupabaseAuth({ url, anonKey }) {
  const client = () => createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const toSession = (data) =>
    data?.session && data.user
      ? {
          accessToken: data.session.access_token,
          refreshToken: data.session.refresh_token,
          expiresIn: data.session.expires_in,
          user: { id: data.user.id, email: data.user.email }
        }
      : null;

  return {
    async signIn(email, password) {
      const { data, error } = await client().auth.signInWithPassword({ email, password });
      return error ? null : toSession(data);
    },
    async verify(accessToken) {
      const { data, error } = await client().auth.getUser(accessToken);
      return error || !data.user ? null : { id: data.user.id, email: data.user.email };
    },
    async refresh(refreshToken) {
      const { data, error } = await client().auth.refreshSession({ refresh_token: refreshToken });
      return error ? null : toSession({ session: data.session, user: data.user });
    }
  };
}

export function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim().split(/=(.*)/s))
      .filter(([name]) => name)
      .map(([name, value]) => [name, decodeURIComponent(value ?? '')])
  );
}

function cookie(name, value, maxAge, secure) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/admin',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
    secure ? 'Secure' : null
  ]
    .filter(Boolean)
    .join('; ');
}

export function setSessionCookies(response, session, { secure }) {
  response.append('Set-Cookie', cookie(ACCESS, session.accessToken, session.expiresIn ?? 3600, secure));
  response.append('Set-Cookie', cookie(REFRESH, session.refreshToken, REFRESH_MAX_AGE, secure));
}

export function clearSessionCookies(response, { secure }) {
  response.append('Set-Cookie', cookie(ACCESS, '', 0, secure));
  response.append('Set-Cookie', cookie(REFRESH, '', 0, secure));
}

// Who is asking? Returns { id, email, role } or null. Renews an expired session from the refresh cookie.
export async function staffFromRequest({ request, response, auth, supabase, secure }) {
  const cookies = parseCookies(request.headers.cookie);
  let user = cookies[ACCESS] ? await auth.verify(cookies[ACCESS]) : null;

  if (!user && cookies[REFRESH]) {
    const session = await auth.refresh(cookies[REFRESH]);
    if (session) {
      setSessionCookies(response, session, { secure });
      user = session.user;
    }
  }
  if (!user) return { user: null };

  const { data, error } = await supabase.from('staff').select('role,email').eq('user_id', user.id).maybeSingle();
  if (error) throw error;
  return data ? { user: { id: user.id, email: data.email ?? user.email, role: data.role } } : { user: null, notStaff: true };
}

// A few tries per address is plenty; this stops password guessing.
export function createLoginLimiter({ limit = 10, windowMs = 15 * 60 * 1000, now = Date.now } = {}) {
  const attempts = new Map();
  return {
    blocked(key) {
      const t = now();
      const recent = (attempts.get(key) ?? []).filter((at) => t - at < windowMs);
      attempts.set(key, recent);
      return recent.length >= limit;
    },
    fail(key) {
      attempts.set(key, [...(attempts.get(key) ?? []), now()]);
    },
    clear(key) {
      attempts.delete(key);
    }
  };
}
