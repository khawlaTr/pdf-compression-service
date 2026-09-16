'use strict';

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function float(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = {
  port: int('PORT', 8080),
  gsBin: process.env.GS_BIN || 'gs',
  gsPdfSettings: process.env.GS_PDFSETTINGS || '/ebook',
  gsTimeoutSec: int('GS_TIMEOUT_SEC', 180),
  maxConcurrentJobs: int('MAX_CONCURRENT_JOBS', 2),
  syncMaxBytes: int('SYNC_MAX_BYTES', 20 * 1024 * 1024),
  base64LimitBytes: int('BASE64_LIMIT_BYTES', 100 * 1024 * 1024),
  minGainRatio: float('MIN_GAIN_RATIO', 0.05),
  resultTtlSec: int('RESULT_TTL_SEC', 1800),
  tmpDir: process.env.TMP_DIR || '/tmp/gs-jobs',
  authDisabled: process.env.AUTH_DISABLED === 'true',
};
