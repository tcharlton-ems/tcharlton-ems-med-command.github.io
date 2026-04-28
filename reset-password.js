#!/usr/bin/env node
/**
 * MedCommand Password Reset Utility
 * 
 * Usage:
 *   node reset-password.js              → resets to default (admin123)
 *   node reset-password.js mynewpassword → sets a specific password
 * 
 * Run this while the server is STOPPED, then restart it.
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, 'data.json');
const newPassword = process.argv[2] || 'admin123';

function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw + 'medcmd_salt').digest('hex');
}

if (!fs.existsSync(DATA_FILE)) {
  console.log('❌  data.json not found — start the server once first to create it, then run this script.');
  process.exit(1);
}

try {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  data.adminPasswordHash = hashPassword(newPassword);
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  console.log('');
  console.log('✅  Password updated successfully.');
  console.log('    New password: ' + newPassword);
  console.log('    Hash:         ' + data.adminPasswordHash);
  console.log('');
  console.log('    Restart the server and log in with the new password.');
  console.log('');
} catch (e) {
  console.error('❌  Failed to update password:', e.message);
  process.exit(1);
}
