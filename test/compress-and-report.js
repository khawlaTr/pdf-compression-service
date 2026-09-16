#!/usr/bin/env node
'use strict';

// Usage: node test/compress-and-report.js <fichier.pdf>
// Env:   PDF_COMPRESS_URL (default http://localhost:8080)
//        PDF_COMPRESS_TOKEN (bearer token, omit only if the server runs with AUTH_DISABLED=true)

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const BASE_URL = process.env.PDF_COMPRESS_URL || 'http://localhost:8080';
const TOKEN = process.env.PDF_COMPRESS_TOKEN || '';

function authHeaders() {
  return TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
}

async function poll(jobId) {
  for (;;) {
    const res = await fetch(`${BASE_URL}/jobs/${jobId}`, { headers: authHeaders() });
    const job = await res.json();
    if (job.status === 'done' || job.status === 'failed') return job;
    process.stdout.write('.');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

function mb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

function report(result) {
  console.log('');
  if (result.status === 'failed' || result.errorCode) {
    console.error(`ECHEC: ${result.errorCode} - ${result.message}`);
    process.exitCode = 1;
    return;
  }
  console.log('--- Resultat de compression ---');
  console.log(`Taille originale    : ${mb(result.originalSize)} Mo`);
  console.log(`Taille compressee   : ${mb(result.compressedSize)} Mo`);
  console.log(`Taille base64 estim.: ${mb(result.base64Size)} Mo`);
  console.log(`Ratio de gain       : ${(result.ratio * 100).toFixed(1)}%`);
  console.log(`Sous la limite EDI (100 Mo encode) : ${result.withinLimit ? 'OK' : 'KO'}`);
  if (result.lowGain) {
    console.log('ATTENTION: gain de compression faible - le PDF etait probablement deja optimise.');
  }
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node test/compress-and-report.js <fichier.pdf>');
    process.exit(1);
  }

  const stat = fs.statSync(filePath);
  const headers = {
    'Content-Type': 'application/pdf',
    'Content-Length': String(stat.size),
    ...authHeaders(),
  };

  console.log(`Envoi de ${path.basename(filePath)} (${mb(stat.size)} Mo)...`);
  const start = Date.now();
  const body = Readable.toWeb(fs.createReadStream(filePath));
  const res = await fetch(`${BASE_URL}/compress`, { method: 'POST', headers, body, duplex: 'half' });

  let result;
  if (res.status === 202) {
    const { jobId } = await res.json();
    console.log(`Job asynchrone cree: ${jobId} - polling...`);
    result = await poll(jobId);
  } else if (res.status === 200) {
    result = await res.json();
  } else {
    const err = await res.json().catch(() => ({}));
    console.error(`Echec HTTP ${res.status}: ${err.message || res.statusText}`);
    process.exit(1);
  }

  console.log(`Duree totale: ${((Date.now() - start) / 1000).toFixed(1)}s`);
  report(result);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
