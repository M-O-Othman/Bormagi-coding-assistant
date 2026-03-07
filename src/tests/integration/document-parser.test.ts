// ─── Document parser tests ───────────────────────────────────────────────────

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DocumentParser } from '../../knowledge/DocumentParser';

describe('DocumentParser', () => {
    let tmpDir: string;
    let parser: DocumentParser;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bormagi-test-parser-'));
        parser = new DocumentParser();
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // ─── Format detection (static) ────────────────────────────────────────

    describe('detectFormat', () => {
        it('detects markdown files', () => {
            expect(DocumentParser.detectFormat('readme.md')).toBe('markdown');
        });

        it('detects HTML files', () => {
            expect(DocumentParser.detectFormat('page.html')).toBe('html');
            expect(DocumentParser.detectFormat('page.htm')).toBe('html');
        });

        it('detects PDF files', () => {
            expect(DocumentParser.detectFormat('report.pdf')).toBe('pdf');
        });

        it('detects DOCX files', () => {
            expect(DocumentParser.detectFormat('document.docx')).toBe('docx');
        });

        it('detects Excel/CSV files', () => {
            expect(DocumentParser.detectFormat('data.xlsx')).toBe('xlsx');
            expect(DocumentParser.detectFormat('data.csv')).toBe('csv');
        });

        it('detects text files', () => {
            expect(DocumentParser.detectFormat('notes.txt')).toBe('text');
        });

        it('detects JSON files', () => {
            expect(DocumentParser.detectFormat('config.json')).toBe('json');
        });

        it('detects YAML files', () => {
            expect(DocumentParser.detectFormat('config.yaml')).toBe('yaml');
            expect(DocumentParser.detectFormat('config.yml')).toBe('yaml');
        });

        it('detects image files', () => {
            expect(DocumentParser.detectFormat('photo.png')).toBe('image');
            expect(DocumentParser.detectFormat('photo.jpg')).toBe('image');
            expect(DocumentParser.detectFormat('icon.svg')).toBe('image');
        });

        it('returns undefined for unsupported formats', () => {
            expect(DocumentParser.detectFormat('binary.exe')).toBeUndefined();
            expect(DocumentParser.detectFormat('archive.zip')).toBeUndefined();
        });
    });

    describe('supportedExtensions', () => {
        it('returns a non-empty list', () => {
            const exts = DocumentParser.supportedExtensions();
            expect(Array.isArray(exts)).toBe(true);
            expect(exts.length).toBeGreaterThan(5);
        });

        it('includes common formats', () => {
            const exts = DocumentParser.supportedExtensions();
            expect(exts).toContain('.md');
            expect(exts).toContain('.html');
            expect(exts).toContain('.txt');
            expect(exts).toContain('.json');
        });
    });

    // ─── Parsing Markdown ─────────────────────────────────────────────────

    describe('parse (Markdown)', () => {
        it('parses a simple markdown file', async () => {
            const filePath = path.join(tmpDir, 'test.md');
            fs.writeFileSync(filePath, '# Title\n\nSome content here.\n\n## Sub-heading\n\nMore content.\n');

            const doc = await parser.parse(filePath);
            expect(doc).not.toBeNull();
            expect(doc!.format).toBe('markdown');
            expect(doc!.filename).toBe('test.md');
            expect(doc!.fullText).toContain('Title');
            expect(doc!.fullText).toContain('Some content here');
            expect(doc!.sections.length).toBeGreaterThanOrEqual(1);
        });

        it('extracts sections from headings', async () => {
            const filePath = path.join(tmpDir, 'headings.md');
            fs.writeFileSync(filePath, '# First\n\nContent 1.\n\n## Second\n\nContent 2.\n\n## Third\n\nContent 3.\n');

            const doc = await parser.parse(filePath);
            expect(doc).not.toBeNull();
            expect(doc!.sections.length).toBeGreaterThanOrEqual(2);
        });
    });

    // ─── Parsing plain text ───────────────────────────────────────────────

    describe('parse (plain text)', () => {
        it('parses a .txt file', async () => {
            const filePath = path.join(tmpDir, 'notes.txt');
            fs.writeFileSync(filePath, 'Line 1\nLine 2\nLine 3\n');

            const doc = await parser.parse(filePath);
            expect(doc).not.toBeNull();
            expect(doc!.format).toBe('text');
            expect(doc!.fullText).toContain('Line 1');
        });
    });

    // ─── Parsing JSON ─────────────────────────────────────────────────────

    describe('parse (JSON)', () => {
        it('parses a JSON file', async () => {
            const filePath = path.join(tmpDir, 'data.json');
            fs.writeFileSync(filePath, JSON.stringify({ key: 'value', nested: { a: 1 } }, null, 2));

            const doc = await parser.parse(filePath);
            expect(doc).not.toBeNull();
            expect(doc!.format).toBe('json');
            expect(doc!.fullText).toContain('key');
            expect(doc!.fullText).toContain('value');
        });
    });

    // ─── Parsing YAML ─────────────────────────────────────────────────────

    describe('parse (YAML)', () => {
        it('parses a YAML file', async () => {
            const filePath = path.join(tmpDir, 'config.yaml');
            fs.writeFileSync(filePath, 'name: test\nversion: 1.0\n');

            const doc = await parser.parse(filePath);
            expect(doc).not.toBeNull();
            expect(doc!.format).toBe('yaml');
            expect(doc!.fullText).toContain('name');
        });
    });

    // ─── Parsing CSV ──────────────────────────────────────────────────────

    describe('parse (CSV)', () => {
        it('parses a CSV file', async () => {
            const filePath = path.join(tmpDir, 'data.csv');
            fs.writeFileSync(filePath, 'Name,Age,City\nAlice,30,London\nBob,25,Paris\n');

            const doc = await parser.parse(filePath);
            expect(doc).not.toBeNull();
            expect(doc!.format).toBe('csv');
            expect(doc!.fullText).toContain('Alice');
        });
    });

    // ─── Edge cases ───────────────────────────────────────────────────────

    describe('edge cases', () => {
        it('returns null for unsupported file types', async () => {
            const filePath = path.join(tmpDir, 'binary.exe');
            fs.writeFileSync(filePath, Buffer.from([0x00, 0x01, 0x02]));

            const doc = await parser.parse(filePath);
            expect(doc).toBeNull();
        });

        it('throws for non-existent files', async () => {
            await expect(parser.parse(path.join(tmpDir, 'nonexistent.md'))).rejects.toThrow();
        });

        it('handles empty files gracefully', async () => {
            const filePath = path.join(tmpDir, 'empty.md');
            fs.writeFileSync(filePath, '');

            const doc = await parser.parse(filePath);
            // Should either return null or a doc with empty fullText
            if (doc) {
                expect(doc.fullText.trim()).toBe('');
            }
        });
    });

    // ─── parseFolder ──────────────────────────────────────────────────────

    describe('parseFolder', () => {
        it('parses all supported files in a folder', async () => {
            fs.writeFileSync(path.join(tmpDir, 'readme.md'), '# Readme\n\nContent.\n');
            fs.writeFileSync(path.join(tmpDir, 'notes.txt'), 'Notes here.\n');
            fs.writeFileSync(path.join(tmpDir, 'data.json'), '{"key":"value"}\n');
            fs.writeFileSync(path.join(tmpDir, 'skip.exe'), Buffer.from([0x00]));

            const docs = await parser.parseFolder(tmpDir, false);
            expect(docs.length).toBeGreaterThanOrEqual(3);
        });

        it('handles recursive scanning', async () => {
            const subDir = path.join(tmpDir, 'sub');
            fs.mkdirSync(subDir);
            fs.writeFileSync(path.join(tmpDir, 'top.md'), '# Top\n');
            fs.writeFileSync(path.join(subDir, 'nested.md'), '# Nested\n');

            const docs = await parser.parseFolder(tmpDir, true);
            const filenames = docs.map((d: any) => d.filename);
            expect(filenames).toContain('top.md');
            expect(filenames).toContain('nested.md');
        });
    });
});
