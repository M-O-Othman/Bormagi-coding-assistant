import * as fs from 'fs';
import * as path from 'path';

/**
 * Convert Markdown text to a .docx file.
 * Supports: # h1, ## h2, ### h3, - / * bullet, blank line = paragraph break.
 *
 * Note: `docx` is an ESM package. We use a dynamic import with `any` cast so
 * webpack bundles it correctly at extension compile time.
 */
export async function generateDocx(title: string, markdownContent: string, outputPath: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const docxMod: any = await import('docx');
  const { Document, Packer, Paragraph, HeadingLevel, TextRun } = docxMod;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const paragraphs: any[] = [];

  if (title) {
    paragraphs.push(new Paragraph({ text: title, heading: HeadingLevel.TITLE }));
  }

  const lines = markdownContent.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith('### ')) {
      paragraphs.push(new Paragraph({ text: line.slice(4), heading: HeadingLevel.HEADING_3 }));
    } else if (line.startsWith('## ')) {
      paragraphs.push(new Paragraph({ text: line.slice(3), heading: HeadingLevel.HEADING_2 }));
    } else if (line.startsWith('# ')) {
      paragraphs.push(new Paragraph({ text: line.slice(2), heading: HeadingLevel.HEADING_1 }));
    } else if (/^[-*] /.test(line)) {
      paragraphs.push(new Paragraph({ text: line.slice(2), bullet: { level: 0 } }));
    } else if (line.trim() === '') {
      paragraphs.push(new Paragraph({ text: '' }));
    } else {
      paragraphs.push(new Paragraph({ children: [new TextRun({ text: line })] }));
    }
  }

  const doc = new Document({ sections: [{ children: paragraphs }] });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
}

/**
 * Convert slide Markdown to a .pptx file.
 * Use ## for each slide title. Bullets (-) become content items. First ## is the title slide.
 */
export async function generatePptx(slidesMarkdown: string, outputPath: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pptxMod: any = await import('pptxgenjs');
  const PptxGenJSClass = pptxMod.default ?? pptxMod;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pptx: any = new PptxGenJSClass();
  pptx.layout = 'LAYOUT_WIDE';

  interface SlideData { title: string; bullets: string[]; text: string[] }
  const slides: SlideData[] = [];
  let current: SlideData | null = null;

  for (const raw of slidesMarkdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.startsWith('## ')) {
      if (current) { slides.push(current); }
      current = { title: line.slice(3), bullets: [], text: [] };
    } else if (current) {
      if (/^[-*] /.test(line)) {
        current.bullets.push(line.slice(2));
      } else if (line.trim()) {
        current.text.push(line.trim());
      }
    }
  }
  if (current) { slides.push(current); }

  if (slides.length === 0) {
    const s = pptx.addSlide();
    s.addText('Presentation', { x: 1, y: 2, w: 8, h: 1.5, fontSize: 36, bold: true, align: 'center' });
    await pptx.writeFile({ fileName: outputPath });
    return;
  }

  slides.forEach((sd: SlideData, idx: number) => {
    const slide = pptx.addSlide();
    if (idx === 0) {
      slide.addText(sd.title, { x: 1, y: 2, w: 8, h: 1.5, fontSize: 36, bold: true, align: 'center', color: '363636' });
      const sub = [...sd.bullets, ...sd.text].join('  ·  ');
      if (sub) {
        slide.addText(sub, { x: 1, y: 3.8, w: 8, h: 0.8, fontSize: 20, align: 'center', color: '666666' });
      }
    } else {
      slide.addText(sd.title, { x: 0.5, y: 0.3, w: 9, h: 0.8, fontSize: 24, bold: true, color: '363636' });
      const items = [
        ...sd.bullets.map((b: string) => ({ text: b, options: { bullet: true, fontSize: 18, color: '444444', paraSpaceAfter: 6 } })),
        ...sd.text.map((t: string) => ({ text: t, options: { fontSize: 16, color: '555555', paraSpaceAfter: 4 } }))
      ];
      if (items.length > 0) {
        slide.addText(items, { x: 0.5, y: 1.4, w: 9, h: 4.5 });
      }
    }
  });

  await pptx.writeFile({ fileName: outputPath });
}
