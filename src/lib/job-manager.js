'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

const config = require('../config');
const tmpfiles = require('./tmpfiles');
const ghostscript = require('./ghostscript');
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

function runNext() {
  if (activeCount >= config.maxConcurrentJobs) return;
  const jobId = pendingQueue.shift();
  if (!jobId) return;

  const job = jobs.get(jobId);
  if (!job) return runNext();

  activeCount += 1;
  touch(jobId, { status: 'running' });

  ghostscript
    .compress({ inputPath: job.inputPath, outputPath: job.outputPath, pdfSettings: job.pdfSettings })
    .then(() => {
      const compressedSize = fs.statSync(job.outputPath).size;
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
function createJob(inputStream, { pdfSettings, onDone } = {}) {
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
  inputStream.on('data', (chunk) => {
    bytesWritten += chunk.length;
  });

  pipeline(inputStream, writeStream)
    .then(() => {
      if (bytesWritten === 0) {
        touch(jobId, { status: 'failed', errorCode: 'empty_input', message: 'Fichier vide reçu.' });
        tmpfiles.cleanupJobDir(jobId);
        scheduleTtlCleanup(jobId);
        onDone && onDone(new Error('empty_input'), null);
        return;
      }
      touch(jobId, { status: 'queued', originalSize: bytesWritten });
      enqueue(jobId);
    })
    .catch((err) => {
      touch(jobId, { status: 'failed', errorCode: 'upload_failed', message: err.message });
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
