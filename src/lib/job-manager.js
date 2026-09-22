'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

const config = require('../config');
const tmpfiles = require('./tmpfiles');
const ghostscript = require('./ghostscript');
const stripImages = require('./strip-repeated-images');
const { computeVerdict, parseSize } = require('./sizing');

const jobs = new Map(); // jobId -> job record
const pendingQueue = [];
let activeCount = 0;

function getJob(jobId) {
  return jobs.get(jobId);
}

function touch(jobId, patch) {
  const job = jobs.get(jobId);
  if (!job) return;
  Object.assign(job, patch, { updatedAt: Date.now() });
}

function scheduleTtlCleanup(jobId) {
  setTimeout(() => {
    const job = jobs.get(jobId);
    if (!job) return;
    if (job.status === 'done' || job.status === 'failed') {
      tmpfiles.cleanupJobDir(jobId);
      jobs.delete(jobId);
    }
  }, config.resultTtlSec * 1000).unref();
}

// Baseline image resolution (DPI) of each built-in preset, used to turn a
// first-pass result into a targeted estimate for the second pass instead of
// walking a fixed ladder — each full pass reprocesses the entire document
// from scratch, so a fixed 5-rung ladder means up to 5x the time of a
// single pass on a large file (observed: ~11 min on 200MB vs ~2 min for a
// single-pass tool). Embedded image size scales roughly with the square of
// the resolution, so resolution can be estimated directly from how far the
// first attempt missed the target, converging in 2 passes in most cases.
const PRESET_BASELINE_DPI = { '/screen': 72, '/ebook': 150, '/printer': 300, '/prepress': 300 };
const MIN_ESCALATION_DPI = 24;
const MAX_ESCALATION_DPI = 72; // no point escalating above /screen's own baseline

// Best-effort: on failure (unsupported PDF quirk, timeout), fall back to the
// original input untouched rather than failing the whole job — this step is
// an optimization, not a correctness requirement.
async function prepareInput(job) {
  const strippedPath = path.join(path.dirname(job.inputPath), 'input-stripped.pdf');
  try {
    await stripImages.stripRepeatedImages({ inputPath: job.inputPath, outputPath: strippedPath });
    return strippedPath;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[pdf-compression-service] strip_repeated_images failed, using original input: ${err.message}`);
    return job.inputPath;
  }
}

async function compressToTarget(job) {
  const effectiveInputPath = await prepareInput(job);

  // Always on: duplicate-image detection is what makes a repeated logo/stamp
  // across thousands of pages cost roughly one copy instead of one per page
  // — confirmed in production to be the dominant factor on a 3000+ page
  // invoice with the same logo on every page (12.3 MB floor even at the
  // most aggressive resolution/grayscale settings, with detection off above
  // 150 MB). The speed cost is real but far less important than actually
  // reaching a usable output size for exactly this kind of document.
  const detectDuplicateImages = true;

  await ghostscript.compress({
    inputPath: effectiveInputPath,
    outputPath: job.outputPath,
    pdfSettings: job.pdfSettings,
    detectDuplicateImages,
  });
  let compressedSize = fs.statSync(job.outputPath).size;

  if (job.expectedOutputSizeBytes === undefined || compressedSize <= job.expectedOutputSizeBytes) {
    return { compressedSize };
  }

  const baselineDpi = PRESET_BASELINE_DPI[job.pdfSettings] || PRESET_BASELINE_DPI['/ebook'];
  // Aim a bit under the target (0.85x) since the size/resolution relationship
  // is only approximate (JPEG re-encoding overhead, non-image content) —
  // better to slightly undershoot than need a 3rd pass.
  const rawEstimate = baselineDpi * Math.sqrt((job.expectedOutputSizeBytes * 0.85) / compressedSize);
  const estimatedDpi = Math.round(Math.min(MAX_ESCALATION_DPI, Math.max(MIN_ESCALATION_DPI, rawEstimate)));

  await ghostscript.compress({
    inputPath: effectiveInputPath,
    outputPath: job.outputPath,
    pdfSettings: '/screen',
    imageResolution: estimatedDpi,
    detectDuplicateImages,
  });
  compressedSize = fs.statSync(job.outputPath).size;
  if (compressedSize <= job.expectedOutputSizeBytes) {
    return { compressedSize, usedResolutionDpi: estimatedDpi };
  }

  // The estimate missed (unusual content, e.g. mostly-vector pages where
  // resolution barely matters) — one guaranteed floor attempt, no more
  // guessing, to bound worst-case time at 3 passes total.
  await ghostscript.compress({
    inputPath: effectiveInputPath,
    outputPath: job.outputPath,
    pdfSettings: '/screen',
    imageResolution: MIN_ESCALATION_DPI,
    grayscale: true,
    detectDuplicateImages,
  });
  compressedSize = fs.statSync(job.outputPath).size;
  return { compressedSize, usedResolutionDpi: MIN_ESCALATION_DPI, usedGrayscale: true };
}

function runNext() {
  if (activeCount >= config.maxConcurrentJobs) return;
  const jobId = pendingQueue.shift();
  if (!jobId) return;

  const job = jobs.get(jobId);
  if (!job) return runNext();

  activeCount += 1;
  touch(jobId, { status: 'running' });

  compressToTarget(job)
    .then(({ compressedSize, usedResolutionDpi, usedGrayscale }) => {
      const verdict = computeVerdict({
        originalSize: job.originalSize,
        compressedSize,
        minGainRatio: config.minGainRatio,
        base64LimitBytes: config.base64LimitBytes,
      });
      if (job.expectedOutputSizeBytes !== undefined) {
        verdict.expectedOutputSize = job.expectedOutputSizeBytes;
        verdict.withinExpectedSize = compressedSize <= job.expectedOutputSizeBytes;
      }
      if (usedResolutionDpi) {
        verdict.escalatedResolutionDpi = usedResolutionDpi;
      }
      if (usedGrayscale) {
        verdict.escalatedGrayscale = true;
      }
      touch(jobId, { status: 'done', ...verdict });
      job.onDone && job.onDone(null, { ...jobs.get(jobId) });
      scheduleTtlCleanup(jobId);
    })
    .catch((err) => {
      touch(jobId, {
        status: 'failed',
        errorCode: err.code || 'ghostscript_failed',
        message: err.message,
      });
      job.onDone && job.onDone(err, null);
      tmpfiles.cleanupJobDir(jobId);
      scheduleTtlCleanup(jobId);
    })
    .finally(() => {
      activeCount -= 1;
      runNext();
    });
}

function enqueue(jobId) {
  pendingQueue.push(jobId);
  runNext();
}

/**
 * Creates a job by streaming `inputStream` to a local temp file (never
 * buffered fully in memory), then enqueues Ghostscript processing once the
 * upload completes. Resolves with the jobId as soon as the upload starts;
 * `onDone` (optional) is called once processing finishes, useful for the
 * synchronous fast-path.
 */
function createJob(inputStream, { pdfSettings, onDone, onUploaded } = {}) {
  const jobId = crypto.randomUUID();
  const dir = tmpfiles.createJobDir(jobId);
  const inputPath = path.join(dir, 'input.pdf');
  const outputPath = path.join(dir, 'output.pdf');

  jobs.set(jobId, {
    jobId,
    status: 'uploading',
    createdAt: Date.now(),
    inputPath,
    outputPath,
    pdfSettings,
    onDone,
  });

  const writeStream = fs.createWriteStream(inputPath);
  let bytesWritten = 0;
  let lastReported = 0;
  inputStream.on('data', (chunk) => {
    bytesWritten += chunk.length;
    // Throttled progress reporting (every ~5MB) so GET /jobs/:id can show
    // whether an "uploading" job is actually still receiving data, or
    // genuinely stalled — a real diagnostic need, not routine telemetry.
    if (bytesWritten - lastReported > 5 * 1024 * 1024) {
      lastReported = bytesWritten;
      touch(jobId, { bytesReceived: bytesWritten });
    }
  });

  // Without this, a stalled/abandoned upload (client hung, connection
  // stuck) leaves the job stuck in "uploading" forever — no TTL applies
  // until a terminal status is reached, so nothing ever cleans it up.
  const uploadTimer = setTimeout(() => {
    inputStream.destroy(new Error(`Upload interrompu: aucune donnée reçue depuis ${config.uploadTimeoutSec}s`));
  }, config.uploadTimeoutSec * 1000);
  uploadTimer.unref();

  pipeline(inputStream, writeStream)
    .then(() => {
      clearTimeout(uploadTimer);
      if (bytesWritten === 0) {
        touch(jobId, { status: 'failed', errorCode: 'empty_input', message: 'Fichier vide reçu.' });
        tmpfiles.cleanupJobDir(jobId);
        scheduleTtlCleanup(jobId);
        onUploaded && onUploaded(new Error('empty_input'), jobs.get(jobId));
        onDone && onDone(new Error('empty_input'), null);
        return;
      }
      touch(jobId, { status: 'queued', originalSize: bytesWritten });
      onUploaded && onUploaded(null, jobs.get(jobId));
      enqueue(jobId);
    })
    .catch((err) => {
      clearTimeout(uploadTimer);
      touch(jobId, { status: 'failed', errorCode: 'upload_failed', message: `${err.message} (${bytesWritten} octets reçus)` });
      onUploaded && onUploaded(err, jobs.get(jobId));
      tmpfiles.cleanupJobDir(jobId);
      scheduleTtlCleanup(jobId);
      onDone && onDone(err, null);
    });

  return jobId;
}

function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return false;
  jobs.delete(jobId);
  tmpfiles.cleanupJobDir(jobId);
  return true;
}

// Attaches a caller-supplied target size (e.g. "10MB") to a job, so the
// eventual verdict can report whether the compressed result met it — used
// by the multipart upload path, where this arrives as a trailing form field
// after the file part has already started streaming to disk.
function setExpectedOutputSize(jobId, raw) {
  const bytes = parseSize(raw);
  if (bytes === undefined) return;
  touch(jobId, { expectedOutputSizeBytes: bytes });
}

module.exports = { createJob, getJob, cancelJob, setExpectedOutputSize };
