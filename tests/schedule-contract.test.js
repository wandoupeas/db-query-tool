const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');

test('schedule API exposes update and execution log endpoints', () => {
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

  assert.match(server, /app\.put\(['"]\/api\/schedules\/:id['"]/);
  assert.match(server, /app\.get\(['"]\/api\/schedules\/:id\/logs['"]/);
});

test('desktop builds include the shared server and public UI assets', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  assert.ok(pkg.build.files.includes('server.js'));
  assert.ok(pkg.build.files.includes('electron/**'));
  assert.ok(pkg.build.files.includes('public/**'));
  assert.ok(pkg.build.win.target.includes('portable'));
  assert.ok(pkg.build.mac.target.includes('dmg'));
});

test('shared desktop UI exposes schedule edit and log actions', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

  assert.match(html, /openEditSchedule\('\$\{t\.id\}'\)/);
  assert.match(html, /openScheduleLogs\('\$\{t\.id\}'\)/);
  assert.match(html, /id="schedule-save-btn" onclick="saveSchedule\(\)"/);
  assert.match(html, /id="schedule-log-modal"/);
});

test('scheduled tasks explicitly bind to a selected database connection', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

  assert.match(html, /id="sched-connection"/);
  assert.match(html, /renderScheduleConnectionOptions/);
  assert.match(html, /getSelectedScheduleConnection/);
  assert.match(html, /connectionInfo:\s*selectedConnection\.connectionInfo/);
  assert.match(server, /const connectionLabel = payload\.connectionLabel/);
  assert.match(server, /connectionLabel:\s*entry\.connectionLabel/);
});

test('WeChat robots can be maintained and selected for sends and schedules', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

  assert.match(server, /WECHAT_ROBOTS_PATH/);
  assert.match(server, /app\.get\(['"]\/api\/settings\/wechat-robots['"]/);
  assert.match(server, /app\.post\(['"]\/api\/settings\/wechat-robots['"]/);
  assert.match(server, /app\.put\(['"]\/api\/settings\/wechat-robots\/:id['"]/);
  assert.match(server, /app\.delete\(['"]\/api\/settings\/wechat-robots\/:id['"]/);
  assert.match(html, /id="wechat-robot-list"/);
  assert.match(html, /id="send-wechat-robot"/);
  assert.match(html, /id="sched-wechat-robot"/);
  assert.match(html, /loadWechatRobots/);
  assert.match(html, /getSelectedWechatRobot/);
  assert.match(html, /wechatRobotId/);
});

test('authentication and per-user storage contracts are present', () => {
  const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  assert.ok(pkg.dependencies['sql.js']);
  assert.match(server, /require\(['"]crypto['"]\)/);
  assert.match(server, /require\(['"]sql\.js['"]\)/);
  assert.match(server, /app\.post\(['"]\/api\/auth\/register['"]/);
  assert.match(server, /app\.post\(['"]\/api\/auth\/login['"]/);
  assert.match(server, /app\.post\(['"]\/api\/auth\/logout['"]/);
  assert.match(server, /app\.get\(['"]\/api\/auth\/me['"]/);
  assert.match(server, /requireAuth/);
  assert.match(server, /userId/);
  assert.match(html, /id="auth-view"/);
  assert.match(html, /loginUser/);
  assert.match(html, /registerUser/);
  assert.match(html, /logoutUser/);
});
