'use strict';

// Exact base64 overhead (4 output chars per 3 input bytes, rounded up),
// not the commonly-used flat x1.33 approximation.
function base64Size(bytes) {
  return Math.ceil(bytes / 3) * 4;
}

function computeVerdict({ originalSize, compressedSize, minGainRatio, base64LimitBytes }) {
  const ratio = originalSize > 0 ? (originalSize - compressedSize) / originalSize : 0;
  const b64 = base64Size(compressedSize);
  return {
    originalSize,
    compressedSize,
    base64Size: b64,
    ratio: Number(ratio.toFixed(4)),
    withinLimit: b64 <= base64LimitBytes,
    lowGain: ratio < minGainRatio,
  };
}

const SIZE_UNITS = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 };

// Parses human-readable sizes like "10MB", "512 KB", "1.5GB" into bytes.
// Returns undefined for anything it can't parse (caller treats as absent).
function parseSize(raw) {
  if (raw === undefined || raw === null) return undefined;
  const match = String(raw).trim().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i);
  if (!match) return undefined;
  const value = Number.parseFloat(match[1]);
  const unit = (match[2] || 'B').toUpperCase();
  return Math.round(value * SIZE_UNITS[unit]);
}

module.exports = { base64Size, computeVerdict, parseSize };
