// A small in-memory stand-in for the Supabase client, so query logic can be tested offline.
// It supports only what this project uses: select, insert, update, upsert, delete,
// eq, in, limit, order, single and maybeSingle. Table defaults mimic the SQL file.

const DEFAULTS = {
  customer_leads: () => ({
    lead_stage: 'initiated',
    preferred_locations: [],
    property_categories: [],
    must_haves: [],
    deal_breakers: [],
    key_points: [],
    shortlisted_property_ids: [],
    bot_state: {},
    is_test: false
  }),
  lead_events: () => ({ payload: {} }),
  chat_messages: () => ({ meta: {} }),
  audit_log: () => ({ detail: {} }),
  deletion_log: () => ({ removed: {} }),
  knowledge_gaps: () => ({ status: 'open', times: 1, request: {}, is_test: false, entry_id: null }),
  knowledge_entries: () => ({ active: true, served_count: 0, keywords: [] })
};

const IDENTITY_TABLES = new Set(['property_photos', 'knowledge_gaps', 'knowledge_entries', 'audit_log', 'deletion_log']);

let clock = 0;
let nextId = 1;
const stamp = () => new Date(Date.UTC(2026, 0, 1) + clock++ * 1000).toISOString();

export function createFakeSupabase(seed = {}) {
  const tables = structuredClone(seed);

  function from(name) {
    const state = { op: 'select', filters: [], patch: null, rows: null, limit: null, onConflict: null, returning: false, shape: null, orderBy: null, wantCount: false, head: false };

    const api = {
      select(_columns, options) {
        state.returning = true;
        state.wantCount = Boolean(options?.count);
        state.head = Boolean(options?.head);
        return api;
      },
      insert(rows) {
        state.op = 'insert';
        state.rows = [].concat(rows);
        return api;
      },
      update(patch) {
        state.op = 'update';
        state.patch = patch;
        return api;
      },
      upsert(rows, options) {
        state.op = 'upsert';
        state.rows = [].concat(rows);
        state.onConflict = options?.onConflict;
        return api;
      },
      delete() {
        state.op = 'delete';
        return api;
      },
      eq(column, value) {
        state.filters.push((row) => row[column] === value);
        return api;
      },
      lt(column, value) {
        state.filters.push((row) => row[column] !== undefined && row[column] !== null && row[column] < value);
        return api;
      },
      gt(column, value) {
        state.filters.push((row) => row[column] !== undefined && row[column] !== null && row[column] > value);
        return api;
      },
      in(column, values) {
        state.filters.push((row) => values.includes(row[column]));
        return api;
      },
      limit(n) {
        state.limit = n;
        return api;
      },
      order(column, options) {
        state.orderBy = { column, ascending: options?.ascending !== false };
        return api;
      },
      single() {
        state.shape = 'single';
        return api;
      },
      maybeSingle() {
        state.shape = 'maybe';
        return api;
      },
      then(resolve, reject) {
        return Promise.resolve(run()).then(resolve, reject);
      }
    };

    function run() {
      const table = (tables[name] ??= []);
      const matching = () => table.filter((row) => state.filters.every((f) => f(row)));
      let affected = [];

      if (state.op === 'select') {
        affected = matching();
      } else if (state.op === 'insert') {
        for (const row of state.rows) {
          const full = { ...(DEFAULTS[name]?.() ?? {}), created_at: stamp(), ...(IDENTITY_TABLES.has(name) ? { id: nextId++ } : {}), ...structuredClone(row) };
          table.push(full);
          affected.push(full);
        }
      } else if (state.op === 'update') {
        affected = matching();
        for (const row of affected) Object.assign(row, structuredClone(state.patch));
      } else if (state.op === 'upsert') {
        for (const row of state.rows) {
          const key = state.onConflict;
          const existing = key ? table.find((r) => r[key] === row[key]) : null;
          if (existing) {
            Object.assign(existing, structuredClone(row));
            affected.push(existing);
          } else {
            const full = { ...(DEFAULTS[name]?.() ?? {}), ...structuredClone(row) };
            table.push(full);
            affected.push(full);
          }
        }
      } else if (state.op === 'delete') {
        affected = matching();
        tables[name] = table.filter((row) => !affected.includes(row));
        // Deleting a lead removes what hangs off it, as the foreign keys with "on delete cascade" do.
        if (name === 'customer_leads') {
          const gone = new Set(affected.map((r) => r.customer_id));
          for (const child of ['chat_messages', 'lead_events']) {
            if (tables[child]) tables[child] = tables[child].filter((r) => !gone.has(r.customer_id));
          }
        }
      }

      if (state.orderBy) {
        const { column, ascending } = state.orderBy;
        affected = [...affected].sort((a, b) => (a[column] > b[column] ? 1 : a[column] < b[column] ? -1 : 0));
        if (!ascending) affected.reverse();
      }
      const total = affected.length;
      if (state.limit !== null) affected = affected.slice(0, state.limit);

      const wantsRows = state.op === 'select' || state.returning;
      const data = wantsRows && !state.head ? structuredClone(affected) : null;
      const count = state.wantCount ? total : null;

      if (state.shape === 'single') {
        return data?.length === 1
          ? { data: data[0], error: null }
          : { data: null, error: { message: `expected one row, got ${data?.length ?? 0}` } };
      }
      if (state.shape === 'maybe') return { data: data?.[0] ?? null, error: null };
      return { data, error: null, count };
    }

    return api;
  }

  // A minimal stand-in for Storage: files are kept in memory.
  const files = new Map();
  const storage = {
    from: (bucket) => ({
      upload: async (path, body, options) => {
        if (files.has(`${bucket}/${path}`) && !options?.upsert) return { data: null, error: { message: 'The resource already exists' } };
        files.set(`${bucket}/${path}`, { body, contentType: options?.contentType });
        return { data: { path }, error: null };
      },
      remove: async (paths) => {
        for (const path of paths) files.delete(`${bucket}/${path}`);
        return { data: paths.map((name) => ({ name })), error: null };
      }
    })
  };

  return { from, tables, storage, files };
}
