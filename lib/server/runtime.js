import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { google } from 'googleapis';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { simpleParser } from 'mailparser';

const MODULE_INSTANCE_ID =
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');

class HttpError extends Error {
  constructor(status, message, options = {}) {
    super(message);
    this.status = status;
    this.code = options.code || null;
    this.details = options.details || null;
  }
}

function supabaseErrorToHttpError(action, table, error, fallbackMessage = 'Supabase operation failed') {
  const rawMessage = String(error?.message || fallbackMessage);
  const normalizedMessage = rawMessage.toLowerCase();
  const status = Number(error?.code || error?.status || error?.response?.status || 0);
  const schemaCacheError = normalizedMessage.includes('schema cache');
  const missingColumn = normalizedMessage.includes('could not find') && normalizedMessage.includes('column');
  const unavailable = [502, 503, 504].includes(status) ||
    normalizedMessage.includes('bad gateway') ||
    normalizedMessage.includes('service unavailable') ||
    normalizedMessage.includes('gateway timeout');
  const code = schemaCacheError || missingColumn ? 'SUPABASE_SCHEMA_CACHE_MISMATCH' : 'SUPABASE_ERROR';
  const resolvedCode = unavailable ? 'SUPABASE_UNAVAILABLE' : code;
  const message = resolvedCode === 'SUPABASE_SCHEMA_CACHE_MISMATCH'
    ? `Skema Supabase belum sinkron untuk tabel ${table}: ${rawMessage}. Jalankan migrasi terbaru lalu reload schema cache.`
    : resolvedCode === 'SUPABASE_UNAVAILABLE'
      ? `Supabase sementara tidak dapat dihubungi saat ${action} tabel ${table}. Coba lagi dalam beberapa detik.`
    : `${fallbackMessage}: ${rawMessage}`;

  return new HttpError(unavailable ? 503 : 500, message, {
    code: resolvedCode,
    details: {
      action,
      table,
      supabaseCode: error?.code || null,
      hint: error?.hint || null,
      details: error?.details || null,
      ...(unavailable ? { retryAfterSeconds: 15 } : {})
    }
  });
}

function isTransientSupabaseError(error) {
  const status = Number(error?.code || error?.status || error?.response?.status || 0);
  const message = String(error?.message || '').toLowerCase();
  return [502, 503, 504].includes(status) ||
    message.includes('bad gateway') ||
    message.includes('service unavailable') ||
    message.includes('gateway timeout');
}

const LOG_LEVELS = { info: 0, warn: 1, error: 2 };
const CURRENT_LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.info;

function log(level, message, meta = {}) {
  if (LOG_LEVELS[level] >= CURRENT_LOG_LEVEL) {
    console.log(
      JSON.stringify({ level, message, ...meta, timestamp: new Date().toISOString() })
    );
  }
}

// ========== ENV VALIDATION ==========
const envSchema = z.object({
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().optional(),
  ADMIN_API_KEY: z.string().optional(),
  ADMIN_EMAILS: z.string().optional(),
  ALLOWED_ORIGINS: z.string().optional(),
  MAX_MESSAGES: z.string().optional(),
  MAX_LOGS: z.string().optional(),
  TOKEN_ENCRYPTION_KEY: z.string().optional(),
  TOKEN_PATH: z.string().optional(),
  DATA_DIR: z.string().optional(),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_KV_TABLE: z.string().optional(),
  SUPABASE_TABLE_ALIASES: z.string().optional(),
  SUPABASE_TABLE_DOMAINS: z.string().optional(),
  SUPABASE_TABLE_LOGS: z.string().optional(),
  SUPABASE_TABLE_MESSAGES: z.string().optional(),
  SUPABASE_TABLE_AUDIT: z.string().optional(),
  ACCESS_SESSION_SECRET: z.string().optional()
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(
      `Missing required environment variables: ${parsed.error.issues
        .map((i) => i.path.join('.'))
        .join(', ')}`
    );
  }
  return parsed.data;
}

const env = loadEnv();
const ROOT_DIR = process.cwd();
const fsPromises = fs.promises;

const DEFAULT_DATA_DIR = path.join(ROOT_DIR, 'data');
const LEGACY_DATA_DIR = path.join(ROOT_DIR, 'gmail-backend', 'data');
const DATA_DIR = env.DATA_DIR || (fs.existsSync(DEFAULT_DATA_DIR) ? DEFAULT_DATA_DIR : LEGACY_DATA_DIR);

const DEFAULT_TOKEN_PATH = path.join(ROOT_DIR, 'token.json');
const LEGACY_TOKEN_PATH = path.join(ROOT_DIR, 'gmail-backend', 'token.json');
// Prefer new location, fallback to legacy hanya jika ada dan default belum ada
const TOKEN_PATH = env.TOKEN_PATH || DEFAULT_TOKEN_PATH;
const ALIASES_PATH = path.join(DATA_DIR, 'aliases.json');
const DOMAINS_PATH = path.join(DATA_DIR, 'domains.json');
const LOGS_PATH = path.join(DATA_DIR, 'logs.json');
const AUDIT_PATH = path.join(DATA_DIR, 'audit.json');

const ALLOWED_ORIGINS = (env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',')
  .map((v) => v.trim())
  .filter(Boolean);
const MAX_MESSAGES = Math.min(parseInt(env.MAX_MESSAGES || '20', 10) || 20, 50);
const MAX_LOGS = Math.min(parseInt(env.MAX_LOGS || '5000', 10) || 5000, 20000);
const TOKEN_ENCRYPTION_KEY = env.TOKEN_ENCRYPTION_KEY || null;
const ACCESS_SESSION_SECRET = env.ACCESS_SESSION_SECRET || null;
const ACCESS_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const ACCESS_COOKIE_NAME = 'alias_access';
const GMAIL_LIST_CACHE_TTL_MS = 15 * 1000;
const GMAIL_METADATA_CONCURRENCY = 3;
const SUPABASE_PAGE_SIZE = 1000;
const ADMIN_EMAILS = (env.ADMIN_EMAILS || '')
  .split(',')
  .map((v) => v.trim().toLowerCase())
  .filter(Boolean);

const SUPABASE_URL = env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_KV_TABLE = env.SUPABASE_KV_TABLE || 'app_kv';
const SUPABASE_TABLE_ALIASES = env.SUPABASE_TABLE_ALIASES || 'app_aliases';
const SUPABASE_TABLE_ALIAS_TOKENS = 'app_alias_tokens';
const SUPABASE_TABLE_DOMAINS = env.SUPABASE_TABLE_DOMAINS || 'app_domains';
const SUPABASE_TABLE_LOGS = env.SUPABASE_TABLE_LOGS || 'app_logs';
const SUPABASE_TABLE_MESSAGES = env.SUPABASE_TABLE_MESSAGES || 'app_messages';
const SUPABASE_TABLE_AUDIT = env.SUPABASE_TABLE_AUDIT || 'app_audit';
const USE_SUPABASE_STORAGE = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

if (!USE_SUPABASE_STORAGE) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let supabaseAdmin = null;
function getSupabaseAdmin() {
  if (!USE_SUPABASE_STORAGE) return null;
  if (supabaseAdmin) return supabaseAdmin;
  const noStoreFetch = (input, init = {}) => {
    return fetch(input, {
      ...init,
      // Important: don't set both `cache` and `next.revalidate` (Next.js warns).
      // Supabase admin reads should always bypass caching.
      cache: 'no-store'
    });
  };
  supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
    global: { fetch: noStoreFetch }
  });
  return supabaseAdmin;
}

const STORAGE_KEYS = {
  [TOKEN_PATH]: 'token',
  [ALIASES_PATH]: 'aliases',
  [DOMAINS_PATH]: 'domains',
  [LOGS_PATH]: 'logs',
  [AUDIT_PATH]: 'audit'
};

function getStorageKey(file) {
  return STORAGE_KEYS[file] || path.basename(file);
}

async function supabaseGet(key) {
  const client = getSupabaseAdmin();
  if (!client) return null;
  const { data, error } = await client
    .from(SUPABASE_KV_TABLE)
    .select('value')
    .eq('key', key)
    .maybeSingle();
  if (error) {
    log('error', 'Supabase get failed', { key, error: error.message });
    return null;
  }
  return data?.value ?? null;
}

async function supabaseSet(key, value) {
  const client = getSupabaseAdmin();
  if (!client) return;
  const { error } = await client
    .from(SUPABASE_KV_TABLE)
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) {
    log('error', 'Supabase set failed', { key, error: error.message });
    throw supabaseErrorToHttpError('upsert', SUPABASE_KV_TABLE, error, 'Gagal menyimpan data Supabase');
  }
}

async function supabaseSelectAll(table, orderBy = null) {
  const client = getSupabaseAdmin();
  if (!client) return null;
  const selectPage = async (from, to) => {
    let query = client.from(table).select('*');
    if (orderBy) query = query.order(orderBy, { ascending: true });
    return query.range(from, to);
  };
  const rows = [];
  let from = 0;

  while (true) {
    let { data, error } = await selectPage(from, from + SUPABASE_PAGE_SIZE - 1);
    if (error && isTransientSupabaseError(error)) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      ({ data, error } = await selectPage(from, from + SUPABASE_PAGE_SIZE - 1));
    }
    if (error) {
      log('error', 'Supabase select failed', { table, error: error.message, from });
      throw supabaseErrorToHttpError('select', table, error, 'Gagal membaca data Supabase');
    }

    const page = data || [];
    rows.push(...page);
    if (page.length < SUPABASE_PAGE_SIZE) break;
    from += SUPABASE_PAGE_SIZE;
  }
  return rows;
}

async function supabaseReplaceAll(table, rows, pkField) {
  const client = getSupabaseAdmin();
  if (!client) return;
  if (!rows.length) return;
  // Use upsert instead of delete-all + insert to prevent data loss from race conditions
  const { error } = await client.from(table).upsert(rows, { onConflict: pkField });
  if (error) {
    log('error', 'Supabase upsert failed', { table, error: error.message });
    throw supabaseErrorToHttpError('upsert', table, error, 'Gagal menyimpan data Supabase');
  }
}

async function supabaseInsert(table, row) {
  const client = getSupabaseAdmin();
  if (!client) return;
  const { error } = await client.from(table).insert(row);
  if (error) {
    log('error', 'Supabase insert failed', { table, error: error.message });
    throw supabaseErrorToHttpError('insert', table, error, 'Gagal menambah data Supabase');
  }
}

async function supabaseTrimByIdentity(table, orderColumn, limit) {
  const client = getSupabaseAdmin();
  if (!client) return;
  const { data, error } = await client
    .from(table)
    .select('id')
    .order(orderColumn, { ascending: false })
    .range(limit, limit + 1000);
  if (error || !data || !data.length) return;
  const ids = data.map((row) => row.id);
  await client.from(table).delete().in('id', ids);
}

async function supabaseTrimAudit(limit) {
  await supabaseTrimByIdentity(SUPABASE_TABLE_AUDIT, 'timestamp', limit);
}

async function fileExists(file) {
  try {
    await fsPromises.access(file);
    return true;
  } catch {
    return false;
  }
}

// ========== FILE HELPERS ==========
function encryptToken(text) {
  if (!TOKEN_ENCRYPTION_KEY) return text;
  const key = Buffer.from(TOKEN_ENCRYPTION_KEY, 'hex');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `${iv.toString('hex')}:${encrypted}`;
}

function decryptToken(text) {
  if (!TOKEN_ENCRYPTION_KEY) return text;
  const parts = text.split(':');
  if (parts.length !== 2) throw new Error('Invalid encrypted token format');
  const key = Buffer.from(TOKEN_ENCRYPTION_KEY, 'hex');
  const iv = Buffer.from(parts[0], 'hex');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  let decrypted = decipher.update(parts[1], 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

async function loadJson(file, fallback) {
  if (USE_SUPABASE_STORAGE) {
    const key = getStorageKey(file);
    const value = await supabaseGet(key);
    if (value == null) return fallback;
    if (file === TOKEN_PATH) {
      if (typeof value === 'string') {
        const content = TOKEN_ENCRYPTION_KEY ? decryptToken(value) : value;
        return JSON.parse(content);
      }
      return value;
    }
    return value;
  }

  if (!(await fileExists(file))) return fallback;
  try {
    const raw = await fsPromises.readFile(file, 'utf8');
    const content = file === TOKEN_PATH ? decryptToken(raw) : raw;
    return JSON.parse(content);
  } catch (e) {
    log('error', `Failed to parse ${file}`, { error: e.message });
    return fallback;
  }
}

async function saveJson(file, data) {
  if (USE_SUPABASE_STORAGE) {
    const key = getStorageKey(file);
    if (file === TOKEN_PATH) {
      const raw = JSON.stringify(data, null, 2);
      const content = TOKEN_ENCRYPTION_KEY ? encryptToken(raw) : raw;
      await supabaseSet(key, content);
      return;
    }
    await supabaseSet(key, data);
    return;
  }

  const raw = JSON.stringify(data, null, 2);
  const content = file === TOKEN_PATH ? encryptToken(raw) : raw;
  await fsPromises.writeFile(file, content);
}

async function loadAliases() {
  if (USE_SUPABASE_STORAGE) {
    const data = await supabaseSelectAll(SUPABASE_TABLE_ALIASES, 'created_at');
    if (!data) return [];
    return data.map((row) => ({
      address: row.address,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      hits: row.hits || 0,
      active: row.active,
      tokens: []
    }));
  }
  const data = await loadJson(ALIASES_PATH, []);
  return data.map((item) => ({
    address: item.address,
    createdAt: item.createdAt || null,
    lastUsedAt: item.lastUsedAt || null,
    hits: item.hits || 0,
    active: typeof item.active === 'boolean' ? item.active : true,
    tokens: Array.isArray(item.tokens) ? item.tokens : []
  }));
}

async function saveAliases(list) {
  if (USE_SUPABASE_STORAGE) {
    const client = getSupabaseAdmin();
    if (!client) return;
    const rows = list.map((item) => ({
      address: item.address,
      created_at: item.createdAt || null,
      last_used_at: item.lastUsedAt || null,
      hits: item.hits || 0,
      active: typeof item.active === 'boolean' ? item.active : true
    }));
    if (rows.length) {
      const { error } = await client
        .from(SUPABASE_TABLE_ALIASES)
        .upsert(rows, { onConflict: 'address' });
      if (error) {
        log('error', 'Supabase aliases upsert failed', { error: error.message });
      }
    }
    return;
  }
  await saveJson(ALIASES_PATH, list.map((item) => ({
    address: item.address,
    createdAt: item.createdAt || null,
    lastUsedAt: item.lastUsedAt || null,
    hits: item.hits || 0,
    active: typeof item.active === 'boolean' ? item.active : true,
    tokens: Array.isArray(item.tokens) ? item.tokens : []
  })));
}

async function loadDomains() {
  if (USE_SUPABASE_STORAGE) {
    const data = await supabaseSelectAll(SUPABASE_TABLE_DOMAINS, 'created_at');
    if (data && data.length) {
      return data.map((row) => ({
        name: String(row.name || '').trim().toLowerCase(),
        active: typeof row.active === 'boolean' ? row.active : true,
        createdAt: row.created_at
      }));
    }
    return [];
  }
  const domains = await loadJson(DOMAINS_PATH, []);
  if (domains.length) {
    return domains.map((row) => ({
      name: String(row.name || '').trim().toLowerCase(),
      active: typeof row.active === 'boolean' ? row.active : true,
      createdAt: row.createdAt || null
    }));
  }
  return [];
}

async function saveDomains(list) {
  if (USE_SUPABASE_STORAGE) {
    const rows = list.map((item) => ({
      name: String(item.name || '').trim().toLowerCase(),
      active: typeof item.active === 'boolean' ? item.active : true,
      created_at: item.createdAt || null
    }));
    await supabaseReplaceAll(SUPABASE_TABLE_DOMAINS, rows, 'name');
    return;
  }
  const normalized = list.map((item) => ({
    name: String(item.name || '').trim().toLowerCase(),
    active: typeof item.active === 'boolean' ? item.active : true,
    createdAt: item.createdAt || null
  }));
  await saveJson(DOMAINS_PATH, normalized);
}

async function loadLogs() {
  if (USE_SUPABASE_STORAGE) {
    const data = await supabaseSelectAll(SUPABASE_TABLE_LOGS, 'last_seen_at');
    if (!data) return [];
    return data.map((row) => ({
      id: row.id,
      alias: row.alias,
      from: row.from ?? row.from_email ?? '',
      subject: row.subject,
      date: row.date,
      snippet: row.snippet,
      lastSeenAt: row.last_seen_at
    }));
  }
  return loadJson(LOGS_PATH, []);
}

async function saveLogs(list) {
  if (USE_SUPABASE_STORAGE) {
    const rows = list.map((item) => ({
      id: item.id,
      alias: item.alias || null,
      from_email: item.from || null,
      subject: item.subject || '',
      date: item.date || '',
      snippet: item.snippet || '',
      last_seen_at: item.lastSeenAt || null
    }));
    await supabaseReplaceAll(SUPABASE_TABLE_LOGS, rows, 'id');
    return;
  }
  await saveJson(LOGS_PATH, list);
}

async function loadAudit() {
  if (USE_SUPABASE_STORAGE) {
    const data = await supabaseSelectAll(SUPABASE_TABLE_AUDIT, 'timestamp');
    if (!data) return [];
    return data.map((row) => ({
      timestamp: row.timestamp,
      action: row.action,
      ip: row.ip || null,
      userAgent: row.user_agent || null,
      ...(row.meta || {})
    }));
  }
  return loadJson(AUDIT_PATH, []);
}

async function saveAudit(list) {
  if (USE_SUPABASE_STORAGE) {
    const rows = list.map((item) => ({
      timestamp: item.timestamp || new Date().toISOString(),
      action: item.action || 'unknown',
      ip: item.ip || null,
      user_agent: item.userAgent || null,
      meta: item
    }));
    await supabaseReplaceAll(SUPABASE_TABLE_AUDIT, rows, 'timestamp');
    return;
  }
  await saveJson(AUDIT_PATH, list);
}

// ========== VALIDATION ==========
const emailSchema = z
  .string()
  .email()
  .max(254)
  .refine((email) => {
    const [local, domain] = email.split('@');
    return local && local.length <= 64 && domain && domain.length <= 190;
  });

const domainSchema = z
  .string()
  .regex(/^[a-zA-Z0-9.-]+\.[A-Za-z]{2,}$/)
  .max(190);

function isValidEmail(address) {
  if (!address || typeof address !== 'string') return false;
  const trimmed = address.trim().toLowerCase();
  return emailSchema.safeParse(trimmed).success;
}

function hashAccessToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function constantTimeEqualHex(hexA, hexB) {
  if (typeof hexA !== 'string' || typeof hexB !== 'string') return false;
  if (hexA.length !== hexB.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(hexA, 'hex'), Buffer.from(hexB, 'hex'));
  } catch {
    return false;
  }
}

function generateAccessToken() {
  return crypto.randomBytes(32).toString('base64url');
}

const ACCESS_TOKEN_CIPHER_VERSION = 1;

function getAccessTokenEncryptionKey() {
  return crypto.hkdfSync(
    'sha256',
    Buffer.from(requireAccessSessionSecret(), 'utf8'),
    Buffer.from('tmail-pbs-access-token-salt', 'utf8'),
    Buffer.from('app_alias_tokens.token_ciphertext.v1', 'utf8'),
    32
  );
}

function encryptAccessToken(token) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getAccessTokenEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(token), 'utf8'), cipher.final()]);
  return `v${ACCESS_TOKEN_CIPHER_VERSION}:${iv.toString('base64url')}:${cipher.getAuthTag().toString('base64url')}:${ciphertext.toString('base64url')}`;
}

function decryptAccessToken(value) {
  const [version, iv, tag, ciphertext, extra] = String(value || '').split(':');
  if (version !== `v${ACCESS_TOKEN_CIPHER_VERSION}` || !iv || !tag || !ciphertext || extra) {
    throw new Error('Unsupported access token ciphertext');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getAccessTokenEncryptionKey(),
    Buffer.from(iv, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final()
  ]).toString('utf8');
}

function requireAccessSessionSecret() {
  if (!ACCESS_SESSION_SECRET) {
    throw new HttpError(500, 'Access sessions are not configured', {
      code: 'ACCESS_SESSION_NOT_CONFIGURED'
    });
  }
  return ACCESS_SESSION_SECRET;
}

function signAccessSession(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', requireAccessSessionSecret())
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${signature}`;
}

function readCookie(request, name) {
  const cookies = request.headers.get('cookie') || '';
  for (const part of cookies.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) {
      try {
        return decodeURIComponent(part.slice(separator + 1).trim());
      } catch {
        return '';
      }
    }
  }
  return '';
}

function verifySignedAccessSession(value) {
  requireAccessSessionSecret();
  const [encoded, signature, extra] = String(value || '').split('.');
  if (!encoded || !signature || extra) return null;
  const expected = crypto
    .createHmac('sha256', ACCESS_SESSION_SECRET)
    .update(encoded)
    .digest('base64url');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload?.tokenId || !payload?.alias || !payload?.tokenHash ||
      payload?.version !== ACCESS_TOKEN_CIPHER_VERSION || !payload?.exp ||
      payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

async function findAlias(address) {
  if (USE_SUPABASE_STORAGE) {
    const client = getSupabaseAdmin();
    if (!client) return null;
    const { data, error } = await client
      .from(SUPABASE_TABLE_ALIASES)
      .select('address,active')
      .eq('address', address)
      .maybeSingle();
    if (error) {
      throw supabaseErrorToHttpError('select', SUPABASE_TABLE_ALIASES, error, 'Gagal memeriksa token alias');
    }
    if (!data) return null;
    return {
      address: data.address,
      active: data.active
    };
  }
  return (await loadAliases()).find((alias) => alias.address === address) || null;
}

async function createAccessSession(token) {
  requireAccessSessionSecret();
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken) throw new HttpError(401, 'Invalid or inactive access token');
  const tokenHash = hashAccessToken(normalizedToken);
  let tokenRow = null;

  if (USE_SUPABASE_STORAGE) {
    const client = getSupabaseAdmin();
    const { data, error } = await client
      .rpc('consume_alias_token', { p_token_hash: tokenHash });
    if (error) throw supabaseErrorToHttpError('consume token', SUPABASE_TABLE_ALIAS_TOKENS, error, 'Gagal memeriksa token alias');
    tokenRow = data?.[0] || null;
  } else {
    const aliases = await loadAliases();
    const alias = aliases.find((item) => item.active !== false && item.tokens.some((candidate) =>
      candidate.status === 'available' && constantTimeEqualHex(tokenHash, candidate.tokenHash)
    ));
    const candidate = alias?.tokens.find((item) =>
      item.status === 'available' && constantTimeEqualHex(tokenHash, item.tokenHash)
    );
    if (alias && candidate) {
      candidate.status = 'waiting';
      candidate.consumedAt = new Date().toISOString();
      await saveAliases(aliases);
      tokenRow = { id: candidate.id, alias_address: alias.address, token_hash: candidate.tokenHash };
    }
  }

  if (!tokenRow?.id || !tokenRow?.alias_address || !constantTimeEqualHex(tokenHash, tokenRow.token_hash)) {
    throw new HttpError(401, 'Invalid or inactive access token');
  }
  const exp = Math.floor(Date.now() / 1000) + ACCESS_SESSION_TTL_SECONDS;
  return {
    tokenId: tokenRow.id,
    alias: tokenRow.alias_address,
    status: 'waiting',
    expiresAt: new Date(exp * 1000).toISOString(),
    cookieValue: signAccessSession({
      tokenId: tokenRow.id,
      alias: tokenRow.alias_address,
      tokenHash,
      version: ACCESS_TOKEN_CIPHER_VERSION,
      exp
    })
  };
}

async function requireAccessSession(request) {
  const payload = verifySignedAccessSession(readCookie(request, ACCESS_COOKIE_NAME));
  if (!payload) throw new HttpError(401, 'Unauthorized');
  let tokenRow = null;
  if (USE_SUPABASE_STORAGE) {
    const client = getSupabaseAdmin();
    const { data, error } = await client
      .from(SUPABASE_TABLE_ALIAS_TOKENS)
      .select('id,alias_address,token_hash,status,fulfilled_at,message_id,app_aliases!inner(active)')
      .eq('id', payload.tokenId)
      .eq('alias_address', payload.alias)
      .in('status', ['waiting', 'fulfilled'])
      .eq('app_aliases.active', true)
      .maybeSingle();
    if (error) throw supabaseErrorToHttpError('select', SUPABASE_TABLE_ALIAS_TOKENS, error, 'Gagal memeriksa sesi');
    tokenRow = data;
  } else {
    const alias = (await loadAliases()).find((item) => item.address === payload.alias && item.active !== false);
    tokenRow = alias?.tokens.find((item) => item.id === payload.tokenId && ['waiting', 'fulfilled'].includes(item.status));
    if (tokenRow) tokenRow = { ...tokenRow, alias_address: alias.address, token_hash: tokenRow.tokenHash };
  }
  if (!tokenRow || !constantTimeEqualHex(payload.tokenHash, tokenRow.token_hash)) {
    throw new HttpError(401, 'Unauthorized');
  }
  return {
    tokenId: tokenRow.id,
    alias: tokenRow.alias_address,
    status: tokenRow.status,
    messageId: tokenRow.message_id || tokenRow.messageId || null,
    fulfilledAt: tokenRow.fulfilled_at || tokenRow.fulfilledAt || null,
    expiresAt: new Date(payload.exp * 1000).toISOString()
  };
}

const accessAttempts = new Map();
function checkAccessRateLimit(ip) {
  const key = ip || 'unknown';
  const now = Date.now();
  const current = accessAttempts.get(key);
  if (!current || current.resetAt <= now) {
    accessAttempts.set(key, { count: 1, resetAt: now + 60_000 });
    return;
  }
  current.count += 1;
  if (current.count > 10) {
    throw new HttpError(429, 'Too many access attempts', {
      details: { retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) }
    });
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [key, attempt] of accessAttempts.entries()) {
    if (attempt.resetAt <= now) accessAttempts.delete(key);
  }
}, 60_000).unref();

function getAccessCookieOptions() {
  return {
    name: ACCESS_COOKIE_NAME,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: ACCESS_SESSION_TTL_SECONDS
  };
}

function stripHtmlTags(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function isAllowedDomain(domain) {
  const normalized = String(domain || '').trim().toLowerCase();
  const domains = await loadDomains();
  return domains.find((d) => d.name === normalized && d.active !== false);
}

async function auditLog(action, reqMeta = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    action,
    ...reqMeta
  };
  if (USE_SUPABASE_STORAGE) {
    const { ip, userAgent, ...meta } = reqMeta || {};
    await supabaseInsert(SUPABASE_TABLE_AUDIT, {
      timestamp: entry.timestamp,
      action,
      ip: ip || null,
      user_agent: userAgent || null,
      meta
    });
    await supabaseTrimAudit(1000);
    log('info', 'Audit log', entry);
    return;
  }
  const audits = await loadAudit();
  audits.push(entry);
  const MAX_AUDIT = 1000;
  if (audits.length > MAX_AUDIT) audits.splice(0, audits.length - MAX_AUDIT);
  await saveAudit(audits);
  log('info', 'Audit log', entry);
}

// ========== CACHE ==========
const messageCache = new Map();
const CACHE_TTL_MS = 30 * 1000; // 30 seconds for faster message appearance
const inFlightCache = new Map();

function isGmailQuotaError(err) {
  const status = err?.code || err?.response?.status || err?.status;
  const message = String(err?.message || err?.response?.data?.error?.message || '').toLowerCase();
  return status === 429 || (
    message.includes('quota exceeded') &&
    (message.includes('gmail.googleapis.com') || message.includes('total query cost'))
  );
}

function gmailErrorToHttpError(err, action) {
  if (isGmailQuotaError(err)) {
    return new HttpError(429, 'Kuota Gmail API habis sementara. Coba lagi dalam 1 menit atau kurangi refresh inbox.', {
      code: 'GMAIL_QUOTA_EXCEEDED',
      details: { action, retryAfterSeconds: 60 }
    });
  }

  return new HttpError(502, `Gagal menghubungi Gmail API saat ${action}: ${err?.message || 'unknown error'}`, {
    code: 'GMAIL_API_ERROR',
    details: { action, status: err?.code || err?.response?.status || null }
  });
}

async function withGmailErrorHandling(action, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw gmailErrorToHttpError(err, action);
  }
}

async function getOrCreateInFlight(key, fn) {
  const existing = inFlightCache.get(key);
  if (existing) return existing;

  const promise = Promise.resolve()
    .then(fn)
    .finally(() => inFlightCache.delete(key));
  inFlightCache.set(key, promise);
  return promise;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await mapper(items[current], current);
    }
  });

  await Promise.all(workers);
  return results;
}

function cacheGet(key) {
  const entry = messageCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    messageCache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value, ttl = CACHE_TTL_MS) {
  messageCache.set(key, { value, expiresAt: Date.now() + ttl });
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of messageCache.entries()) {
    if (entry.expiresAt < now) messageCache.delete(key);
  }
}, CACHE_TTL_MS).unref();

// ========== CACHE INVALIDATION & SSE PUSH ==========
function invalidateMessageCache() {
  // Clear all message list caches so next request fetches fresh from Gmail
  for (const key of messageCache.keys()) {
    if (key.startsWith('msg:')) messageCache.delete(key);
  }
  log('info', 'Message cache invalidated via push notification');
}

const sseSubscribers = new Set();

function subscribeNewMail(listener) {
  sseSubscribers.add(listener);
}

function unsubscribeNewMail(listener) {
  sseSubscribers.delete(listener);
}

function notifyNewMail(payload = {}) {
  for (const listener of sseSubscribers) {
    try { listener(payload); } catch {}
  }
}

// ========== OAUTH STATE ==========
const AUTH_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const AUTH_STATE_TTL_MS = 10 * 60 * 1000;
const pendingStates = new Map();

function createState() {
  const state = crypto.randomBytes(24).toString('hex');
  pendingStates.set(state, Date.now() + AUTH_STATE_TTL_MS);
  return state;
}

function consumeState(state) {
  const expiresAt = pendingStates.get(state);
  if (!expiresAt) return false;
  pendingStates.delete(state);
  return expiresAt >= Date.now();
}

setInterval(() => {
  const now = Date.now();
  for (const [state, exp] of pendingStates.entries()) {
    if (exp < now) pendingStates.delete(state);
  }
}, AUTH_STATE_TTL_MS).unref();

// ========== OAUTH CLIENT ==========
let oauthClientSingleton = null;

async function tokenExists() {
  if (USE_SUPABASE_STORAGE) {
    const key = getStorageKey(TOKEN_PATH);
    const value = await supabaseGet(key);
    return value != null;
  }
  return fileExists(TOKEN_PATH);
}

async function getOAuthClient() {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REDIRECT_URI) {
    throw new HttpError(500, 'Google OAuth is not configured. Configure Gmail API only if Gmail fallback/OAuth is needed.', {
      code: 'GOOGLE_OAUTH_NOT_CONFIGURED'
    });
  }
  if (oauthClientSingleton) return oauthClientSingleton;
  const client = new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI
  );

  if (await tokenExists()) {
    try {
      const saved = await loadJson(TOKEN_PATH, null);
      if (saved) {
        client.setCredentials(saved);
        log('info', 'Loaded saved token', {
          hasRefreshToken: Boolean(saved.refresh_token),
          expiresAt: saved.expiry_date ? new Date(saved.expiry_date).toISOString() : 'unknown'
        });
      }
    } catch (e) {
      log('error', 'Failed to parse token file', { error: e.message });
    }
  }

  // Listen for automatic token refresh by googleapis library
  client.on('tokens', async (tokens) => {
    try {
      let current = {};
      if (await tokenExists()) {
        current = await loadJson(TOKEN_PATH, {}) || {};
      }
      // IMPORTANT: preserve refresh_token — Google only sends it on first auth
      const updated = { ...current, ...tokens };
      if (!updated.refresh_token && current.refresh_token) {
        updated.refresh_token = current.refresh_token;
      }
      await saveJson(TOKEN_PATH, updated);
      log('info', 'Token auto-refreshed and saved', {
        hasRefreshToken: Boolean(updated.refresh_token),
        expiresAt: updated.expiry_date ? new Date(updated.expiry_date).toISOString() : 'unknown'
      });
    } catch (e) {
      log('error', 'Failed to save refreshed token', { error: e.message });
    }
  });

  oauthClientSingleton = client;
  return client;
}

async function ensureToken() {
  if (!(await tokenExists())) {
    throw new HttpError(401, 'Not authenticated');
  }
  try {
    const tokens = await loadJson(TOKEN_PATH, null);
    if (!tokens) throw new Error('Invalid token content');

    // Reset singleton if refresh_token changed (user re-authenticated)
    if (oauthClientSingleton && tokens.refresh_token) {
      const currentCreds = oauthClientSingleton.credentials;
      if (currentCreds.refresh_token && currentCreds.refresh_token !== tokens.refresh_token) {
        oauthClientSingleton = null;
        log('info', 'OAuth client reset — new refresh token detected');
      }
    }

    const client = await getOAuthClient();
    client.setCredentials(tokens);

    // Proactively refresh if access token expires within 5 minutes
    const expiryDate = tokens.expiry_date || 0;
    const now = Date.now();
    if (expiryDate && expiryDate - now < 5 * 60 * 1000) {
      try {
        const { credentials } = await client.refreshAccessToken();
        client.setCredentials(credentials);
        const updated = { ...tokens, ...credentials };
        if (!updated.refresh_token && tokens.refresh_token) {
          updated.refresh_token = tokens.refresh_token;
        }
        await saveJson(TOKEN_PATH, updated);
        log('info', 'Token proactively refreshed', { expiresIn: Math.round((credentials.expiry_date - now) / 1000) + 's' });
      } catch (refreshErr) {
        if (refreshErr.message && refreshErr.message.includes('invalid_grant')) {
          // Reset singleton so next attempt loads fresh from storage
          oauthClientSingleton = null;
          log('error', 'Refresh token invalid — re-authentication required');
          throw new HttpError(401, 'Token expired. Please re-authenticate via /login');
        }
        // For other errors, don't throw — let the API call try with existing token
        log('warn', 'Token refresh failed, proceeding with existing token', { error: refreshErr.message });
      }
    }

    return client;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    log('error', 'Failed to read token', { error: e.message });
    throw new HttpError(500, 'Token file invalid');
  }
}

async function requireAdmin(request) {
  const authHeader = request.headers.get('authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  if (token) {
    const client = getSupabaseAdmin();
    if (!client) {
      throw new HttpError(500, 'Supabase admin client not configured');
    }
    const { data, error } = await client.auth.getUser(token);
    if (error || !data?.user) {
      throw new HttpError(401, 'Unauthorized');
    }
    const email = (data.user.email || '').toLowerCase();
    if (ADMIN_EMAILS.length > 0 && !ADMIN_EMAILS.includes(email)) {
      throw new HttpError(403, 'Forbidden');
    }
    return;
  }

  const key = request.headers.get('x-admin-key');
  if (env.ADMIN_API_KEY && key && key === env.ADMIN_API_KEY) {
    return;
  }

  throw new HttpError(401, 'Unauthorized');
}

function decodeBase64Url(str = '') {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function extractBody(payload) {
  let bodyHtml = '';
  let bodyText = '';

  function traverse(part) {
    if (!part) return;
    const data = part.body?.data ? decodeBase64Url(part.body.data) : '';
    if (part.mimeType === 'text/html') bodyHtml += data;
    if (part.mimeType === 'text/plain') bodyText += data;
    if (part.parts) part.parts.forEach(traverse);
  }

  traverse(payload);
  return { bodyHtml, bodyText };
}

function normalizeHeaderMap(headers = {}) {
  const result = {};
  if (headers && typeof headers.forEach === 'function') {
    headers.forEach((value, key) => {
      result[String(key).toLowerCase()] = String(value || '');
    });
    return result;
  }

  for (const [key, value] of Object.entries(headers || {})) {
    result[String(key).toLowerCase()] = Array.isArray(value)
      ? value.join(', ')
      : String(value || '');
  }
  return result;
}

function extractEmailAddress(value = '') {
  const raw = String(value || '').trim();
  const match = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : raw.toLowerCase();
}

function buildSnippet(...parts) {
  return parts
    .map((part) => stripHtmlTags(String(part || '')))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

function normalizeStoredMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    alias: row.alias,
    tokenId: row.token_id || null,
    from: row.from_email || '',
    to: row.to_email || row.alias || '',
    subject: row.subject || '',
    date: row.date || row.created_at || '',
    snippet: row.snippet || '',
    bodyText: row.body_text || '',
    bodyHtml: row.body_html || '',
    headers: row.headers || {},
    source: row.source || 'cloudflare_email_worker',
    createdAt: row.created_at || row.date || ''
  };
}

function isMissingRelationError(error) {
  const message = String(error?.message || '').toLowerCase();
  return error?.code === '42P01' || message.includes('does not exist') || message.includes('schema cache');
}

async function listStoredMessages(alias, limit = MAX_MESSAGES, tokenId = null) {
  if (!USE_SUPABASE_STORAGE) return null;
  const client = getSupabaseAdmin();
  if (!client) return null;

  let query = client
    .from(SUPABASE_TABLE_MESSAGES)
    .select('id,alias,token_id,from_email,to_email,subject,date,snippet,body_text,body_html,headers,source,created_at')
    .order('created_at', { ascending: false })
    .limit(Math.min(limit, MAX_MESSAGES));
  if (alias) query = query.eq('alias', alias);
  if (tokenId) query = query.eq('token_id', tokenId);

  const { data, error } = await query;
  if (error) {
    if (isMissingRelationError(error)) {
      log('warn', 'Stored messages table is unavailable, falling back to Gmail', { error: error.message });
      return null;
    }
    throw supabaseErrorToHttpError('select', SUPABASE_TABLE_MESSAGES, error, 'Gagal membaca pesan tersimpan');
  }
  return (data || []).map(normalizeStoredMessage);
}

async function getStoredMessageDetail(id, tokenId = null) {
  if (!USE_SUPABASE_STORAGE) return null;
  const client = getSupabaseAdmin();
  if (!client) return null;

  let query = client
    .from(SUPABASE_TABLE_MESSAGES)
    .select('*')
    .eq('id', id);
  if (tokenId) query = query.eq('token_id', tokenId);
  const { data, error } = await query.maybeSingle();
  if (error) {
    if (isMissingRelationError(error)) return null;
    throw supabaseErrorToHttpError('select', SUPABASE_TABLE_MESSAGES, error, 'Gagal membaca detail pesan tersimpan');
  }
  return normalizeStoredMessage(data);
}

async function allocateInboundMessage(alias, row) {
  if (!USE_SUPABASE_STORAGE) {
    throw new HttpError(500, 'Supabase storage is required for Cloudflare Email webhook', {
      code: 'SUPABASE_REQUIRED'
    });
  }
  const client = getSupabaseAdmin();
  if (!client) throw new HttpError(500, 'Supabase admin client not configured');

  const { data, error } = await client.rpc('allocate_alias_message', {
    p_alias: alias,
    p_message: row
  });
  if (error) {
    throw supabaseErrorToHttpError('allocate message', SUPABASE_TABLE_MESSAGES, error, 'Gagal mengalokasikan email masuk');
  }
  return data?.[0] || { outcome: 'admin_only', token_id: null, message_id: row.id };
}

async function requireActiveInboundAlias(alias) {
  const client = getSupabaseAdmin();
  if (!client) throw new HttpError(500, 'Supabase admin client not configured');

  const { data: existing, error: existingError } = await client
    .from(SUPABASE_TABLE_ALIASES)
    .select('address,active')
    .eq('address', alias)
    .maybeSingle();
  if (existingError) {
    throw supabaseErrorToHttpError('select', SUPABASE_TABLE_ALIASES, existingError, 'Gagal memeriksa alias inbound');
  }
  if (!existing) throw new HttpError(404, 'Recipient alias not found');
  if (existing.active === false) throw new HttpError(400, 'Recipient alias is inactive');
}

async function touchLogs(msgs, alias) {
  if (!msgs || !msgs.length) return;
  const now = new Date().toISOString();
  const logs = await loadLogs();
  const indexById = new Map();
  logs.forEach((l, i) => indexById.set(l.id, i));

  msgs.forEach((m) => {
    const idx = indexById.get(m.id);
    if (idx != null) {
      logs[idx].lastSeenAt = now;
      logs[idx].alias = alias || logs[idx].alias || null;
    } else {
      logs.push({
        id: m.id,
        alias: alias || null,
        from: m.from || '',
        subject: m.subject || '',
        date: m.date || '',
        snippet: m.snippet || '',
        lastSeenAt: now
      });
    }
  });

  if (logs.length > MAX_LOGS) {
    logs.sort((a, b) => new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0));
    logs.length = MAX_LOGS;
  }

  await saveLogs(logs);
}

async function ingestCloudflareEmail(request) {
  const expectedSecret = process.env.CLOUDFLARE_EMAIL_WEBHOOK_SECRET || '';
  if (!expectedSecret) {
    throw new HttpError(500, 'Cloudflare Email webhook secret is not configured', {
      code: 'WEBHOOK_SECRET_NOT_CONFIGURED'
    });
  }

  const providedSecret = request.headers.get('x-webhook-secret') || '';
  const providedBuffer = Buffer.from(providedSecret);
  const expectedBuffer = Buffer.from(expectedSecret);
  if (providedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    throw new HttpError(401, 'Invalid webhook secret', { code: 'INVALID_WEBHOOK_SECRET' });
  }

  const body = await request.json().catch(() => null);
  const raw = body?.rawBase64
    ? Buffer.from(String(body.rawBase64), 'base64').toString('utf8')
    : String(body?.raw || '');
  if (!raw) throw new HttpError(400, 'raw email is required');

  const parsed = await simpleParser(raw);
  const headers = {
    ...normalizeHeaderMap(body?.headers || {}),
    ...normalizeHeaderMap(parsed.headers)
  };
  const toEmail = extractEmailAddress(body?.to || parsed.to?.text || headers.to || headers['delivered-to']);
  const alias = extractEmailAddress(body?.alias || toEmail);
  if (!isValidEmail(alias)) throw new HttpError(400, 'Invalid recipient alias');
  const domain = alias.split('@')[1];
  if (!(await isAllowedDomain(domain))) throw new HttpError(400, 'Domain not allowed');

  const messageId = String(parsed.messageId || headers['message-id'] || '').trim();
  const hash = crypto.createHash('sha256')
    .update(`${alias}\n${messageId || raw.slice(0, 4096)}`)
    .digest('hex');
  const id = `cf_${hash}`;
  const subject = parsed.subject || headers.subject || '';
  const fromEmail = parsed.from?.text || body?.from || headers.from || '';
  const bodyText = parsed.text || '';
  const bodyHtml = typeof parsed.html === 'string' ? parsed.html : '';
  const receivedAt = parsed.date ? parsed.date.toISOString() : new Date().toISOString();
  const snippet = buildSnippet(subject, bodyText, bodyHtml);

  await requireActiveInboundAlias(alias);

  const row = {
    id,
    alias,
    from_email: fromEmail,
    to_email: toEmail || alias,
    subject,
    date: receivedAt,
    snippet,
    body_text: bodyText,
    body_html: bodyHtml,
    raw,
    headers,
    source: 'cloudflare_email_worker',
    created_at: new Date().toISOString()
  };

  const allocation = await allocateInboundMessage(alias, row);
  if (allocation.outcome === 'duplicate') {
    return { ok: true, ignored: true, reason: 'duplicate', id, alias };
  }
  row.token_id = allocation.token_id || null;
  await touchLogs([normalizeStoredMessage(row)], alias);
  invalidateMessageCache();
  if (allocation.token_id) {
    notifyNewMail({ alias, tokenId: allocation.token_id, id, source: 'cloudflare_email_worker' });
  }

  return {
    ok: true,
    id,
    alias,
    tokenId: allocation.token_id || null,
    adminOnly: !allocation.token_id,
    subject,
    from: fromEmail
  };
}

async function cloudflareEmailWebhookHealth() {
  const expectedSecret = process.env.CLOUDFLARE_EMAIL_WEBHOOK_SECRET || '';
  const client = getSupabaseAdmin();
  const result = {
    ok: true,
    webhookSecretConfigured: Boolean(expectedSecret),
    useSupabaseStorage: USE_SUPABASE_STORAGE,
    table: SUPABASE_TABLE_MESSAGES,
    messagesTable: { ok: false, error: null, count: null }
  };

  if (!USE_SUPABASE_STORAGE || !client) {
    result.ok = false;
    result.messagesTable.error = 'Supabase storage is not configured';
    return result;
  }

  const { count, error } = await client
    .from(SUPABASE_TABLE_MESSAGES)
    .select('*', { count: 'exact', head: true });
  result.messagesTable.ok = !error;
  result.messagesTable.error = error?.message || null;
  result.messagesTable.count = count ?? null;
  result.ok = result.webhookSecretConfigured && result.messagesTable.ok;
  return result;
}

// ========== SERVICE METHODS ==========
async function generateAuthUrl() {
  const state = createState();
  const client = await getOAuthClient();
  const url = client.generateAuthUrl({
    access_type: 'offline',
    scope: AUTH_SCOPES,
    prompt: 'consent',
    state,
    // Include granted scopes to avoid re-consent for already granted permissions
    include_granted_scopes: true
  });
  return { url, state, expiresInMs: AUTH_STATE_TTL_MS };
}

async function exchangeCode(code, state) {
  if (!code) throw new HttpError(400, 'No code provided');
  if (!state) {
    throw new HttpError(400, 'Missing OAuth state');
  }
  if (!consumeState(state)) {
    throw new HttpError(400, 'Invalid or expired OAuth state');
  }
  try {
    const client = await getOAuthClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    // Merge with existing tokens to preserve refresh_token if not returned
    let existing = {};
    if (await tokenExists()) {
      existing = await loadJson(TOKEN_PATH, {}) || {};
    }
    const merged = { ...existing, ...tokens };
    // Ensure refresh_token is preserved
    if (!merged.refresh_token && existing.refresh_token) {
      merged.refresh_token = existing.refresh_token;
    }

    await saveJson(TOKEN_PATH, merged);
    // Reset singleton so next call picks up new credentials
    oauthClientSingleton = null;
    log('info', 'Token obtained and saved successfully', {
      hasRefreshToken: Boolean(merged.refresh_token),
      expiresAt: merged.expiry_date ? new Date(merged.expiry_date).toISOString() : 'unknown'
    });
    return { ok: true };
  } catch (err) {
    log('error', 'Failed to get tokens', { error: err.message });
    throw new HttpError(500, 'Failed to get tokens');
  }
}

async function revokeToken() {
  if (!(await tokenExists())) {
    throw new HttpError(404, 'No token to revoke');
  }
  try {
    const client = await getOAuthClient();
    await client.revokeCredentials();
    if (!USE_SUPABASE_STORAGE) {
      await fsPromises.unlink(TOKEN_PATH);
    } else {
      await supabaseSet(getStorageKey(TOKEN_PATH), null);
    }
    await auditLog('token_revoked');
    return { ok: true };
  } catch (err) {
    log('error', 'Failed to revoke token', { error: err.message });
    throw new HttpError(500, 'Failed to revoke token');
  }
}

async function health() {
  return {
    ok: true,
    hasToken: await tokenExists(),
    allowedOrigins: ALLOWED_ORIGINS,
    maxMessages: MAX_MESSAGES,
    cacheSize: messageCache.size
  };
}

async function tokenHealth() {
  const tokens = await loadJson(TOKEN_PATH, null);
  const hasRefreshToken = Boolean(tokens?.refresh_token);
  const expiryDate = tokens?.expiry_date || 0;
  const now = Date.now();
  const expiresInMs = expiryDate ? expiryDate - now : 0;

  const client = await ensureToken();
  const gmail = google.gmail({ version: 'v1', auth: client });
  const start = Date.now();
  await withGmailErrorHandling('memeriksa profil Gmail', () => gmail.users.getProfile({ userId: 'me' }));
  return {
    ok: true,
    tokenValid: true,
    latencyMs: Date.now() - start,
    hasRefreshToken,
    accessTokenExpiresIn: expiresInMs > 0 ? Math.round(expiresInMs / 1000) + 's' : 'expired/unknown',
    tip: !hasRefreshToken ? 'WARNING: No refresh token. Re-authenticate with /login to get a new one.' : null
  };
}

const MESSAGE_RECIPIENT_HEADERS = [
  'To',
  'Cc',
  'Bcc',
  'Delivered-To',
  'X-Original-To',
  'Envelope-To',
  'X-Envelope-To',
  'Original-Recipient',
  'X-Original-Recipient',
  'X-Forwarded-To'
];

async function listMessages(alias, options = {}) {
  const { adminBypass = false, tokenId = null } = options || {};
  const trimmedAlias = (alias || '').trim().toLowerCase();

  if (!adminBypass && tokenId) {
    const storedMessages = await listStoredMessages(trimmedAlias, MAX_MESSAGES, tokenId);
    return { messages: storedMessages || [], source: storedMessages ? 'supabase' : 'json' };
  }

  const listOptions = {
    userId: 'me',
    maxResults: MAX_MESSAGES
  };

  if (trimmedAlias) {
    if (!isValidEmail(trimmedAlias)) throw new HttpError(400, 'Invalid alias address');
    const domain = trimmedAlias.split('@')[1];
    if (!(await isAllowedDomain(domain))) throw new HttpError(400, 'Domain not allowed');
    // Cloudflare Email Routing forwards to a destination Gmail address.
    // Depending on provider, the original alias may not be searchable via Gmail operators.
    // Strategy: list recent messages and filter by common recipient/forwarding headers.
    listOptions.q = 'newer_than:7d';
    // Don't hard-filter to INBOX; forwarded mail may be archived/spam.
    listOptions.includeSpamTrash = true;

    const now = new Date().toISOString();
    if (USE_SUPABASE_STORAGE) {
      const sbClient = getSupabaseAdmin();
      if (sbClient) {
        const { data: aliasRow } = await sbClient
          .from(SUPABASE_TABLE_ALIASES)
          .select('active, hits')
          .eq('address', trimmedAlias)
          .maybeSingle();
        if (!aliasRow && !adminBypass) throw new HttpError(401, 'Unauthorized');
        if (aliasRow && aliasRow.active === false) throw new HttpError(403, 'Alias is archived');
        if (aliasRow) {
          await sbClient.from(SUPABASE_TABLE_ALIASES)
            .update({ last_used_at: now, hits: (aliasRow.hits || 0) + 1 })
            .eq('address', trimmedAlias);
        }
      }
    } else {
      const aliases = await loadAliases();
      const found = aliases.find((a) => a.address === trimmedAlias);
      if (!found && !adminBypass) throw new HttpError(401, 'Unauthorized');
      if (found) {
        if (found.active === false) throw new HttpError(403, 'Alias is archived');
        found.lastUsedAt = now;
        found.hits = (found.hits || 0) + 1;
        await saveAliases(aliases);
      }
    }
  } else {
    // Default view: latest inbox messages
    listOptions.labelIds = ['INBOX'];
  }

  const storedMessages = !trimmedAlias && !adminBypass
    ? []
    : await listStoredMessages(trimmedAlias || null, MAX_MESSAGES);
  if (storedMessages) {
    return { messages: storedMessages, source: 'supabase' };
  }

  const listCacheKey = `list:${trimmedAlias || 'inbox'}:${adminBypass ? 'admin' : 'public'}`;
  const cachedList = cacheGet(listCacheKey);
  if (cachedList) return cachedList;

  return getOrCreateInFlight(listCacheKey, async () => {
    const client = await ensureToken();
    const gmail = google.gmail({ version: 'v1', auth: client });
    const listRes = await withGmailErrorHandling('memuat daftar pesan', () => gmail.users.messages.list(listOptions));
    const messages = listRes.data.messages || [];

    const results = (await mapWithConcurrency(messages, GMAIL_METADATA_CONCURRENCY, async (msg) => {
      const cacheKey = trimmedAlias ? `msg:${msg.id}:${trimmedAlias}` : `msg:${msg.id}`;
      const cached = cacheGet(cacheKey);
      if (cached) return cached;

      const msgRes = await withGmailErrorHandling('memuat metadata pesan', () => gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date', ...MESSAGE_RECIPIENT_HEADERS]
      }));

      const headers = msgRes.data.payload.headers || [];
      const getHeaders = (name) =>
        headers
          .filter((h) => h.name.toLowerCase() === name.toLowerCase())
          .map((h) => h.value || '')
          .filter(Boolean);
      const getHeader = (name) =>
        getHeaders(name)[0] || '';

      const result = {
        id: msg.id,
        subject: getHeader('Subject'),
        from: getHeader('From'),
        to: getHeader('To'),
        date: getHeader('Date'),
        snippet: msgRes.data.snippet || ''
      };

      if (trimmedAlias) {
        const recipientHaystack = MESSAGE_RECIPIENT_HEADERS
          .flatMap((name) => getHeaders(name))
          .join(' ')
          .toLowerCase();

        if (!recipientHaystack.includes(trimmedAlias)) {
          return null;
        }
      }

      cacheSet(cacheKey, result);
      return result;
    }))
      .filter(Boolean);

    await touchLogs(results, trimmedAlias || null);
    const payload = {
      messages: results,
      source: 'gmail'
    };
    cacheSet(listCacheKey, payload, GMAIL_LIST_CACHE_TTL_MS);
    return payload;
  });
}

async function getMessageDetail(id, options = {}) {
  if (!id) throw new HttpError(400, 'Missing message id');
  const alias = String(options.alias || '').trim().toLowerCase();
  const tokenId = options.tokenId || null;
  const cacheKey = `detail:${id}:${tokenId || alias || 'admin'}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const stored = await getStoredMessageDetail(id, tokenId);
  if (stored) {
    if (alias && stored.alias !== alias) throw new HttpError(404, 'Message not found');
    cacheSet(cacheKey, stored);
    return stored;
  }

  if (tokenId) throw new HttpError(404, 'Message not found');

  if (alias) {
    const listing = await listMessages(alias);
    if (!listing.messages.some((message) => message.id === id)) {
      throw new HttpError(404, 'Message not found');
    }
  }

  const client = await ensureToken();
  const gmail = google.gmail({ version: 'v1', auth: client });
  const msgRes = await withGmailErrorHandling('memuat isi pesan', () => gmail.users.messages.get({
    userId: 'me',
    id,
    format: 'full'
  }));

  const headers = msgRes.data.payload.headers || [];
  const getHeader = (name) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

  const { bodyHtml, bodyText } = extractBody(msgRes.data.payload);

  const result = {
    id,
    subject: getHeader('Subject'),
    from: getHeader('From'),
    date: getHeader('Date'),
    snippet: msgRes.data.snippet,
    bodyHtml,
    bodyText
  };

  cacheSet(cacheKey, result);
  return result;
}

async function adminCreateAlias(input = {}) {
  const address = String(input?.address || '').trim().toLowerCase();
  if (!address) throw new HttpError(400, 'Address is required');
  if (!isValidEmail(address)) throw new HttpError(400, 'Invalid address');
  const domain = address.split('@')[1];
  if (!(await isAllowedDomain(domain))) throw new HttpError(400, 'Domain not allowed');
  const existing = await findAlias(address);
  if (existing) {
    throw new HttpError(409, 'Alias already exists. Add another token to the existing alias.');
  }

  const createdAt = new Date().toISOString();
  if (USE_SUPABASE_STORAGE) {
    const client = getSupabaseAdmin();
    const { error } = await client.from(SUPABASE_TABLE_ALIASES).insert({
      address,
      created_at: createdAt,
      last_used_at: null,
      hits: 0,
      active: true
    });
    if (error?.code === '23505') {
      throw new HttpError(409, 'Alias already exists. Add another token to the existing alias.');
    }
    if (error) {
      throw supabaseErrorToHttpError('insert', SUPABASE_TABLE_ALIASES, error, 'Gagal membuat alias');
    }
  } else {
    const aliases = await loadAliases();
    if (aliases.some((alias) => alias.address === address)) {
      throw new HttpError(409, 'Alias already exists. Add another token to the existing alias.');
    }
    aliases.push({
      address,
      createdAt,
      lastUsedAt: null,
      hits: 0,
      active: true,
      tokens: []
    });
    await saveAliases(aliases);
  }

  let token;
  try {
    token = await createAliasToken(address);
  } catch (error) {
    if (USE_SUPABASE_STORAGE) {
      await getSupabaseAdmin().from(SUPABASE_TABLE_ALIASES).delete().eq('address', address);
    }
    throw error;
  }
  await auditLog('alias_created', { address, tokenId: token.token.id });
  return {
    ok: true,
    accessToken: token.accessToken,
    token: token.token,
    alias: { address, active: true, createdAt }
  };
}

function normalizeAliasToken(row, includePlaintext = false) {
  const result = {
    id: row.id,
    alias: row.alias_address || row.alias,
    tokenLast4: row.token_last4 || row.tokenLast4 || null,
    status: row.status,
    createdAt: row.created_at || row.createdAt,
    consumedAt: row.consumed_at || row.consumedAt || null,
    fulfilledAt: row.fulfilled_at || row.fulfilledAt || null,
    messageId: row.message_id || row.messageId || null
  };
  if (includePlaintext) {
    result.accessToken = row.token_ciphertext
      ? decryptAccessToken(row.token_ciphertext)
      : decryptAccessToken(row.tokenCiphertext);
  }
  return result;
}

async function createAliasToken(address) {
  const addr = decodeURIComponent(address || '').trim().toLowerCase();
  const existing = await findAlias(addr);
  if (!existing) throw new HttpError(404, 'Alias not found');
  const accessToken = generateAccessToken();
  const row = {
    id: crypto.randomUUID(),
    alias_address: addr,
    token_hash: hashAccessToken(accessToken),
    token_ciphertext: encryptAccessToken(accessToken),
    token_last4: accessToken.slice(-4),
    status: 'available',
    created_at: new Date().toISOString()
  };

  if (USE_SUPABASE_STORAGE) {
    const client = getSupabaseAdmin();
    const { error } = await client.from(SUPABASE_TABLE_ALIAS_TOKENS).insert(row);
    if (error) throw supabaseErrorToHttpError('insert', SUPABASE_TABLE_ALIAS_TOKENS, error, 'Gagal membuat token alias');
  } else {
    const aliases = await loadAliases();
    const target = aliases.find((alias) => alias.address === addr);
    target.tokens.push({
      id: row.id,
      tokenHash: row.token_hash,
      tokenCiphertext: row.token_ciphertext,
      tokenLast4: row.token_last4,
      status: row.status,
      createdAt: row.created_at
    });
    await saveAliases(aliases);
  }

  await auditLog('alias_token_created', { address: addr, tokenId: row.id });
  return {
    ok: true,
    accessToken,
    token: normalizeAliasToken(row)
  };
}

async function listAliasTokens(address) {
  const addr = decodeURIComponent(address || '').trim().toLowerCase();
  if (!(await findAlias(addr))) throw new HttpError(404, 'Alias not found');
  let rows;
  if (USE_SUPABASE_STORAGE) {
    const { data, error } = await getSupabaseAdmin()
      .from(SUPABASE_TABLE_ALIAS_TOKENS)
      .select('*')
      .eq('alias_address', addr)
      .order('created_at', { ascending: true });
    if (error) throw supabaseErrorToHttpError('select', SUPABASE_TABLE_ALIAS_TOKENS, error, 'Gagal membaca token alias');
    rows = data || [];
  } else {
    rows = (await loadAliases()).find((alias) => alias.address === addr)?.tokens || [];
  }
  return { alias: addr, tokens: rows.map((row) => normalizeAliasToken(row, true)) };
}

async function revokeAliasToken(address, tokenId) {
  const addr = decodeURIComponent(address || '').trim().toLowerCase();
  const id = String(tokenId || '').trim();
  let token;
  if (USE_SUPABASE_STORAGE) {
    const client = getSupabaseAdmin();
    const { data, error } = await client
      .from(SUPABASE_TABLE_ALIAS_TOKENS)
      .select('*')
      .eq('id', id)
      .eq('alias_address', addr)
      .maybeSingle();
    if (error) throw supabaseErrorToHttpError('select', SUPABASE_TABLE_ALIAS_TOKENS, error, 'Gagal membaca token alias');
    token = data;
    if (!token) throw new HttpError(404, 'Token not found');
    if (token.status === 'fulfilled') throw new HttpError(409, 'Fulfilled tokens cannot be revoked');
    if (token.status !== 'revoked') {
      const { data: updated, error: updateError } = await client
        .from(SUPABASE_TABLE_ALIAS_TOKENS)
        .update({ status: 'revoked' })
        .eq('id', id)
        .eq('alias_address', addr)
        .neq('status', 'fulfilled')
        .select('id,status')
        .maybeSingle();
      if (updateError) throw supabaseErrorToHttpError('update', SUPABASE_TABLE_ALIAS_TOKENS, updateError, 'Gagal mencabut token alias');
      if (!updated) throw new HttpError(409, 'Fulfilled tokens cannot be revoked');
    }
  } else {
    const aliases = await loadAliases();
    token = aliases.find((alias) => alias.address === addr)?.tokens.find((item) => item.id === id);
    if (!token) throw new HttpError(404, 'Token not found');
    if (token.status === 'fulfilled') throw new HttpError(409, 'Fulfilled tokens cannot be revoked');
    token.status = 'revoked';
    await saveAliases(aliases);
  }
  await auditLog('alias_token_revoked', { address: addr, tokenId: id });
  return { ok: true, token: { ...normalizeAliasToken(token), status: 'revoked' } };
}

async function updateAlias(address, input = {}) {
  const addressParam = decodeURIComponent(address || '').toLowerCase();
  const aliases = await loadAliases();
  const target = aliases.find((a) => a.address === addressParam);
  if (!target) throw new HttpError(404, 'Alias not found');

  if (typeof input?.active === 'boolean') target.active = input.active;

  await saveAliases(aliases);
  await auditLog('alias_updated', {
    address: addressParam,
    active: target.active
  });
  return {
    ok: true,
    alias: {
      address: target.address,
      createdAt: target.createdAt,
      lastUsedAt: target.lastUsedAt,
      hits: target.hits,
      active: target.active
    }
  };
}

async function adminStats() {
  const aliases = await loadAliases();
  const domains = await loadDomains();
  const total = aliases.length;
  const totalHits = aliases.reduce((sum, a) => sum + (a.hits || 0), 0);
  return {
    totalAliases: total,
    totalHits,
    lastAliasCreatedAt: aliases[total - 1]?.createdAt || null,
    totalDomains: domains.length,
    storage: {
      mode: USE_SUPABASE_STORAGE ? 'supabase' : 'json',
      supabaseUrlHost: SUPABASE_URL ? new URL(SUPABASE_URL).host : null,
      instanceId: MODULE_INSTANCE_ID,
      tables: {
        kv: SUPABASE_KV_TABLE,
        aliases: SUPABASE_TABLE_ALIASES,
        aliasTokens: SUPABASE_TABLE_ALIAS_TOKENS,
        domains: SUPABASE_TABLE_DOMAINS,
        logs: SUPABASE_TABLE_LOGS,
        messages: SUPABASE_TABLE_MESSAGES,
        audit: SUPABASE_TABLE_AUDIT
      }
    }
  };
}

async function adminAliases() {
  const aliases = await loadAliases();
  let tokens = [];
  if (USE_SUPABASE_STORAGE) {
    tokens = await supabaseSelectAll(SUPABASE_TABLE_ALIAS_TOKENS, 'created_at') || [];
  } else {
    tokens = aliases.flatMap((alias) => alias.tokens.map((token) => ({ ...token, alias_address: alias.address })));
  }
  const publicAliases = aliases.map((alias) => ({
    address: alias.address,
    createdAt: alias.createdAt,
    lastUsedAt: alias.lastUsedAt,
    hits: alias.hits,
    active: alias.active,
    tokenCount: tokens.filter((token) => (token.alias_address || token.alias) === alias.address).length,
    availableTokenCount: tokens.filter((token) => (token.alias_address || token.alias) === alias.address && token.status === 'available').length,
    waitingTokenCount: tokens.filter((token) => (token.alias_address || token.alias) === alias.address && token.status === 'waiting').length,
    fulfilledTokenCount: tokens.filter((token) => (token.alias_address || token.alias) === alias.address && token.status === 'fulfilled').length
  }));
  return {
    aliases: publicAliases,
    stats: {
      total: aliases.length,
      active: aliases.filter((a) => a.active !== false).length
    },
    storage: {
      mode: USE_SUPABASE_STORAGE ? 'supabase' : 'json',
      supabaseUrlHost: SUPABASE_URL ? new URL(SUPABASE_URL).host : null,
      instanceId: MODULE_INSTANCE_ID,
      tables: {
        aliases: SUPABASE_TABLE_ALIASES
      }
    }
  };
}

async function deleteAlias(address) {
  const addrParam = decodeURIComponent(address || '').toLowerCase();
  if (USE_SUPABASE_STORAGE) {
    const client = getSupabaseAdmin();
    if (client) {
      const now = new Date().toISOString();
      const { error } = await client
        .from(SUPABASE_TABLE_ALIASES)
        .update({ active: false, last_used_at: now })
        .eq('address', addrParam);
      if (error) log('error', 'Supabase alias deactivate failed', { error: error.message });
    }
  } else {
    const aliases = await loadAliases();
    const updated = aliases.map((a) => {
      if (a.address !== addrParam) return a;
      if (a.active === false) return a;
      return { ...a, active: false, lastUsedAt: new Date().toISOString() };
    });
    await saveAliases(updated);
  }
  await auditLog('alias_deleted', { address: addrParam });
  return { removed: 1 };
}

async function adminDomains() {
  return {
    domains: await loadDomains(),
    storage: {
      mode: USE_SUPABASE_STORAGE ? 'supabase' : 'json',
      supabaseUrlHost: SUPABASE_URL ? new URL(SUPABASE_URL).host : null,
      instanceId: MODULE_INSTANCE_ID,
      tables: {
        domains: SUPABASE_TABLE_DOMAINS
      }
    }
  };
}

async function publicDomains() {
  const domains = (await loadDomains()).filter((d) => d.active !== false);
  return { domains };
}

async function addDomain(name) {
  const trimmed = (name || '').trim().toLowerCase();
  const validation = domainSchema.safeParse(trimmed);
  if (!validation.success) throw new HttpError(400, 'Invalid domain name');

  const domains = await loadDomains();
  if (domains.find((d) => d.name === trimmed)) throw new HttpError(400, 'Domain already exists');

  const now = new Date().toISOString();
  domains.push({ name: trimmed, active: true, createdAt: now });
  await saveDomains(domains);
  await auditLog('domain_added', { domain: trimmed });
  return { ok: true };
}

async function updateDomain(name, body) {
  const nameParam = decodeURIComponent(name || '').toLowerCase();
  const domains = await loadDomains();
  const target = domains.find((d) => d.name === nameParam);
  if (!target) throw new HttpError(404, 'Domain not found');
  if (typeof body?.active === 'boolean') target.active = body.active;
  await saveDomains(domains);
  return { ok: true, domain: target };
}

async function deleteDomain(name) {
  const nameParam = decodeURIComponent(name || '').toLowerCase();
  if (USE_SUPABASE_STORAGE) {
    const client = getSupabaseAdmin();
    if (client) {
      const { error } = await client.from(SUPABASE_TABLE_DOMAINS).delete().eq('name', nameParam);
      if (error) log('error', 'Supabase domain delete failed', { error: error.message });
    }
  } else {
    const domains = await loadDomains();
    const filtered = domains.filter((d) => d.name !== nameParam);
    await saveDomains(filtered);
  }
  await auditLog('domain_deleted', { domain: nameParam });
  return { removed: 1 };
}

async function adminLogs(limit, aliasFilter) {
  const normalizedLimit = Math.min(parseInt(limit || '2000', 10) || 2000, MAX_LOGS);
  const filter = (aliasFilter || '').toLowerCase().trim();
  let logs = await loadLogs();
  if (filter) logs = logs.filter((l) => (l.alias || '').toLowerCase() === filter);
  logs.sort((a, b) => new Date(b.lastSeenAt || 0) - new Date(a.lastSeenAt || 0));
  logs = logs.slice(0, normalizedLimit);
  return {
    logs,
    storage: {
      mode: USE_SUPABASE_STORAGE ? 'supabase' : 'json',
      supabaseUrlHost: SUPABASE_URL ? new URL(SUPABASE_URL).host : null,
      instanceId: MODULE_INSTANCE_ID,
      tables: {
        logs: SUPABASE_TABLE_LOGS
      }
    }
  };
}

async function clearLogs() {
  await auditLog('logs_cleared');
  if (USE_SUPABASE_STORAGE) {
    const client = getSupabaseAdmin();
    if (client) {
      await client.from(SUPABASE_TABLE_LOGS).delete().neq('id', '');
    }
  } else {
    await saveLogs([]);
  }
  return { cleared: true };
}

async function debugStorage() {
  const supabaseUrlHost = SUPABASE_URL ? new URL(SUPABASE_URL).host : null;
  const serviceRoleClaims = (() => {
    try {
      if (!SUPABASE_SERVICE_ROLE_KEY) return null;
      const parts = String(SUPABASE_SERVICE_ROLE_KEY).split('.');
      if (parts.length < 2) return null;
      const payload = JSON.parse(decodeBase64Url(parts[1]));
      return {
        ref: payload.ref ?? null,
        role: payload.role ?? null,
        iat: payload.iat ?? null,
        exp: payload.exp ?? null
      };
    } catch {
      return null;
    }
  })();

  if (!USE_SUPABASE_STORAGE) {
    return {
      ok: true,
      instanceId: MODULE_INSTANCE_ID,
      useSupabaseStorage: false,
      supabaseUrlHost,
      serviceRoleClaims,
      tables: {
        kv: SUPABASE_KV_TABLE,
        aliases: SUPABASE_TABLE_ALIASES,
        domains: SUPABASE_TABLE_DOMAINS,
        logs: SUPABASE_TABLE_LOGS,
        audit: SUPABASE_TABLE_AUDIT
      },
      computed: {
        loadAliasesCount: (await loadAliases()).length,
        loadDomainsCount: (await loadDomains()).length
      }
    };
  }

  const client = getSupabaseAdmin();
  const result = {
    ok: true,
    instanceId: MODULE_INSTANCE_ID,
    useSupabaseStorage: true,
    supabaseUrlHost,
    serviceRoleClaims,
    supabaseClient: {
      restUrl: client?.rest?.url ?? null
    },
    tables: {
      kv: SUPABASE_KV_TABLE,
      aliases: SUPABASE_TABLE_ALIASES,
      aliasTokens: SUPABASE_TABLE_ALIAS_TOKENS,
      domains: SUPABASE_TABLE_DOMAINS,
      logs: SUPABASE_TABLE_LOGS,
      messages: SUPABASE_TABLE_MESSAGES,
      audit: SUPABASE_TABLE_AUDIT
    },
    checks: {
      kv: { ok: false },
      aliases: { ok: false },
      domains: { ok: false },
      messages: { ok: false }
    },
    computed: {
      loadAliasesCount: null,
      loadAliasesSample: [],
      loadDomainsCount: null,
      loadDomainsSample: [],
      supabaseSelectAll: {
        aliasesLen: null,
        aliasesFirst: null,
        domainsLen: null,
        domainsFirst: null
      }
    }
  };

  {
    const aliases = await loadAliases();
    result.computed.loadAliasesCount = aliases.length;
    result.computed.loadAliasesSample = aliases.slice(0, 3).map((alias) => ({
      address: alias.address,
      active: alias.active,
      tokenCount: alias.tokens?.length || 0
    }));
  }

  {
    const domains = await loadDomains();
    result.computed.loadDomainsCount = domains.length;
    result.computed.loadDomainsSample = domains.slice(0, 3);
  }

  {
    const rawAliases = await supabaseSelectAll(SUPABASE_TABLE_ALIASES, 'created_at');
    result.computed.supabaseSelectAll.aliasesLen = rawAliases ? rawAliases.length : null;
    const first = rawAliases?.[0];
    result.computed.supabaseSelectAll.aliasesFirst = first ? {
      address: first.address,
      active: first.active
    } : null;
  }

  {
    const rawDomains = await supabaseSelectAll(SUPABASE_TABLE_DOMAINS, 'created_at');
    result.computed.supabaseSelectAll.domainsLen = rawDomains ? rawDomains.length : null;
    result.computed.supabaseSelectAll.domainsFirst = rawDomains?.[0] ?? null;
  }

  {
    const { error } = await client.from(SUPABASE_KV_TABLE).select('key').limit(1);
    result.checks.kv.ok = !error;
    result.checks.kv.error = error?.message || null;
  }

  {
    const { data, error } = await client
      .from(SUPABASE_TABLE_ALIASES)
      .select('address,active,created_at,last_used_at,hits')
      .order('created_at', { ascending: false })
      .limit(10);
    result.checks.aliases.ok = !error;
    result.checks.aliases.error = error?.message || null;
    result.checks.aliases.sample = (data || []).map((r) => ({
      address: r.address,
      active: typeof r.active === 'boolean' ? r.active : null,
      created_at: r.created_at ?? null,
      last_used_at: r.last_used_at ?? null,
      hits: typeof r.hits === 'number' ? r.hits : null
    }));

    const { count, error: countError } = await client
      .from(SUPABASE_TABLE_ALIASES)
      .select('*', { count: 'exact', head: true });
    result.checks.aliases.count = count ?? null;
    result.checks.aliases.countError = countError?.message || null;
  }

  {
    const { data, error } = await client.from(SUPABASE_TABLE_DOMAINS).select('*').limit(10);
    result.checks.domains.ok = !error;
    result.checks.domains.error = error?.message || null;
    result.checks.domains.sample = (data || []).map((r) => ({
      name: r.name,
      active: typeof r.active === 'boolean' ? r.active : null,
      created_at: r.created_at ?? null
    }));

    const { count, error: countError } = await client
      .from(SUPABASE_TABLE_DOMAINS)
      .select('*', { count: 'exact', head: true });
    result.checks.domains.count = count ?? null;
    result.checks.domains.countError = countError?.message || null;
  }

  {
    const { data, error } = await client
      .from(SUPABASE_TABLE_MESSAGES)
      .select('id,alias,from_email,subject,created_at,source')
      .order('created_at', { ascending: false })
      .limit(10);
    result.checks.messages.ok = !error;
    result.checks.messages.error = error?.message || null;
    result.checks.messages.sample = data || [];

    const { count, error: countError } = await client
      .from(SUPABASE_TABLE_MESSAGES)
      .select('*', { count: 'exact', head: true });
    result.checks.messages.count = count ?? null;
    result.checks.messages.countError = countError?.message || null;
  }

  return result;
}

// ========== UI THEME ==========
const UI_CONFIG_PATH = path.join(DATA_DIR, 'ui-config.json');
const VALID_THEMES = new Set(['blue', 'dark', 'green', 'rose', 'amber']);

async function getUiTheme() {
  try {
    const config = await loadJson(UI_CONFIG_PATH, {});
    const theme = config?.theme;
    return typeof theme === 'string' && VALID_THEMES.has(theme) ? theme : 'blue';
  } catch {
    return 'blue';
  }
}

async function setUiTheme(themeId) {
  const safe = typeof themeId === 'string' && VALID_THEMES.has(themeId) ? themeId : 'blue';
  const config = await loadJson(UI_CONFIG_PATH, {});
  config.theme = safe;
  await saveJson(UI_CONFIG_PATH, config);
  return { ok: true, theme: safe };
}

export {
  HttpError,
  env,
  health,
  tokenHealth,
  generateAuthUrl,
  exchangeCode,
  revokeToken,
  listMessages,
  getMessageDetail,
  adminCreateAlias,
  createAliasToken,
  listAliasTokens,
  revokeAliasToken,
  adminStats,
  adminAliases,
  updateAlias,
  deleteAlias,
  adminDomains,
  publicDomains,
  addDomain,
  updateDomain,
  deleteDomain,
  adminLogs,
  clearLogs,
  debugStorage,
  requireAdmin,
  getUiTheme,
  setUiTheme,
  invalidateMessageCache,
  subscribeNewMail,
  unsubscribeNewMail,
  notifyNewMail,
  ingestCloudflareEmail,
  cloudflareEmailWebhookHealth,
  ensureToken,
  createAccessSession,
  requireAccessSession,
  checkAccessRateLimit,
  getAccessCookieOptions
};
