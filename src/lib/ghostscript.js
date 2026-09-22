'use strict';

const { spawn } = require('child_process');
const config = require('../config');

class GhostscriptError extends Error {
  constructor(code, message, exitCode) {
    super(message);
    this.code = code; // 'password_protected' | 'corrupted_input' | 'timeout' | 'ghostscript_failed'
    this.exitCode = exitCode;
  }
}

function classify(stderr, exitCode, signal) {
  if (/This file requires a password|Password did not work|OwnerPassword/i.test(stderr)) {
    return new GhostscriptError('password_protected', 'Le PDF est protégé par mot de passe.', exitCode);
  }
  if (/Unrecoverable error|not a PDF|corrupt|Can't find (trailer|xref)/i.test(stderr)) {
    return new GhostscriptError('corrupted_input', 'Le PDF est corrompu ou illisible par Ghostscript.', exitCode);
  }
  if (exitCode === null && signal) {
    // No exit code + a signal (SIGKILL almost always means the kernel OOM
    // killer stepped in — a cgroup memory limit hit, not a Ghostscript bug).
    // eslint-disable-next-line no-console
    console.error(`[pdf-compression-service] ghostscript killed by signal ${signal} (likely OOM)`);
    return new GhostscriptError(
      'ghostscript_killed',
      `Ghostscript a été interrompu par le système (signal ${signal}), probablement par manque de mémoire.`,
      exitCode,
    );
  }
  // eslint-disable-next-line no-console
  console.error(`[pdf-compression-service] ghostscript exit ${exitCode}, stderr:\n${stderr}`);
  const snippet = stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 300);
  return new GhostscriptError('ghostscript_failed', `Ghostscript a échoué (code ${exitCode}): ${snippet}`, exitCode);
}

function compress({
  inputPath,
  outputPath,
  pdfSettings = config.gsPdfSettings,
  timeoutSec = config.gsTimeoutSec,
  imageResolution,
  grayscale,
  detectDuplicateImages = true,
}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-sDEVICE=pdfwrite',
      `-dPDFSETTINGS=${pdfSettings}`,
      '-dNOPAUSE',
      '-dBATCH',
      '-dSAFER',
      `-dDetectDuplicateImages=${detectDuplicateImages}`,
      '-dCompressFonts=true',
    ];

    // Overrides applied after the preset go further than any built-in preset
    // (including /screen) — used to escalate past a caller-specified target
    // size when the preset alone doesn't get there.
    if (imageResolution) {
      args.push(
        '-dDownsampleColorImages=true',
        '-dDownsampleGrayImages=true',
        '-dDownsampleMonoImages=true',
        `-dColorImageResolution=${imageResolution}`,
        `-dGrayImageResolution=${imageResolution}`,
        `-dMonoImageResolution=${imageResolution}`,
      );
    }

    if (grayscale) {
      args.push('-sColorConversionStrategy=Gray', '-dProcessColorModel=/DeviceGray');
    }

    args.push(`-sOutputFile=${outputPath}`, inputPath);

    const proc = spawn(config.gsBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      reject(new GhostscriptError('timeout', `Ghostscript dépasse le timeout de ${timeoutSec}s.`));
    }, timeoutSec * 1000);

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new GhostscriptError('ghostscript_failed', `Impossible de lancer Ghostscript: ${err.message}`));
    });

    proc.on('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (exitCode !== 0) {
        reject(classify(stderr, exitCode, signal));
      } else {
        resolve({ stderr });
      }
    });
  });
}

module.exports = { compress, GhostscriptError };
