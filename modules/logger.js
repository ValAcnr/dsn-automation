'use strict';

const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, '..', 'logs');

function ensureLogsDir() {
  if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatDate(d) {
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function getLogPath() {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(LOGS_DIR, `dsn-${today}.log`);
}

function log(emoji, message) {
  ensureLogsDir();
  const line = `[${formatDate(new Date())}] ${emoji} ${message}\n`;
  process.stdout.write(line);
  try {
    fs.appendFileSync(getLogPath(), line, 'utf8');
  } catch (e) {
    // Silently ignore log write failures to avoid cascading errors
  }
}

module.exports = {
  ok:   (msg) => log('✅', msg),
  err:  (msg) => log('❌', msg),
  warn: (msg) => log('⚠️', msg),
  info: (msg) => log('ℹ️', msg),
};
