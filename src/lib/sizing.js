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

module.exports = { base64Size, computeVerdict };
