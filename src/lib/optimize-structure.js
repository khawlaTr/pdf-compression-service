'use strict';

const { spawn } = require('child_process');
const path = require('path');
const config = require('../config');

const SCRIPT_PATH = path.join(__dirname, 'optimize_structure.py');

// Lossless structural pass: deduplicates identical objects and re-serializes
// with object streams + stream compression. On documents produced by a
// merging engine (one private copy of every shared resource per merged
// sub-document) this is dramatically more effective than image compression —
// measured 111 MB -> 2.5 MB losslessly, where Ghostscript at its most
// aggressive settings plateaued at 10.5 MB with visibly degraded output.
function optimizeStructure({ inputPath, outputPath, timeoutSec = config.structureTimeoutSec, budgetSec }) {
  return new Promise((resolve, reject) => {
    // The budget lets the script degrade gracefully (optimize the chunks it
    // has time for, re-serialize the rest) instead of being killed with
    // nothing to show for it, which used to fail the whole job.
    const env = { ...process.env };
    if (budgetSec) env.STRUCTURE_BUDGET_SEC = String(Math.floor(budgetSec));
    const proc = spawn(config.pythonBin, [SCRIPT_PATH, inputPath, outputPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      reject(new Error(`optimize_structure dépasse le timeout de ${timeoutSec}s`));
    }, timeoutSec * 1000);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Impossible de lancer optimize_structure: ${err.message}`));
    });

    proc.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const why = code === null && signal ? `tué par le système (signal ${signal})` : `code ${code}`;
        reject(new Error(`optimize_structure a échoué (${why}): ${stderr.trim().slice(-400)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (err) {
        reject(new Error(`Sortie inattendue de optimize_structure: ${stdout.trim().slice(0, 200)}`));
      }
    });
  });
}

module.exports = { optimizeStructure };
