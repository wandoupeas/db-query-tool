'use strict';

const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');

// ─── Constants ──────────────────────────────────────────────────────────────
const BASE_PORT = 3001;
const MAX_PORT_ATTEMPTS = 10;

// ─── Window reference ──────────────────────────────────────────────────────
let mainWindow = null;

// ─── Start Express server ──────────────────────────────────────────────────
function startServer() {
  return new Promise((resolve, reject) => {
    process.env.PORT = String(BASE_PORT);

    try {
      // Require server.js — it now has auto port-retry logic
      require('../server.js');

      // Wait for server to be ready — try multiple ports
      const http = require('http');
      let found = false;

      function tryPort(port, attemptsLeft) {
        if (found) return;
        if (attemptsLeft <= 0) {
          reject(new Error('Server startup timeout'));
          return;
        }

        http.get(`http://localhost:${port}/`, (res) => {
          if (!found) {
            found = true;
            resolve(port);
          }
        }).on('error', () => {
          // Not ready on this port yet — maybe server is on a different port
          // or still starting up
        });

        // Also try next port in case server auto-retry kicked in
        if (port < BASE_PORT + MAX_PORT_ATTEMPTS) {
          setTimeout(() => tryPort(port + 1, attemptsLeft - 1), 400);
        }
      }

      // Start checking after a short delay for server to bind
      setTimeout(() => tryPort(BASE_PORT, 30), 500);

      // Global timeout
      setTimeout(() => {
        if (!found) {
          reject(new Error('Server startup timeout'));
        }
      }, 15000);
    } catch (err) {
      reject(err);
    }
  });
}

// ─── Create browser window ─────────────────────────────────────────────────
function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: '数据库查询工具',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(`http://localhost:${port}`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── App lifecycle ─────────────────────────────────────────────────────────

// Add command line flags for better compatibility
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu-sandbox');

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('ready', async () => {
    // Remove default menu bar
    Menu.setApplicationMenu(null);

    try {
      const port = await startServer();
      createWindow(port);
    } catch (err) {
      console.error('Failed to start server:', err);
      app.quit();
    }
  });
}

app.on('window-all-closed', () => {
  // Always quit — utility app
  app.exit();
});
