const fs = require('fs');
const path = require('path');

const bormagiJsonPath = path.join(__dirname, '..', 'bormagi.json');
if (!fs.existsSync(bormagiJsonPath)) {
    console.error('bormagi.json not found in the root directory.');
    process.exit(1);
}

try {
    const config = JSON.parse(fs.readFileSync(bormagiJsonPath, 'utf-8'));
    console.log('bormagi.json successfully parsed.');
    
    // Check if required directories exist
    if (config.requiredDirs) {
        for (const dir of config.requiredDirs) {
            const dirPath = path.join(__dirname, '..', dir);
            if (!fs.existsSync(dirPath)) {
                console.error(`Required directory missing: ${dir}`);
                process.exit(1);
            }
        }
    }
    console.log('Bormagi structure verification passed.');
} catch (err) {
    console.error('Failed to parse bormagi.json or verify structure:', err);
    process.exit(1);
}
