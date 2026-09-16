'use strict';

// Verifies that a PDF containing the same image repeated across many pages
// (logos, QR codes) compresses far better than its raw size would suggest,
// as evidence -dDetectDuplicateImages is doing its job. Requires a running
// server (AUTH_DISABLED=true) and a fixture at test/fixtures/duplicate-logos.pdf
// — see docs/cpi-integration.md's sibling README section on how to build one
// locally (e.g. `convert logo.png -duplicate 199 logo.png out.pdf` with
// ImageMagick, or reuse any real scanned invoice with a repeated letterhead).
//
// Run: AUTH_DISABLED=true node src/server.js &
//      node --test test/duplicate-images.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const FIXTURE = path.join(__dirname, 'fixtures', 'duplicate-logos.pdf');
const BASE_URL = process.env.PDF_COMPRESS_URL || 'http://localhost:8080';

test('compresses a PDF with repeated images well below a naive per-page estimate', async (t) => {
  if (!fs.existsSync(FIXTURE)) {
    t.skip(`Fixture manquante: ${FIXTURE} — voir le commentaire en tete de fichier pour la generer.`);
    return;
  }

  const stat = fs.statSync(FIXTURE);
  const res = await fetch(`${BASE_URL}/compress?async=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(stat.size) },
    body: Readable.toWeb(fs.createReadStream(FIXTURE)),
    duplex: 'half',
  });
  assert.strictEqual(res.status, 202);
  const { jobId } = await res.json();

  let job;
  for (let i = 0; i < 60; i += 1) {
    const r = await fetch(`${BASE_URL}/jobs/${jobId}`);
    job = await r.json();
    if (job.status === 'done' || job.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  assert.strictEqual(job.status, 'done', job.message);
  assert.ok(job.ratio > 0.5, `Ratio de gain attendu > 50% sur des images dupliquees, obtenu: ${job.ratio}`);
});
