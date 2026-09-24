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
  // Whole-job budget across every Ghostscript pass. Without it, three passes
  // of up to GS_TIMEOUT_SEC each could run for 45 minutes and then return
  // nothing — far past any caller's own patience. When it runs out the job
  // returns the best result obtained so far instead of failing.
  jobDeadlineSec: int('JOB_DEADLINE_SEC', 900),
  uploadTimeoutSec: int('UPLOAD_TIMEOUT_SEC', 600),
  gsMaxBitmapBytes: int('GS_MAX_BITMAP_BYTES', 16 * 1024 * 1024),
  pythonBin: process.env.PYTHON_BIN || 'python3',
  // Structural (lossless) pass. Documents above structureChunkAboveBytes are
  // processed in page-range chunks, which bounds peak memory to the size of a
  // chunk instead of the whole document (185 MB peak measured on a 224 MB /
  // 3000 page file). The remaining cap is a guard against pathological
  // inputs, not a memory limit.
  structureEnabled: process.env.STRUCTURE_ENABLED !== 'false',
  structureMaxInputBytes: int('STRUCTURE_MAX_INPUT_BYTES', 1536 * 1024 * 1024),
  structureTimeoutSec: int('STRUCTURE_TIMEOUT_SEC', 900),
  // Removing a repeated logo changes what the document looks like, unlike the
  // structural pass which is byte-for-byte lossless; off unless asked for.
  stripRepeatedImagesEnabled: process.env.STRIP_REPEATED_IMAGES === 'true',
  repeatedImageMinPages: int('REPEATED_IMAGE_MIN_PAGES', 15),
  stripImagesTimeoutSec: int('STRIP_IMAGES_TIMEOUT_SEC', 300),
  tmpDir: process.env.TMP_DIR || '/tmp/gs-jobs',
  authDisabled: process.env.AUTH_DISABLED === 'true',
};
