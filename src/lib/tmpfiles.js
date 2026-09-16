'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

function reapAll() {
  fs.rmSync(config.tmpDir, { recursive: true, force: true });
  fs.mkdirSync(config.tmpDir, { recursive: true });
}

function createJobDir(jobId) {
  const dir = path.join(config.tmpDir, jobId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupJobDir(jobId) {
  const dir = path.join(config.tmpDir, jobId);
  fs.rm(dir, { recursive: true, force: true }, () => {});
}

module.exports = { reapAll, createJobDir, cleanupJobDir };
