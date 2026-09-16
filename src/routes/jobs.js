'use strict';

const fs = require('fs');
const express = require('express');
const config = require('../config');
const jobManager = require('../lib/job-manager');

const router = express.Router();

function toPublicJob(job) {
  return {
    jobId: job.jobId,
    status: job.status,
    originalSize: job.originalSize,
    compressedSize: job.compressedSize,
    base64Size: job.base64Size,
    ratio: job.ratio,
    withinLimit: job.withinLimit,
    lowGain: job.lowGain,
    errorCode: job.errorCode,
    message: job.message,
  };
}

// Single entry point: small uploads (Content-Length <= SYNC_MAX_BYTES) are
// compressed inline and answered with 200; larger ones are queued and
// answered with 202 + jobId immediately, for the caller (a CPI iFlow) to
// poll GET /jobs/:jobId. Force the async path with ?async=true regardless
// of size, e.g. for testing.
router.post('/compress', (req, res) => {
  const contentType = req.headers['content-type'] || '';
  if (!/pdf|octet-stream/i.test(contentType)) {
    return res.status(415).json({
      error: 'unsupported_media_type',
      message: 'Content-Type doit être application/pdf ou application/octet-stream.',
    });
  }

  const contentLength = Number(req.headers['content-length'] || 0);
  const pdfSettings = req.query.preset ? String(req.query.preset) : undefined;
  const forceAsync = req.query.async === 'true';
  const isSync = !forceAsync && contentLength > 0 && contentLength <= config.syncMaxBytes;

  if (!isSync) {
    const jobId = jobManager.createJob(req, { pdfSettings });
    res.status(202).location(`/jobs/${jobId}`).json({ jobId, statusUrl: `/jobs/${jobId}` });
    return;
  }

  jobManager.createJob(req, {
    pdfSettings,
    onDone: (err, job) => {
      if (err || !job) {
        return res.status(422).json({
          error: (job && job.errorCode) || 'compression_failed',
          message: err ? err.message : 'Échec de la compression.',
        });
      }
      res.status(200).json(toPublicJob(job));
    },
  });
});

router.get('/jobs/:jobId', (req, res) => {
  const job = jobManager.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'not_found' });
  res.status(200).json(toPublicJob(job));
});

router.get('/jobs/:jobId/result', (req, res) => {
  const job = jobManager.getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'not_found' });
  if (job.status !== 'done') {
    return res.status(409).json({ error: 'not_ready', status: job.status });
  }
  res.status(200).type('application/pdf');
  fs.createReadStream(job.outputPath).pipe(res);
});

router.delete('/jobs/:jobId', (req, res) => {
  const ok = jobManager.cancelJob(req.params.jobId);
  res.status(ok ? 204 : 404).end();
});

module.exports = router;
