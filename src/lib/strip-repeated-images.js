'use strict';

const { spawn } = require('child_process');
const path = require('path');
const config = require('../config');

const SCRIPT_PATH = path.join(__dirname, 'strip_repeated_images.py');

// Removes a logo/letterhead repeated across many pages, keeping only its
// first occurrence — Ghostscript's own -dDetectDuplicateImages doesn't
// reliably catch this (it re-encodes each page's image independently during
// downsampling and often fails to recognize the results as identical
// afterwards). Confirmed in production: a 3000+ page invoice with the same
// logo on every page plateaued at ~12 MB even at the most aggressive
// Ghostscript settings, with duplicate detection barely making a dent.
function stripRepeatedImages({
  inputPath,
  outputPath,
  minPages = config.repeatedImageMinPages,
  timeoutSec = config.stripImagesTimeoutSec,
}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(config.pythonBin, [SCRIPT_PATH, inputPath, outputPath, String(minPages)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      reject(new Error(`strip_repeated_images dépasse le timeout de ${timeoutSec}s`));
    }, timeoutSec * 1000);

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Impossible de lancer strip_repeated_images: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`strip_repeated_images a échoué (code ${code}): ${stderr.trim().slice(-500)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (err) {
        reject(new Error(`Sortie inattendue de strip_repeated_images: ${stdout.trim().slice(0, 200)}`));
      }
    });
  });
}

module.exports = { stripRepeatedImages };
