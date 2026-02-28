/**
 * Copies and resizes tmp/icon.png to media/icon.png (128×128).
 *
 * Usage:
 *   node scripts/generate-icon.js
 *
 * Requires the `sharp` devDependency:
 *   npm install sharp --save-dev
 */

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SRC_PATH = path.join(ROOT, '..', 'tmp', 'icon.png');
const OUT_PATH = path.join(ROOT, 'media', 'icon.png');

if (!fs.existsSync(SRC_PATH)) {
  console.error(`Source icon not found: ${SRC_PATH}`);
  process.exit(1);
}

sharp(SRC_PATH)
  .resize(128, 128)
  .png()
  .toFile(OUT_PATH)
  .then(() => console.log(`Icon generated: ${OUT_PATH}`))
  .catch(err => {
    console.error('Failed to generate icon:', err.message);
    process.exit(1);
  });
