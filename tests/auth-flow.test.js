const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startServer(port, dbPath) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), APP_DB_PATH: dbPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });

  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://localhost:${port}/api/auth/me`);
      if (res.status === 401) return child;
    } catch (_) {
      // not ready yet
    }
    await wait(250);
  }

  child.kill();
  throw new Error(`server did not start:\n${output}`);
}

async function request(base, pathName, options = {}, cookie = '') {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers['content-type']) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  const res = await fetch(base + pathName, { ...options, headers });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  return { res, body, cookie: res.headers.get('set-cookie') || cookie };
}

test('registered users have isolated per-user configuration', async () => {
  const port = 4301 + Math.floor(Math.random() * 200);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-query-auth-'));
  const dbPath = path.join(dir, 'app.sqlite');
  const child = await startServer(port, dbPath);
  const base = `http://localhost:${port}`;

  try {
    let a = await request(base, '/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: 'alice', password: 'password123' }),
    });
    assert.equal(a.res.status, 200);
    assert.ok(a.cookie.includes('sid='));

    const saveA = await request(base, '/api/settings/smtp', {
      method: 'POST',
      body: JSON.stringify({
        host: 'smtp-a.example.com',
        port: '465',
        secure: true,
        user: 'alice@example.com',
        pass: 'secret',
      }),
    }, a.cookie);
    assert.equal(saveA.body.success, true);

    const connA = await request(base, '/api/connections', {
      method: 'POST',
      body: JSON.stringify({
        type: 'mysql',
        host: 'db-a.local',
        port: '3306',
        database: 'reporting',
        username: 'alice_db',
        password: 'secret',
        label: 'Alice DB',
      }),
    }, a.cookie);
    assert.equal(connA.body.success, true);

    const robotA = await request(base, '/api/settings/wechat-robots', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Alice Robot',
        webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=alice',
      }),
    }, a.cookie);
    assert.equal(robotA.body.success, true);

    const scheduleA = await request(base, '/api/schedules', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Alice Schedule',
        cron: '0 9 * * *',
        connectionInfo: connA.body.connection,
        connectionLabel: connA.body.connection.label,
        sql: 'select 1',
        sendType: 'wechat',
        wechatWebhook: robotA.body.robot.webhookUrl,
        wechatRobotId: robotA.body.robot.id,
        wechatRobotName: robotA.body.robot.name,
      }),
    }, a.cookie);
    assert.equal(scheduleA.body.success, true);

    const b = await request(base, '/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username: 'bob', password: 'password123' }),
    });
    assert.equal(b.res.status, 200);
    assert.ok(b.cookie.includes('sid='));

    const smtpB = await request(base, '/api/settings/smtp', {}, b.cookie);
    assert.equal(smtpB.body.success, true);
    assert.equal(smtpB.body.config, null);

    const connsB = await request(base, '/api/connections', {}, b.cookie);
    assert.deepEqual(connsB.body.connections, []);

    const robotsB = await request(base, '/api/settings/wechat-robots', {}, b.cookie);
    assert.deepEqual(robotsB.body.robots, []);

    const schedulesB = await request(base, '/api/schedules', {}, b.cookie);
    assert.deepEqual(schedulesB.body.tasks, []);

    const forbiddenSchedule = await request(base, `/api/schedules/${scheduleA.body.task.id}`, {}, b.cookie);
    assert.equal(forbiddenSchedule.res.status, 404);

    const smtpA = await request(base, '/api/settings/smtp', {}, a.cookie);
    assert.equal(smtpA.body.config.host, 'smtp-a.example.com');

    const connsA = await request(base, '/api/connections', {}, a.cookie);
    assert.equal(connsA.body.connections.length, 1);
    assert.equal(connsA.body.connections[0].label, 'Alice DB');

    const robotsA = await request(base, '/api/settings/wechat-robots', {}, a.cookie);
    assert.equal(robotsA.body.robots.length, 1);
    assert.equal(robotsA.body.robots[0].name, 'Alice Robot');

    const schedulesA = await request(base, '/api/schedules', {}, a.cookie);
    assert.equal(schedulesA.body.tasks.length, 1);
    assert.equal(schedulesA.body.tasks[0].name, 'Alice Schedule');
  } finally {
    child.kill();
  }
});
