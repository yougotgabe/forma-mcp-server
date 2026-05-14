// Lightweight Supabase-js style adapter for Worker modules that were designed
// around supabase.from(...).select().eq(...).single() chains, while this repo
// currently uses direct Supabase REST fetches.

export function createSupabaseRestAdapter(env, fetcher = fetch) {
  if (!env?.SUPABASE_URL || !env?.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }
  return {
    from(table) {
      return new RestQueryBuilder({ env, fetcher, table });
    }
  };
}

class RestQueryBuilder {
  constructor({ env, fetcher, table }) {
    this.env = env;
    this.fetcher = fetcher;
    this.table = table;
    this.method = 'GET';
    this.body = null;
    this.selectColumns = '*';
    this.filters = [];
    this.orderClause = null;
    this.limitCount = null;
    this.prefer = 'return=representation';
  }

  select(columns = '*') { this.selectColumns = columns || '*'; return this; }
  insert(payload) { this.method = 'POST'; this.body = payload; return this; }
  update(payload) { this.method = 'PATCH'; this.body = payload; return this; }
  delete() { this.method = 'DELETE'; return this; }
  eq(column, value) { this.filters.push(`${encodeURIComponent(column)}=eq.${encodeURIComponent(value)}`); return this; }
  in(column, values = []) { this.filters.push(`${encodeURIComponent(column)}=in.(${values.map(v => encodeURIComponent(v)).join(',')})`); return this; }
  order(column, options = {}) { this.orderClause = `order=${encodeURIComponent(column)}.${options.ascending === true ? 'asc' : 'desc'}`; return this; }
  limit(count) { this.limitCount = count; return this; }

  async single() { const result = await this._execute(); return normalizeSingle(result, false); }
  async maybeSingle() { const result = await this._execute(); return normalizeSingle(result, true); }
  then(resolve, reject) { return this._execute().then(resolve, reject); }

  async _execute() {
    const qs = [];
    if (this.method === 'GET' || this.method === 'POST' || this.method === 'PATCH') qs.push(`select=${encodeURIComponent(this.selectColumns)}`);
    qs.push(...this.filters);
    if (this.orderClause) qs.push(this.orderClause);
    if (this.limitCount !== null) qs.push(`limit=${encodeURIComponent(this.limitCount)}`);
    const url = `${this.env.SUPABASE_URL}/rest/v1/${encodeURIComponent(this.table)}${qs.length ? `?${qs.join('&')}` : ''}`;
    const headers = {
      apikey: this.env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Prefer: this.prefer,
    };
    const init = { method: this.method, headers };
    if (this.body !== null && this.method !== 'GET') init.body = JSON.stringify(this.body);
    const res = await this.fetcher(url, init);
    let data = null;
    let error = null;
    const text = await res.text();
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    if (!res.ok) error = { status: res.status, message: typeof data === 'string' ? data : (data?.message || res.statusText), details: data };
    return { data, error, status: res.status, ok: res.ok };
  }
}

function normalizeSingle(result, maybe) {
  if (result.error) return result;
  const rows = Array.isArray(result.data) ? result.data : (result.data ? [result.data] : []);
  if (!rows.length && maybe) return { ...result, data: null };
  if (!rows.length) return { ...result, data: null, error: { message: 'No rows returned' } };
  return { ...result, data: rows[0] };
}
