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
  uploadTimeoutSec: int('UPLOAD_TIMEOUT_SEC', 600),
  gsMaxBitmapBytes: int('GS_MAX_BITMAP_BYTES', 16 * 1024 * 1024),
  pythonBin: process.env.PYTHON_BIN || 'python3',
  repeatedImageMinPages: int('REPEATED_IMAGE_MIN_PAGES', 15),
  stripImagesTimeoutSec: int('STRIP_IMAGES_TIMEOUT_SEC', 300),
  tmpDir: process.env.TMP_DIR || '/tmp/gs-jobs',
  authDisabled: process.env.AUTH_DISABLED === 'true',
};
