'use strict';

/**
 * DB Query Tool - Express Server
 * Supports MySQL and PostgreSQL
 * Each query creates a fresh connection and releases it immediately.
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const initSqlJs = require('sql.js');
const mysql = require('mysql2/promise');
const { Client: PgClient } = require('pg');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const fetch = require('node-fetch');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3001;
const QUERY_TIMEOUT_MS = 30000; // 30 seconds
const APP_DB_PATH = process.env.APP_DB_PATH || path.join(__dirname, 'app.sqlite');
const SESSION_DAYS = 7;
let appDb = null;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Creates and verifies a MySQL connection.
 * @param {object} config - Connection config {host, port, database, username, password}
 * @returns {Promise<mysql.Connection>}
 */
async function createMysqlConnection(config) {
  const conn = await mysql.createConnection({
    host: config.host,
    port: parseInt(config.port, 10) || 3306,
    database: config.database || undefined,
    user: config.username,
    password: config.password,
    connectTimeout: QUERY_TIMEOUT_MS,
    multipleStatements: false,
    timezone: '+00:00',
  });
  return conn;
}

/**
 * Creates and verifies a PostgreSQL connection.
 * @param {object} config - Connection config {host, port, database, username, password}
 * @returns {Promise<PgClient>}
 */
async function createPgConnection(config) {
  const client = new PgClient({
    host: config.host,
    port: parseInt(config.port, 10) || 5432,
    database: config.database || 'postgres',
    user: config.username,
    password: config.password,
    connectionTimeoutMillis: QUERY_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
  });
  await client.connect();
  return client;
}

/**
 * Executes a single SQL statement on MySQL and returns normalised result.
 * @param {mysql.Connection} conn
 * @param {string} sql
 * @returns {Promise<{columns: string[], rows: any[]}>}
 */
async function runMysqlStatement(conn, sql) {
  const [rows, fields] = await conn.query({ sql, timeout: QUERY_TIMEOUT_MS });

  if (!fields || !Array.isArray(fields)) {
    // DDL / DML without result set
    return {
      columns: ['affectedRows', 'insertId', 'message'],
      rows: [
        {
          affectedRows: rows.affectedRows ?? 0,
          insertId: rows.insertId ?? 0,
          message: rows.message ?? 'OK',
        },
      ],
      isDml: true,
    };
  }

  const columns = fields.map((f) => f.name);
  const serializedRows = rows.map((row) =>
    Object.fromEntries(
      columns.map((col) => [col, serializeValue(row[col])])
    )
  );
  return { columns, rows: serializedRows, isDml: false };
}

/**
 * Executes a single SQL statement on PostgreSQL and returns normalised result.
 * @param {PgClient} client
 * @param {string} sql
 * @returns {Promise<{columns: string[], rows: any[]}>}
 */
async function runPgStatement(client, sql) {
  const result = await client.query(sql);

  if (!result.fields || result.fields.length === 0) {
    return {
      columns: ['affectedRows', 'command', 'message'],
      rows: [
        {
          affectedRows: result.rowCount ?? 0,
          command: result.command ?? 'OK',
          message: `${result.command ?? 'OK'} ${result.rowCount ?? 0}`,
        },
      ],
      isDml: true,
    };
  }

  const columns = result.fields.map((f) => f.name);
  const serializedRows = result.rows.map((row) =>
    Object.fromEntries(
      columns.map((col) => [col, serializeValue(row[col])])
    )
  );
  return { columns, rows: serializedRows, isDml: false };
}

/**
 * Serialize special JS types to JSON-safe values.
 * @param {any} val
 * @returns {any}
 */
function serializeValue(val) {
  if (val === null || val === undefined) return null;
  if (val instanceof Date) return val.toISOString();
  if (Buffer.isBuffer(val)) return val.toString('hex');
  if (typeof val === 'bigint') return val.toString();
  if (typeof val === 'object') {
    try {
      return JSON.parse(JSON.stringify(val));
    } catch {
      return String(val);
    }
  }
  return val;
}

/**
 * Splits a SQL script into individual statements (by semicolon),
 * filtering out empty lines and comment-only blocks.
 * @param {string} script
 * @returns {string[]}
 */
function splitStatements(script) {
  // Split on semicolons that are not inside string literals (simple heuristic)
  const raw = script.split(';');
  return raw
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.replace(/--[^\n]*/g, '').trim() === false);
}

function dbRun(sql, params = []) {
  appDb.run(sql, params);
}

function dbAll(sql, params = []) {
  const stmt = appDb.prepare(sql, params);
  const rows = [];
  try {
    while (stmt.step()) rows.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return rows;
}

function dbGet(sql, params = []) {
  return dbAll(sql, params)[0] || null;
}

function saveAppDb() {
  if (!appDb) return;
  fs.writeFileSync(APP_DB_PATH, Buffer.from(appDb.export()));
}

function createId() {
  return `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
}

function jsonParse(value, fallback = null) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
  return { salt, hash };
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return Object.fromEntries(header.split(';').map((part) => {
    const index = part.indexOf('=');
    if (index === -1) return null;
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(Boolean));
}

function setSessionCookie(res, sid) {
  res.setHeader('Set-Cookie', `sid=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 24 * 60 * 60}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

function createSession(userId) {
  const id = crypto.randomBytes(24).toString('hex');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  dbRun('INSERT INTO sessions (id, userId, expiresAt, createdAt) VALUES (?, ?, ?, ?)', [id, userId, expiresAt, now.toISOString()]);
  saveAppDb();
  return id;
}

function getRequestUser(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  const session = dbGet(
    `SELECT sessions.id as sessionId, users.id, users.username
     FROM sessions JOIN users ON users.id = sessions.userId
     WHERE sessions.id = ? AND sessions.expiresAt > ?`,
    [sid, new Date().toISOString()]
  );
  return session ? { id: session.id, username: session.username, sessionId: session.sessionId } : null;
}

function requireAuth(req, res, next) {
  const user = getRequestUser(req);
  if (!user) return res.status(401).json({ success: false, error: 'Authentication required' });
  req.user = user;
  return next();
}

async function initAppDb() {
  const SQL = await initSqlJs();
  const bytes = fs.existsSync(APP_DB_PATH) ? fs.readFileSync(APP_DB_PATH) : null;
  appDb = bytes ? new SQL.Database(bytes) : new SQL.Database();
  dbRun('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, passwordHash TEXT NOT NULL, passwordSalt TEXT NOT NULL, createdAt TEXT NOT NULL)');
  dbRun('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, userId TEXT NOT NULL, expiresAt TEXT NOT NULL, createdAt TEXT NOT NULL)');
  dbRun('CREATE TABLE IF NOT EXISTS db_connections (id TEXT PRIMARY KEY, userId TEXT NOT NULL, type TEXT NOT NULL, host TEXT NOT NULL, port TEXT, databaseName TEXT, username TEXT NOT NULL, password TEXT, label TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)');
  dbRun('CREATE TABLE IF NOT EXISTS smtp_configs (userId TEXT PRIMARY KEY, configJson TEXT NOT NULL, updatedAt TEXT NOT NULL)');
  dbRun('CREATE TABLE IF NOT EXISTS wechat_robots (id TEXT PRIMARY KEY, userId TEXT NOT NULL, name TEXT NOT NULL, webhookUrl TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)');
  dbRun('CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, userId TEXT NOT NULL, entryJson TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL)');
  dbRun('CREATE TABLE IF NOT EXISTS schedule_logs (id TEXT PRIMARY KEY, userId TEXT NOT NULL, scheduleId TEXT NOT NULL, logJson TEXT NOT NULL, startedAt TEXT NOT NULL)');
  dbRun('DELETE FROM sessions WHERE expiresAt <= ?', [new Date().toISOString()]);
  saveAppDb();
}

function connectionFromRow(row) {
  return {
    id: row.id,
    type: row.type,
    host: row.host,
    port: row.port || '',
    database: row.databaseName || '',
    username: row.username,
    password: row.password || '',
    label: row.label || `${row.type}://${row.host}/${row.databaseName || '*'}`,
  };
}

function getUserSmtpConfig(userId) {
  const row = dbGet('SELECT configJson FROM smtp_configs WHERE userId = ?', [userId]);
  return row ? jsonParse(row.configJson, null) : null;
}

function loadPersistedSchedules() {
  for (const [, entry] of scheduledTasks) stopScheduleTask(entry);
  scheduledTasks.clear();
  const rows = dbAll('SELECT entryJson FROM schedules');
  for (const row of rows) {
    const entry = jsonParse(row.entryJson, null);
    if (!entry) continue;
    entry.task = scheduleCronTask(entry);
    scheduledTasks.set(entry.id, entry);
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.post('/api/auth/register', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!username || password.length < 6) {
    return res.status(400).json({ success: false, error: 'Username and password with at least 6 characters are required' });
  }
  if (dbGet('SELECT id FROM users WHERE username = ?', [username])) {
    return res.status(409).json({ success: false, error: 'Username already exists' });
  }
  const id = createId();
  const now = new Date().toISOString();
  const { salt, hash } = hashPassword(password);
  dbRun('INSERT INTO users (id, username, passwordHash, passwordSalt, createdAt) VALUES (?, ?, ?, ?, ?)', [id, username, hash, salt, now]);
  const sid = createSession(id);
  saveAppDb();
  setSessionCookie(res, sid);
  return res.json({ success: true, user: { id, username } });
});

app.post('/api/auth/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const user = dbGet('SELECT * FROM users WHERE username = ?', [username]);
  if (!user) return res.status(401).json({ success: false, error: 'Invalid username or password' });
  const { hash } = hashPassword(password, user.passwordSalt);
  if (hash !== user.passwordHash) return res.status(401).json({ success: false, error: 'Invalid username or password' });
  const sid = createSession(user.id);
  setSessionCookie(res, sid);
  return res.json({ success: true, user: { id: user.id, username: user.username } });
});

app.post('/api/auth/logout', (req, res) => {
  const sid = parseCookies(req).sid;
  if (sid) {
    dbRun('DELETE FROM sessions WHERE id = ?', [sid]);
    saveAppDb();
  }
  clearSessionCookie(res);
  return res.json({ success: true });
});

app.get('/api/auth/me', (req, res) => {
  const user = getRequestUser(req);
  if (!user) return res.status(401).json({ success: false, error: 'Authentication required' });
  return res.json({ success: true, user: { id: user.id, username: user.username } });
});

app.use('/api', requireAuth);

/**
 * POST /api/connect
 * Tests database connectivity.
 * Body: { type: 'mysql'|'postgresql', host, port, database, username, password }
 */
app.post('/api/connect', async (req, res) => {
  const { type, host, port, database, username, password } = req.body;

  if (!type || !host || !username) {
    return res.status(400).json({ success: false, error: 'Missing required fields: type, host, username' });
  }

  const config = { host, port, database, username, password };
  let conn = null;

  try {
    const start = Date.now();
    if (type === 'mysql') {
      conn = await createMysqlConnection(config);
      await conn.ping();
    } else if (type === 'postgresql') {
      conn = await createPgConnection(config);
      await conn.query('SELECT 1');
    } else {
      return res.status(400).json({ success: false, error: `Unsupported database type: ${type}` });
    }
    const duration = Date.now() - start;
    return res.json({ success: true, message: 'Connection successful', duration });
  } catch (err) {
    return res.json({
      success: false,
      error: `Connection failed: ${err.message}`,
      detail: err.code || null,
    });
  } finally {
    if (conn) {
      try { await conn.end(); } catch (_) { /* ignore cleanup errors */ }
    }
  }
});

/**
 * POST /api/query
 * Executes one or more SQL statements.
 * Body: { type, host, port, database, username, password, sql }
 * Returns: { success, results: [{columns, rows, rowCount, isDml}], duration, error }
 */
app.post('/api/query', async (req, res) => {
  const { type, host, port, database, username, password, sql } = req.body;

  if (!type || !host || !username || !sql) {
    return res.status(400).json({ success: false, error: 'Missing required fields: type, host, username, sql' });
  }

  const config = { host, port, database, username, password };
  const statements = splitStatements(sql);

  if (statements.length === 0) {
    return res.status(400).json({ success: false, error: 'No valid SQL statements found' });
  }

  let conn = null;
  const start = Date.now();

  try {
    if (type === 'mysql') {
      conn = await createMysqlConnection(config);
    } else if (type === 'postgresql') {
      conn = await createPgConnection(config);
    } else {
      return res.status(400).json({ success: false, error: `Unsupported database type: ${type}` });
    }

    const results = [];
    for (const stmt of statements) {
      let stmtResult;
      if (type === 'mysql') {
        stmtResult = await runMysqlStatement(conn, stmt);
      } else {
        stmtResult = await runPgStatement(conn, stmt);
      }
      results.push({
        sql: stmt.length > 200 ? stmt.substring(0, 200) + '...' : stmt,
        columns: stmtResult.columns,
        rows: stmtResult.rows,
        rowCount: stmtResult.rows.length,
        isDml: stmtResult.isDml,
      });
    }

    const duration = Date.now() - start;
    return res.json({ success: true, results, duration, statementCount: results.length });
  } catch (err) {
    const duration = Date.now() - start;
    return res.json({
      success: false,
      error: err.message,
      code: err.code || null,
      detail: err.detail || null,
      duration,
    });
  } finally {
    if (conn) {
      try { await conn.end(); } catch (_) { /* ignore */ }
    }
  }
});

/**
 * GET /api/tables
 * Lists tables in the connected database.
 * Query params: type, host, port, database, username, password
 */
app.get('/api/tables', async (req, res) => {
  const { type, host, port, database, username, password } = req.query;

  if (!type || !host || !username) {
    return res.status(400).json({ success: false, error: 'Missing required query params' });
  }

  const config = { host, port, database, username, password };
  let conn = null;

  try {
    let tables = [];
    if (type === 'mysql') {
      conn = await createMysqlConnection(config);
      const [rows] = await conn.query(
        `SELECT TABLE_NAME as tableName, TABLE_TYPE as tableType, TABLE_ROWS as tableRows
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE()
         ORDER BY TABLE_TYPE, TABLE_NAME`
      );
      tables = rows.map((r) => ({
        name: r.tableName,
        type: r.tableType === 'VIEW' ? 'view' : 'table',
        rows: r.tableRows,
      }));
    } else if (type === 'postgresql') {
      conn = await createPgConnection(config);
      const result = await conn.query(
        `SELECT table_name as "tableName", table_type as "tableType"
         FROM information_schema.tables
         WHERE table_schema = 'public'
         ORDER BY table_type, table_name`
      );
      tables = result.rows.map((r) => ({
        name: r.tableName,
        type: r.tableType === 'VIEW' ? 'view' : 'table',
        rows: null,
      }));
    } else {
      return res.status(400).json({ success: false, error: `Unsupported database type: ${type}` });
    }

    return res.json({ success: true, tables });
  } catch (err) {
    return res.json({ success: false, error: err.message, code: err.code || null });
  } finally {
    if (conn) {
      try { await conn.end(); } catch (_) { /* ignore */ }
    }
  }
});

/**
 * GET /api/table/:name/schema
 * Returns column definitions for a given table.
 * Query params: type, host, port, database, username, password
 */
app.get('/api/table/:name/schema', async (req, res) => {
  const tableName = req.params.name;
  const { type, host, port, database, username, password } = req.query;

  if (!type || !host || !username) {
    return res.status(400).json({ success: false, error: 'Missing required query params' });
  }

  const config = { host, port, database, username, password };
  let conn = null;

  try {
    let columns = [];
    if (type === 'mysql') {
      conn = await createMysqlConnection(config);
      const [rows] = await conn.query(
        `SELECT COLUMN_NAME as columnName,
                COLUMN_TYPE as columnType,
                IS_NULLABLE as isNullable,
                COLUMN_KEY as columnKey,
                COLUMN_DEFAULT as columnDefault,
                EXTRA as extra
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`,
        [tableName]
      );
      columns = rows.map((r) => ({
        name: r.columnName,
        type: r.columnType,
        nullable: r.isNullable === 'YES',
        key: r.columnKey,
        default: r.columnDefault,
        extra: r.extra,
      }));
    } else if (type === 'postgresql') {
      conn = await createPgConnection(config);
      const result = await conn.query(
        `SELECT column_name as "columnName",
                data_type as "dataType",
                character_maximum_length as "maxLength",
                is_nullable as "isNullable",
                column_default as "columnDefault"
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1
         ORDER BY ordinal_position`,
        [tableName]
      );
      columns = result.rows.map((r) => ({
        name: r.columnName,
        type: r.maxLength ? `${r.dataType}(${r.maxLength})` : r.dataType,
        nullable: r.isNullable === 'YES',
        key: null,
        default: r.columnDefault,
        extra: null,
      }));
    } else {
      return res.status(400).json({ success: false, error: `Unsupported database type: ${type}` });
    }

    return res.json({ success: true, table: tableName, columns });
  } catch (err) {
    return res.json({ success: false, error: err.message, code: err.code || null });
  } finally {
    if (conn) {
      try { await conn.end(); } catch (_) { /* ignore */ }
    }
  }
});

// ─── Scheduled Tasks Storage (in-memory) ──────────────────────────────────────
const scheduledTasks = new Map(); // id -> { id, name, cron, task, connectionInfo, sql, sendType, emailTo, emailSubject, wechatWebhook, createdAt, updatedAt }
const scheduleExecutionLogs = new Map(); // id -> [{ id, scheduleId, taskName, triggerType, status, startedAt, endedAt, durationMs, rowCount, message, error }]
const MAX_SCHEDULE_LOGS = 100;

// ─── SMTP Config File Helpers ─────────────────────────────────────────────────
const SMTP_CONFIG_PATH = path.join(__dirname, 'smtp-config.json');
const WECHAT_ROBOTS_PATH = path.join(__dirname, 'wechat-robots.json');

/**
 * Loads SMTP config from file.
 * @returns {object|null}
 */
function loadSmtpConfig() {
  try {
    if (!fs.existsSync(SMTP_CONFIG_PATH)) return null;
    const raw = fs.readFileSync(SMTP_CONFIG_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Saves SMTP config to file.
 * @param {object} config
 */
function saveSmtpConfig(config) {
  fs.writeFileSync(SMTP_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

function loadWechatRobots() {
  try {
    if (!fs.existsSync(WECHAT_ROBOTS_PATH)) return [];
    const raw = fs.readFileSync(WECHAT_ROBOTS_PATH, 'utf-8');
    const robots = JSON.parse(raw);
    return Array.isArray(robots) ? robots : [];
  } catch {
    return [];
  }
}

function saveWechatRobots(robots) {
  fs.writeFileSync(WECHAT_ROBOTS_PATH, JSON.stringify(robots, null, 2), 'utf-8');
}

function maskWebhookUrl(url) {
  if (!url) return '';
  return url.replace(/([?&]key=)([^&]+)/, (_, prefix, key) => {
    if (key.length <= 8) return `${prefix}****`;
    return `${prefix}${key.slice(0, 4)}****${key.slice(-4)}`;
  });
}

function toWechatRobotResponse(robot, includeWebhook = false) {
  return {
    id: robot.id,
    name: robot.name,
    webhookUrl: includeWebhook ? robot.webhookUrl : maskWebhookUrl(robot.webhookUrl),
    createdAt: robot.createdAt,
    updatedAt: robot.updatedAt || robot.createdAt,
  };
}

// ─── XLSX Buffer Generation ──────────────────────────────────────────────────

/**
 * Generates an XLSX file as a Buffer from columns and rows.
 * @param {string[]} columns
 * @param {object[]} rows
 * @param {string} sheetName
 * @returns {Buffer}
 */
function generateXlsxBuffer(columns, rows, sheetName = 'Sheet1') {
  const wsData = [columns.map(String)];
  for (const row of rows) {
    wsData.push(columns.map((col) => {
      const v = row[col];
      if (v === null || v === undefined) return '';
      if (typeof v === 'object') return JSON.stringify(v);
      return v;
    }));
  }
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const colWidths = columns.map((col, ci) => {
    const maxLen = Math.max(
      col.length,
      ...wsData.slice(1).map((r) => String(r[ci] ?? '').length).slice(0, 200)
    );
    return { wch: Math.min(50, Math.max(8, maxLen + 2)) };
  });
  ws['!cols'] = colWidths;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName.substring(0, 31));
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ─── Internal Query Runner ────────────────────────────────────────────────────

/**
 * Executes a query using the given connectionInfo and SQL.
 * Returns the first result set (for send purposes).
 * @param {object} connectionInfo - { type, host, port, database, username, password }
 * @param {string} sql
 * @returns {Promise<{columns, rows, rowCount}>}
 */
async function executeQueryInternal(connectionInfo, sql) {
  const config = {
    host: connectionInfo.host,
    port: connectionInfo.port,
    database: connectionInfo.database,
    username: connectionInfo.username,
    password: connectionInfo.password,
  };
  let conn = null;
  try {
    if (connectionInfo.type === 'mysql') {
      conn = await createMysqlConnection(config);
    } else if (connectionInfo.type === 'postgresql') {
      conn = await createPgConnection(config);
    } else {
      throw new Error(`Unsupported database type: ${connectionInfo.type}`);
    }
    const statements = splitStatements(sql);
    const results = [];
    for (const stmt of statements) {
      let stmtResult;
      if (connectionInfo.type === 'mysql') {
        stmtResult = await runMysqlStatement(conn, stmt);
      } else {
        stmtResult = await runPgStatement(conn, stmt);
      }
      results.push(stmtResult);
    }
    // Return the last non-DML result, or the last result if all are DML
    const lastNonDml = [...results].reverse().find((r) => !r.isDml);
    const chosen = lastNonDml || results[results.length - 1];
    return { columns: chosen.columns, rows: chosen.rows, rowCount: chosen.rows.length };
  } finally {
    if (conn) {
      try { await conn.end(); } catch (_) { /* ignore */ }
    }
  }
}

// ─── Email Sending ────────────────────────────────────────────────────────────

/**
 * Sends an email with XLSX attachment via SMTP.
 * @param {object} opts - { to, subject, xlsxBuffer, filename }
 */
async function sendEmailWithXlsx({ to, subject, xlsxBuffer, filename, userId }) {
  const smtpConfig = userId ? getUserSmtpConfig(userId) : loadSmtpConfig();
  if (!smtpConfig) throw new Error('SMTP not configured. Please save SMTP settings first.');

  const transporter = nodemailer.createTransport({
    host: smtpConfig.host,
    port: parseInt(smtpConfig.port, 10) || 465,
    secure: !!smtpConfig.secure,
    auth: { user: smtpConfig.user, pass: smtpConfig.pass },
  });

  await transporter.sendMail({
    from: `"${smtpConfig.fromName || 'DB Query Tool'}" <${smtpConfig.fromEmail || smtpConfig.user}>`,
    to,
    subject,
    html: '<p>查询结果见附件。</p><p><em>— DB Query Tool</em></p>',
    attachments: [
      {
        filename,
        content: xlsxBuffer,
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    ],
  });
}

// ─── WeChat Work Webhook ─────────────────────────────────────────────────────

/**
 * Extracts the key from a WeChat Work webhook URL.
 * Supports formats:
 *   https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx
 *   https://qyapi.weixin.qq.com/cgi-bin/webhook/upload_media?key=xxx&type=file
 *   /mcp/robot-doc?apikey=xxx  (user's mistaken format, will warn)
 * @param {string} url
 * @returns {string|null}
 */
function extractWechatKey(url) {
  if (!url) return null;
  // Standard format: ?key=xxx
  const keyMatch = url.match(/[?&]key=([a-zA-Z0-9_-]+)/);
  if (keyMatch) return keyMatch[1];
  // Common mistake: ?apikey=xxx
  const apikeyMatch = url.match(/[?&]apikey=([a-zA-Z0-9_-]+)/);
  if (apikeyMatch) return null; // will trigger format warning
  return null;
}

/**
 * Sends a query result as an XLSX file to WeChat Work robot webhook.
 * 1. Generate XLSX buffer
 * 2. Upload via upload_media API to get media_id
 * 3. Send file message with media_id
 * Also sends a text summary as a companion message.
 * @param {object} opts - { webhookUrl, columns, rows, rowCount, sql, taskName? }
 */
async function sendWechatNotification({ webhookUrl, columns, rows, rowCount, sql, taskName }) {
  const key = extractWechatKey(webhookUrl);

  if (!key) {
    // Check if user provided a non-standard URL
    if (webhookUrl.includes('apikey=') || webhookUrl.includes('/mcp/robot-doc')) {
      throw new Error('Webhook URL 格式不正确。请使用格式: https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=你的key\n当前提供的地址是机器人配置页面，不是发送接口。请在企微群机器人设置中复制 Webhook 地址。');
    }
    throw new Error('无法从 Webhook URL 中提取 key，请检查 URL 格式。正确格式: https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx');
  }

  const sendUrl = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${key}`;
  const uploadUrl = `https://qyapi.weixin.qq.com/cgi-bin/webhook/upload_media?key=${key}&type=file`;

  // 1. Generate XLSX buffer
  const xlsxBuffer = generateXlsxBuffer(columns, rows, 'Sheet1');
  const fileName = `${(taskName || 'query_result').replace(/[^a-zA-Z0-9_\u4e00-\u9fff-]/g, '_')}.xlsx`;

  // 2. Upload file to get media_id
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', xlsxBuffer, {
    filename: fileName,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

  const uploadResp = await fetch(uploadUrl, {
    method: 'POST',
    body: form,
    headers: form.getHeaders(),
  });

  const uploadResult = await uploadResp.json();
  if (uploadResult.errcode && uploadResult.errcode !== 0) {
    throw new Error(`企微文件上传失败: ${uploadResult.errmsg || JSON.stringify(uploadResult)}`);
  }

  const mediaId = uploadResult.media_id;
  if (!mediaId) {
    throw new Error(`企微文件上传未返回 media_id: ${JSON.stringify(uploadResult)}`);
  }

  // 3. Send file message
  const fileResp = await fetch(sendUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      msgtype: 'file',
      file: { media_id: mediaId },
    }),
  });

  const fileResult = await fileResp.json();
  if (fileResult.errcode && fileResult.errcode !== 0) {
    throw new Error(`企微文件发送失败: ${fileResult.errmsg || JSON.stringify(fileResult)}`);
  }

  // 4. Send a companion text summary
  let textContent = `📊 数据库查询结果\n`;
  if (taskName) textContent += `任务: ${taskName}\n`;
  textContent += `SQL: ${sql.substring(0, 100)}${sql.length > 100 ? '...' : ''}\n`;
  textContent += `总行数: ${rowCount}\n`;
  textContent += `详情见附件 Excel 文件`;

  await fetch(sendUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      msgtype: 'text',
      text: { content: textContent },
    }),
  });
}

function validateSchedulePayload(payload) {
  const { name, cron: cronExpr, connectionInfo, sql, sendType, emailTo, wechatWebhook } = payload;

  if (!name || !cronExpr || !connectionInfo || !sql || !sendType) {
    return 'Missing required fields: name, cron, connectionInfo, sql, sendType';
  }
  if (!cron.validate(cronExpr)) {
    return `Invalid cron expression: ${cronExpr}`;
  }
  if (!['email', 'wechat', 'both'].includes(sendType)) {
    return 'sendType must be one of: email, wechat, both';
  }
  if (sendType === 'email' && !emailTo) {
    return 'emailTo is required when sendType is email';
  }
  if (sendType === 'wechat' && !wechatWebhook) {
    return 'wechatWebhook is required when sendType is wechat';
  }
  if (sendType === 'both' && (!emailTo || !wechatWebhook)) {
    return 'Both emailTo and wechatWebhook are required when sendType is both';
  }

  return null;
}

function buildScheduleEntry(id, payload, existing = {}) {
  const now = new Date().toISOString();
  const connectionLabel = payload.connectionLabel
    || payload.connectionInfo.label
    || `${payload.connectionInfo.type}://${payload.connectionInfo.host}/${payload.connectionInfo.database || '*'}`;
  return {
    id,
    userId: payload.userId || existing.userId || '',
    name: payload.name,
    cron: payload.cron,
    connectionInfo: payload.connectionInfo,
    connectionLabel,
    sql: payload.sql,
    sendType: payload.sendType,
    emailTo: payload.emailTo || '',
    emailSubject: payload.emailSubject || `DB Query Report - ${payload.name}`,
    wechatWebhook: payload.wechatWebhook || '',
    wechatRobotId: payload.wechatRobotId || '',
    wechatRobotName: payload.wechatRobotName || '',
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
}

function toScheduleSummary(entry) {
  return {
    id: entry.id,
    name: entry.name,
    cron: entry.cron,
    sendType: entry.sendType,
    connectionLabel: entry.connectionLabel || entry.connectionInfo.label || `${entry.connectionInfo.type}://${entry.connectionInfo.host}/${entry.connectionInfo.database || '*'}`,
    emailTo: entry.emailTo || '',
    wechatWebhook: entry.wechatWebhook ? '****configured' : '',
    wechatRobotId: entry.wechatRobotId || '',
    wechatRobotName: entry.wechatRobotName || '',
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt || entry.createdAt,
    lastLog: getScheduleLogs(entry.id, entry.userId)[0] || null,
  };
}

function toScheduleDetail(entry) {
  return {
    id: entry.id,
    name: entry.name,
    cron: entry.cron,
    connectionInfo: entry.connectionInfo,
    connectionLabel: entry.connectionLabel || entry.connectionInfo.label || `${entry.connectionInfo.type}://${entry.connectionInfo.host}/${entry.connectionInfo.database || '*'}`,
    sql: entry.sql,
    sendType: entry.sendType,
    emailTo: entry.emailTo || '',
    emailSubject: entry.emailSubject || '',
    wechatWebhook: entry.wechatWebhook || '',
    wechatRobotId: entry.wechatRobotId || '',
    wechatRobotName: entry.wechatRobotName || '',
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt || entry.createdAt,
  };
}

function getScheduleLogs(scheduleId, userId = null) {
  if (!appDb) return scheduleExecutionLogs.get(scheduleId) || [];
  const rows = userId
    ? dbAll('SELECT logJson FROM schedule_logs WHERE scheduleId = ? AND userId = ? ORDER BY startedAt DESC LIMIT ?', [scheduleId, userId, MAX_SCHEDULE_LOGS])
    : dbAll('SELECT logJson FROM schedule_logs WHERE scheduleId = ? ORDER BY startedAt DESC LIMIT ?', [scheduleId, MAX_SCHEDULE_LOGS]);
  return rows.map((row) => jsonParse(row.logJson, null)).filter(Boolean);
}

function appendScheduleLog(scheduleId, log) {
  if (appDb) {
    dbRun(
      'INSERT INTO schedule_logs (id, userId, scheduleId, logJson, startedAt) VALUES (?, ?, ?, ?, ?)',
      [log.id, log.userId || '', scheduleId, JSON.stringify(log), log.startedAt]
    );
    const rows = dbAll(
      'SELECT id FROM schedule_logs WHERE scheduleId = ? AND userId = ? ORDER BY startedAt DESC LIMIT -1 OFFSET ?',
      [scheduleId, log.userId || '', MAX_SCHEDULE_LOGS]
    );
    rows.forEach((row) => dbRun('DELETE FROM schedule_logs WHERE id = ?', [row.id]));
    saveAppDb();
  } else {
    const logs = scheduleExecutionLogs.get(scheduleId) || [];
    logs.unshift(log);
    if (logs.length > MAX_SCHEDULE_LOGS) logs.length = MAX_SCHEDULE_LOGS;
    scheduleExecutionLogs.set(scheduleId, logs);
  }
}

async function executeScheduleEntry(entry, triggerType) {
  const startedAt = new Date();
  const log = {
    id: `${startedAt.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    scheduleId: entry.id,
    userId: entry.userId || '',
    taskName: entry.name,
    triggerType,
    status: 'running',
    startedAt: startedAt.toISOString(),
    endedAt: null,
    durationMs: null,
    rowCount: null,
    message: '',
    error: '',
  };

  try {
    console.log(`[Schedule:${entry.id}] ${triggerType} executing task "${entry.name}"...`);
    const queryResult = await executeQueryInternal(entry.connectionInfo, entry.sql);

    if (entry.sendType === 'email' || entry.sendType === 'both') {
      const xlsxBuffer = generateXlsxBuffer(queryResult.columns, queryResult.rows, 'Sheet1');
      await sendEmailWithXlsx({
        to: entry.emailTo,
        subject: entry.emailSubject || `DB Query Report - ${entry.name}`,
        xlsxBuffer,
        filename: `${entry.name.replace(/[^a-zA-Z0-9_\u4e00-\u9fff-]/g, '_')}.xlsx`,
        userId: entry.userId,
      });
      console.log(`[Schedule:${entry.id}] Email sent to ${entry.emailTo}`);
    }

    if (entry.sendType === 'wechat' || entry.sendType === 'both') {
      await sendWechatNotification({
        webhookUrl: entry.wechatWebhook,
        columns: queryResult.columns,
        rows: queryResult.rows,
        rowCount: queryResult.rowCount,
        sql: entry.sql,
        taskName: entry.name,
      });
      console.log(`[Schedule:${entry.id}] WeChat notification sent`);
    }

    log.status = 'success';
    log.rowCount = queryResult.rowCount;
    log.message = `Executed successfully, ${queryResult.rowCount} rows sent`;
  } catch (err) {
    log.status = 'failed';
    log.error = err.message;
    log.message = `Execution failed: ${err.message}`;
    console.error(`[Schedule:${entry.id}] ${triggerType} execution failed: ${err.message}`);
  } finally {
    const endedAt = new Date();
    log.endedAt = endedAt.toISOString();
    log.durationMs = endedAt.getTime() - startedAt.getTime();
    appendScheduleLog(entry.id, log);
  }

  return log;
}

function scheduleCronTask(entry) {
  return cron.schedule(entry.cron, () => {
    executeScheduleEntry(entry, 'auto').catch((err) => {
      console.error(`[Schedule:${entry.id}] Unexpected schedule error: ${err.message}`);
    });
  });
}

function stopScheduleTask(entry) {
  if (!entry || !entry.task) return;
  if (typeof entry.task.stop === 'function') entry.task.stop();
  if (typeof entry.task.destroy === 'function') entry.task.destroy();
}

// ─── New API Routes ───────────────────────────────────────────────────────────

/**
 * POST /api/send/email
 * Executes a query and sends results via email as XLSX attachment.
 * Body: { to, subject, connectionInfo, sql, filename?, sheetName? }
 */
app.post('/api/send/email', async (req, res) => {
  const { to, subject, connectionInfo, sql, filename, sheetName } = req.body;

  if (!to || !subject || !connectionInfo || !sql) {
    return res.status(400).json({ success: false, error: 'Missing required fields: to, subject, connectionInfo, sql' });
  }

  try {
    const queryResult = await executeQueryInternal(connectionInfo, sql);
    const xlsxBuffer = generateXlsxBuffer(queryResult.columns, queryResult.rows, sheetName || 'Sheet1');
    const safeFilename = (filename || 'query_result').replace(/\.xlsx$/i, '') + '.xlsx';

    await sendEmailWithXlsx({
      to,
      subject,
      xlsxBuffer,
      filename: safeFilename,
      userId: req.user.id,
    });

    return res.json({ success: true, message: `Email sent to ${to} with ${queryResult.rowCount} rows` });
  } catch (err) {
    return res.json({ success: false, error: err.message });
  }
});

/**
 * POST /api/send/wechat
 * Executes a query and sends results summary to WeChat Work webhook.
 * Body: { webhookUrl, connectionInfo, sql, filename? }
 */
app.post('/api/send/wechat', async (req, res) => {
  const { webhookUrl, wechatRobotId, connectionInfo, sql, filename } = req.body;
  let targetWebhookUrl = webhookUrl;

  if (wechatRobotId && !targetWebhookUrl) {
    const robot = dbGet('SELECT * FROM wechat_robots WHERE id = ? AND userId = ?', [wechatRobotId, req.user.id]);
    if (!robot) {
      return res.status(404).json({ success: false, error: `WeChat robot not found: ${wechatRobotId}` });
    }
    targetWebhookUrl = robot.webhookUrl;
  }

  if (!targetWebhookUrl || !connectionInfo || !sql) {
    return res.status(400).json({ success: false, error: 'Missing required fields: webhookUrl or wechatRobotId, connectionInfo, sql' });
  }

  try {
    const queryResult = await executeQueryInternal(connectionInfo, sql);

    await sendWechatNotification({
      webhookUrl: targetWebhookUrl,
      columns: queryResult.columns,
      rows: queryResult.rows,
      rowCount: queryResult.rowCount,
      sql,
      taskName: filename || 'query_result',
    });

    return res.json({ success: true, message: `企微已发送 Excel 文件（${queryResult.rowCount} 行）` });
  } catch (err) {
    return res.json({ success: false, error: err.message });
  }
});

app.get('/api/connections', (req, res) => {
  const connections = dbAll('SELECT * FROM db_connections WHERE userId = ? ORDER BY createdAt DESC', [req.user.id])
    .map(connectionFromRow);
  return res.json({ success: true, connections });
});

app.post('/api/connections', (req, res) => {
  const { type, host, port, database, username, password, label } = req.body;
  if (!type || !host || !username) {
    return res.status(400).json({ success: false, error: 'Missing required fields: type, host, username' });
  }
  const id = createId();
  const now = new Date().toISOString();
  dbRun(
    'INSERT INTO db_connections (id, userId, type, host, port, databaseName, username, password, label, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, req.user.id, type, host, port || '', database || '', username, password || '', label || `${type}://${host}/${database || '*'}`, now, now]
  );
  saveAppDb();
  const row = dbGet('SELECT * FROM db_connections WHERE id = ? AND userId = ?', [id, req.user.id]);
  return res.json({ success: true, connection: connectionFromRow(row) });
});

app.delete('/api/connections/:id', (req, res) => {
  const row = dbGet('SELECT id FROM db_connections WHERE id = ? AND userId = ?', [req.params.id, req.user.id]);
  if (!row) return res.status(404).json({ success: false, error: `Connection not found: ${req.params.id}` });
  dbRun('DELETE FROM db_connections WHERE id = ? AND userId = ?', [req.params.id, req.user.id]);
  saveAppDb();
  return res.json({ success: true });
});

/**
 * GET /api/schedules
 * Returns all scheduled tasks.
 */
app.get('/api/schedules', (req, res) => {
  const tasks = [];
  for (const [, value] of scheduledTasks) {
    if (value.userId !== req.user.id) continue;
    tasks.push(toScheduleSummary(value));
  }
  return res.json({ success: true, tasks });
});

/**
 * GET /api/schedules/:id
 * Returns one scheduled task with editable fields.
 */
app.get('/api/schedules/:id', (req, res) => {
  const entry = scheduledTasks.get(req.params.id);
  if (!entry || entry.userId !== req.user.id) {
    return res.status(404).json({ success: false, error: `Schedule not found: ${req.params.id}` });
  }
  return res.json({ success: true, task: toScheduleDetail(entry) });
});

/**
 * GET /api/schedules/:id/logs
 * Returns recent execution logs for a scheduled task.
 */
app.get('/api/schedules/:id/logs', (req, res) => {
  const entry = scheduledTasks.get(req.params.id);
  if (!entry || entry.userId !== req.user.id) {
    return res.status(404).json({ success: false, error: `Schedule not found: ${req.params.id}` });
  }
  return res.json({ success: true, logs: getScheduleLogs(req.params.id, req.user.id) });
});

/**
 * POST /api/schedules
 * Creates a new scheduled task.
 * Body: { name, cron, connectionInfo, sql, sendType, emailTo?, emailSubject?, wechatWebhook? }
 */
app.post('/api/schedules', (req, res) => {
  const validationError = validateSchedulePayload(req.body);
  if (validationError) {
    return res.status(400).json({ success: false, error: validationError });
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const taskEntry = buildScheduleEntry(id, { ...req.body, userId: req.user.id });
  taskEntry.task = scheduleCronTask(taskEntry);
  scheduledTasks.set(id, taskEntry);
  dbRun('INSERT INTO schedules (id, userId, entryJson, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)', [id, req.user.id, JSON.stringify({ ...taskEntry, task: undefined }), taskEntry.createdAt, taskEntry.updatedAt]);
  saveAppDb();

  return res.json({
    success: true,
    task: toScheduleDetail(taskEntry),
  });
});

/**
 * PUT /api/schedules/:id
 * Updates an existing scheduled task and re-registers its cron job.
 * Body: { name, cron, connectionInfo, sql, sendType, emailTo?, emailSubject?, wechatWebhook? }
 */
app.put('/api/schedules/:id', (req, res) => {
  const id = req.params.id;
  const existing = scheduledTasks.get(id);
  if (!existing || existing.userId !== req.user.id) {
    return res.status(404).json({ success: false, error: `Schedule not found: ${id}` });
  }

  const validationError = validateSchedulePayload(req.body);
  if (validationError) {
    return res.status(400).json({ success: false, error: validationError });
  }

  stopScheduleTask(existing);
  const updatedEntry = buildScheduleEntry(id, { ...req.body, userId: req.user.id }, existing);
  updatedEntry.task = scheduleCronTask(updatedEntry);
  scheduledTasks.set(id, updatedEntry);
  dbRun('UPDATE schedules SET entryJson = ?, updatedAt = ? WHERE id = ? AND userId = ?', [JSON.stringify({ ...updatedEntry, task: undefined }), updatedEntry.updatedAt, id, req.user.id]);
  saveAppDb();

  return res.json({ success: true, task: toScheduleDetail(updatedEntry) });
});

/**
 * POST /api/schedules/:id/trigger
 * Manually trigger a scheduled task immediately.
 */
app.post('/api/schedules/:id/trigger', async (req, res) => {
  const id = req.params.id;
  const entry = scheduledTasks.get(id);
  if (!entry || entry.userId !== req.user.id) {
    return res.status(404).json({ success: false, error: `Schedule not found: ${id}` });
  }

  executeScheduleEntry(entry, 'manual').catch((err) => {
    console.error(`[Schedule:${id}] Unexpected manual trigger error: ${err.message}`);
  });

  return res.json({ success: true, message: `Task "${entry.name}" triggered` });
});

/**
 * DELETE /api/schedules/:id
 * Deletes a scheduled task.
 */
app.delete('/api/schedules/:id', (req, res) => {
  const id = req.params.id;
  const entry = scheduledTasks.get(id);
  if (!entry || entry.userId !== req.user.id) {
    return res.status(404).json({ success: false, error: `Schedule not found: ${id}` });
  }
  stopScheduleTask(entry);
  scheduledTasks.delete(id);
  scheduleExecutionLogs.delete(id);
  dbRun('DELETE FROM schedules WHERE id = ? AND userId = ?', [id, req.user.id]);
  dbRun('DELETE FROM schedule_logs WHERE scheduleId = ? AND userId = ?', [id, req.user.id]);
  saveAppDb();
  return res.json({ success: true });
});

/**
 * POST /api/settings/smtp
 * Saves SMTP configuration to file.
 * Body: { host, port, secure, user, pass, fromName, fromEmail }
 */
app.post('/api/settings/smtp', (req, res) => {
  const { host, port, secure, user, pass, fromName, fromEmail } = req.body;
  if (!host || !port || !user || !pass) {
    return res.status(400).json({ success: false, error: 'Missing required fields: host, port, user, pass' });
  }
  const config = { host, port, secure: !!secure, user, pass, fromName: fromName || 'DB Query Tool', fromEmail: fromEmail || user };
  dbRun(
    'INSERT OR REPLACE INTO smtp_configs (userId, configJson, updatedAt) VALUES (?, ?, ?)',
    [req.user.id, JSON.stringify(config), new Date().toISOString()]
  );
  saveAppDb();
  return res.json({ success: true, message: 'SMTP settings saved' });
});

/**
 * GET /api/settings/smtp
 * Returns SMTP configuration with password masked.
 */
app.get('/api/settings/smtp', (req, res) => {
  const config = getUserSmtpConfig(req.user.id);
  if (!config) {
    return res.json({ success: true, config: null });
  }
  return res.json({
    success: true,
    config: {
      host: config.host,
      port: config.port,
      secure: config.secure,
      user: config.user,
      pass: config.pass ? '****' : '',
      fromName: config.fromName,
      fromEmail: config.fromEmail,
    },
  });
});

// ─── Catch-all: serve index.html ──────────────────────────────────────────────
app.get('/api/settings/wechat-robots', (req, res) => {
  const robots = dbAll('SELECT * FROM wechat_robots WHERE userId = ? ORDER BY createdAt DESC', [req.user.id])
    .map((robot) => toWechatRobotResponse(robot, true));
  return res.json({ success: true, robots });
});

app.post('/api/settings/wechat-robots', (req, res) => {
  const { name, webhookUrl } = req.body;
  if (!name || !webhookUrl) {
    return res.status(400).json({ success: false, error: 'Missing required fields: name, webhookUrl' });
  }

  const now = new Date().toISOString();
  const robot = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    webhookUrl,
    createdAt: now,
    updatedAt: now,
  };
  dbRun(
    'INSERT INTO wechat_robots (id, userId, name, webhookUrl, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
    [robot.id, req.user.id, robot.name, robot.webhookUrl, robot.createdAt, robot.updatedAt]
  );
  saveAppDb();
  return res.json({ success: true, robot: toWechatRobotResponse(robot, true) });
});

app.put('/api/settings/wechat-robots/:id', (req, res) => {
  const { name, webhookUrl } = req.body;
  if (!name || !webhookUrl) {
    return res.status(400).json({ success: false, error: 'Missing required fields: name, webhookUrl' });
  }

  const existing = dbGet('SELECT * FROM wechat_robots WHERE id = ? AND userId = ?', [req.params.id, req.user.id]);
  if (!existing) {
    return res.status(404).json({ success: false, error: `WeChat robot not found: ${req.params.id}` });
  }

  const robot = {
    ...existing,
    name,
    webhookUrl,
    updatedAt: new Date().toISOString(),
  };
  dbRun('UPDATE wechat_robots SET name = ?, webhookUrl = ?, updatedAt = ? WHERE id = ? AND userId = ?', [name, webhookUrl, robot.updatedAt, req.params.id, req.user.id]);
  saveAppDb();
  return res.json({ success: true, robot: toWechatRobotResponse(robot, true) });
});

app.delete('/api/settings/wechat-robots/:id', (req, res) => {
  const existing = dbGet('SELECT id FROM wechat_robots WHERE id = ? AND userId = ?', [req.params.id, req.user.id]);
  if (!existing) {
    return res.status(404).json({ success: false, error: `WeChat robot not found: ${req.params.id}` });
  }
  dbRun('DELETE FROM wechat_robots WHERE id = ? AND userId = ?', [req.params.id, req.user.id]);
  saveAppDb();
  return res.json({ success: true });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
function startServer(port) {
  return new Promise((resolve, reject) => {
    const srv = app.listen(port, () => {
      console.log(`\n🚀 DB Query Tool running at http://localhost:${port}`);
      console.log(`   Press Ctrl+C to stop.\n`);
      resolve(srv);
    }).on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`Port ${port} in use, trying ${port + 1}...`);
        startServer(port + 1).then(resolve, reject);
      } else {
        console.error(`\n❌ Server error: ${err.message}\n`);
        reject(err);
      }
    });
  });
}

const startPort = parseInt(PORT, 10) || 3001;
initAppDb()
  .then(() => {
    loadPersistedSchedules();
    return startServer(startPort);
  })
  .catch((err) => {
    console.error(`Failed to start application: ${err.message}`);
    process.exit(1);
  });

module.exports = app;
