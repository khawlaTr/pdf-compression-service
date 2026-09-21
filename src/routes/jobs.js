'use strict';

const fs = require('fs');
const express = require('express');
const busboy = require('busboy');
const config = require('../config');
const jobManager = require('../lib/job-manager');

const router = express.Router();

function toPublicJob(job) {
  return {
    jobId: job.jobId,
    status: job.status,
    bytesReceived: job.bytesReceived,
    originalSize: job.originalSize,
    compressedSize: job.compressedSize,
    base64Size: job.base64Size,
    ratio: job.ratio,
    withinLimit: job.withinLimit,
    lowGain: job.lowGain,
    expectedOutputSize: job.expectedOutputSizeBytes,
    withinExpectedSize: job.withinExpectedSize,
    escalatedResolutionDpi: job.escalatedResolutionDpi,
    escalatedGrayscale: job.escalatedGrayscale,
    errorCode: job.errorCode,
    message: job.message,
  };
}

// Metadata travels as headers so the body can be the actual compressed PDF —
// callers (a CPI iFlow especially) want the file itself back, not a JSON
// wrapper they'd have to unpack with a second call.
function setVerdictHeaders(res, job) {
  res.set('X-Original-Size', String(job.originalSize));
  res.set('X-Compressed-Size', String(job.compressedSize));
  res.set('X-Base64-Size', String(job.base64Size));
  res.set('X-Ratio', String(job.ratio));
  res.set('X-Within-Limit', String(job.withinLimit));
  res.set('X-Low-Gain', String(job.lowGain));
  if (job.expectedOutputSizeBytes !== undefined) {
    res.set('X-Expected-Output-Size', String(job.expectedOutputSizeBytes));
    res.set('X-Within-Expected-Size', String(job.withinExpectedSize));
  }
  if (job.escalatedResolutionDpi) {
    res.set('X-Escalated-Resolution-Dpi', String(job.escalatedResolutionDpi));
  }
  if (job.escalatedGrayscale) {
    res.set('X-Escalated-Grayscale', 'true');
  }
}

function sendResult(res, job) {
  setVerdictHeaders(res, job);
  res.status(200).type('application/pdf');
  fs.createReadStream(job.outputPath).pipe(res);
}

function uploadOptionsFromQuery(req) {
  return {
    pdfSettings: req.query.preset ? String(req.query.preset) : undefined,
    forceAsync: req.query.async === 'true',
  };
}

// Creates the job and returns its id. `onResponded` fires once a response
// has actually been sent to the client — from the onUploaded callback for
// the async (202) path, or later from onDone for the sync path — so
// multipart's "did I already answer this request" bookkeeping stays correct
// either way.
//
// Critically, the 202 is sent only once the upload itself has fully
// completed (onUploaded), never earlier: an HTTP/1.1 reverse proxy (Cloud
// Foundry's Gorouter included) treats a request as finished the moment the
// backend sends its response, and stops forwarding the rest of the request
// body — replying early silently truncates the upload wherever it happened
// to be. Confirmed by reproducing the exact same stall (upload stopping
// partway, at a different byte count each time) with a direct test bypassing
// CPI entirely, once this endpoint replied with 202 before the body was
// fully read.
function submitJob(fileStream, { pdfSettings, forceAsync, contentLength }, res, onResponded) {
  const isSync = !forceAsync && contentLength > 0 && contentLength <= config.syncMaxBytes;

  if (!isSync) {
    return jobManager.createJob(fileStream, {
      pdfSettings,
      onUploaded: (err, job) => {
        onResponded();
        if (err) {
          res.status(422).json({
            error: (job && job.errorCode) || 'upload_failed',
            message: err.message,
          });
          return;
        }
        res.status(202).location(`/jobs/${job.jobId}`).json({ jobId: job.jobId, statusUrl: `/jobs/${job.jobId}` });
      },
    });
  }

  return jobManager.createJob(fileStream, {
    pdfSettings,
    onDone: (err, job) => {
      onResponded();
      if (err || !job) {
        res.status(422).json({
          error: (job && job.errorCode) || 'compression_failed',
          message: err ? err.message : 'Échec de la compression.',
        });
        return;
      }
      sendResult(res, job);
    },
  });
}

// multipart/form-data upload (e.g. a CPI Groovy script building a form body):
// expects a file part named `fileInput` and accepts an optional text field
// `expectedOutputSize` (human-readable, e.g. "10MB") echoed back in the
// verdict as `withinExpectedSize`. The file part is piped straight into the
// job pipeline as it streams in — never buffered whole in memory.
function handleMultipart(req, res, contentType) {
  const bb = busboy({ headers: { 'content-type': contentType } });
  const { pdfSettings, forceAsync } = uploadOptionsFromQuery(req);
  const contentLength = Number(req.headers['content-length'] || 0);
  let jobId;
  let fileSeen = false;
  let responded = false;

  bb.on('file', (name, stream, info) => {
    if (name !== 'fileInput') {
      stream.resume(); // discard any other file part
      return;
    }
    fileSeen = true;
    jobId = submitJob(stream, { pdfSettings, forceAsync, contentLength }, res, () => {
      responded = true;
    });
  });

  bb.on('field', (name, value) => {
    if (name === 'expectedOutputSize' && jobId) {
      jobManager.setExpectedOutputSize(jobId, value);
    }
  });

  bb.on('error', (err) => {
    if (!responded) {
      responded = true;
      res.status(400).json({ error: 'bad_multipart', message: err.message });
    }
  });

  bb.on('close', () => {
    if (!fileSeen && !responded) {
      responded = true;
      res.status(400).json({ error: 'missing_file', message: 'Partie "fileInput" absente du multipart.' });
    }
  });

  req.pipe(bb);
}

router.post('/compress', (req, res) => {
  const contentType = req.headers['content-type'] || '';

  if (/^multipart\/form-data/i.test(contentType)) {
    return handleMultipart(req, res, contentType);
  }

  if (!/pdf|octet-stream/i.test(contentType)) {
    return res.status(415).json({
      error: 'unsupported_media_type',
      message:
        'Content-Type doit être application/pdf, application/octet-stream, ou multipart/form-data avec un champ "fileInput".',
    });
  }

  const contentLength = Number(req.headers['content-length'] || 0);
  const { pdfSettings, forceAsync } = uploadOptionsFromQuery(req);
  submitJob(req, { pdfSettings, forceAsync, contentLength }, res, () => {});
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
  sendResult(res, job);
});

router.delete('/jobs/:jobId', (req, res) => {
  const ok = jobManager.cancelJob(req.params.jobId);
  res.status(ok ? 204 : 404).end();
});

module.exports = router;
