const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const docsDir = path.join(__dirname, 'docs', 'assets', 'screenshots');
const files = fs.readdirSync(docsDir);

for (const file of files) {
    if (file.endsWith('.svg')) {
        const svgPath = path.join(docsDir, file);
        const pngPath = path.join(docsDir, file.replace('.svg', '.png'));

        console.log(`Converting ${file} to ${path.basename(pngPath)}...`);
        const svg = fs.readFileSync(svgPath, 'utf8');

        const resvg = new Resvg(svg, {
            fitTo: { mode: 'width', value: 1200 }, // Ensure it's high enough resolution
            background: 'rgba(255, 255, 255, 0)'
        });

        const pngData = resvg.render().asPng();
        fs.writeFileSync(pngPath, pngData);

        // Remove the original SVG
        fs.unlinkSync(svgPath);
    }
}
console.log('Conversion complete!');
