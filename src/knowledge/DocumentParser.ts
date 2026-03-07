// ─── Document parser ─────────────────────────────────────────────────────────
//
// Converts raw files into ParsedDocument objects.
// Supported: Markdown, HTML, PDF, DOCX, XLSX/CSV, plain text, JSON, YAML, images.
// Each parser is a private method; the public `parse` method dispatches by extension.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { ParsedDocument, DocumentSection, DocumentFormat } from './types';

/** Map file extensions to our DocumentFormat enum. */
const EXT_MAP: Record<string, DocumentFormat> = {
    '.md': 'markdown',
    '.markdown': 'markdown',
    '.html': 'html',
    '.htm': 'html',
    '.pdf': 'pdf',
    '.docx': 'docx',
    '.xlsx': 'xlsx',
    '.csv': 'csv',
    '.txt': 'text',
    '.json': 'json',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.png': 'image',
    '.jpg': 'image',
    '.jpeg': 'image',
    '.gif': 'image',
    '.svg': 'image',
    '.webp': 'image',
};

/**
 * Parse a single file from disk into a structured ParsedDocument.
 */
export class DocumentParser {
    /** Detect format from file extension. Returns undefined for unsupported types. */
    static detectFormat(filePath: string): DocumentFormat | undefined {
        const ext = path.extname(filePath).toLowerCase();
        return EXT_MAP[ext];
    }

    /** Return list of supported extensions. */
    static supportedExtensions(): string[] {
        return Object.keys(EXT_MAP);
    }

    /**
     * Parse a file and return a ParsedDocument, or null if the file format is
     * unsupported or the file is empty/unreadable.
     */
    async parse(filePath: string): Promise<ParsedDocument | null> {
        const format = DocumentParser.detectFormat(filePath);
        if (!format) { return null; }

        const stat = fs.statSync(filePath);
        const filename = path.basename(filePath);
        const id = this.makeId(filePath, stat.mtimeMs);

        try {
            switch (format) {
                case 'markdown': return this.parseMarkdown(filePath, id, filename);
                case 'html': return this.parseHTML(filePath, id, filename);
                case 'pdf': return this.parsePDF(filePath, id, filename);
                case 'docx': return this.parseDOCX(filePath, id, filename);
                case 'xlsx': return this.parseXLSX(filePath, id, filename);
                case 'csv': return this.parseCSV(filePath, id, filename);
                case 'text': return this.parseText(filePath, id, filename);
                case 'json': return this.parseJSON(filePath, id, filename);
                case 'yaml': return this.parseYAML(filePath, id, filename);
                case 'image': return this.parseImage(filePath, id, filename);
                default: return null;
            }
        } catch (err) {
            console.error(`DocumentParser: Failed to parse ${filePath}:`, err);
            return null;
        }
    }

    /**
     * Parse all supported files in a directory (non-recursive by default).
     */
    async parseFolder(folderPath: string, recursive = true): Promise<ParsedDocument[]> {
        const results: ParsedDocument[] = [];
        const entries = fs.readdirSync(folderPath, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(folderPath, entry.name);
            if (entry.isDirectory() && recursive) {
                const sub = await this.parseFolder(fullPath, true);
                results.push(...sub);
            } else if (entry.isFile()) {
                const doc = await this.parse(fullPath);
                if (doc) { results.push(doc); }
            }
        }
        return results;
    }

    // ─── Private parsers ───────────────────────────────────────────────────

    private async parseMarkdown(filePath: string, id: string, filename: string): Promise<ParsedDocument> {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const sections = this.extractMarkdownSections(raw);
        return { id, filename, format: 'markdown', fullText: raw, sections, metadata: {} };
    }

    private async parseHTML(filePath: string, id: string, filename: string): Promise<ParsedDocument> {
        const raw = fs.readFileSync(filePath, 'utf-8');
        // Simple tag stripping — avoids heavy cheerio dependency for now.
        // We strip script/style blocks first, then all remaining tags.
        const noScripts = raw.replace(/<script[\s\S]*?<\/script>/gi, '');
        const noStyles = noScripts.replace(/<style[\s\S]*?<\/style>/gi, '');
        const text = noStyles.replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/\s+/g, ' ')
            .trim();
        return { id, filename, format: 'html', fullText: text, sections: [{ heading: filename, path: filename, content: text, depth: 0 }], metadata: {} };
    }

    private async parsePDF(filePath: string, id: string, filename: string): Promise<ParsedDocument> {
        try {
            // Dynamic import so the module is only loaded when needed
            const pdfParse = require('pdf-parse');
            const buffer = fs.readFileSync(filePath);
            const data = await pdfParse(buffer);
            const text: string = data.text || '';
            return {
                id, filename, format: 'pdf', fullText: text,
                sections: [{ heading: filename, path: filename, content: text, depth: 0 }],
                metadata: { pages: data.numpages, info: data.info },
            };
        } catch {
            console.warn(`DocumentParser: pdf-parse not available, skipping ${filename}`);
            return { id, filename, format: 'pdf', fullText: '', sections: [], metadata: { error: 'pdf-parse not installed' } };
        }
    }

    private async parseDOCX(filePath: string, id: string, filename: string): Promise<ParsedDocument> {
        try {
            const mammoth = require('mammoth');
            const result = await mammoth.extractRawText({ path: filePath });
            const text: string = result.value || '';
            return {
                id, filename, format: 'docx', fullText: text,
                sections: [{ heading: filename, path: filename, content: text, depth: 0 }],
                metadata: {},
            };
        } catch {
            console.warn(`DocumentParser: mammoth not available, skipping ${filename}`);
            return { id, filename, format: 'docx', fullText: '', sections: [], metadata: { error: 'mammoth not installed' } };
        }
    }

    private async parseXLSX(filePath: string, id: string, filename: string): Promise<ParsedDocument> {
        try {
            const ExcelJS = require('exceljs');
            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.readFile(filePath);

            const sections: DocumentSection[] = [];
            const textParts: string[] = [];

            workbook.eachSheet((worksheet: any) => {
                const sheetName = worksheet.name;
                const rows: string[] = [];

                worksheet.eachRow((row: any) => {
                    const rowValues: string[] = [];
                    row.eachCell({ includeEmpty: true }, (cell: any) => {
                        let val = cell.value;
                        if (val !== null && typeof val === 'object' && val.result !== undefined) {
                            val = val.result;
                        } else if (val !== null && typeof val === 'object' && val.text !== undefined) {
                            val = val.text;
                        }

                        let str = val !== null && val !== undefined ? String(val) : '';
                        if (str.includes(',') || str.includes('\n') || str.includes('"')) {
                            str = `"${str.replace(/"/g, '""')}"`;
                        }
                        rowValues.push(str);
                    });
                    rows.push(rowValues.join(','));
                });

                const csv = rows.join('\n');
                sections.push({ heading: sheetName, path: `${filename} > ${sheetName}`, content: csv, depth: 0 });
                textParts.push(`## ${sheetName}\n${csv}`);
            });

            return { id, filename, format: 'xlsx', fullText: textParts.join('\n\n'), sections, metadata: { sheetCount: workbook.worksheets.length } };
        } catch (err) {
            console.warn(`DocumentParser: exceljs parse failed for ${filename}:`, err);
            return { id, filename, format: 'xlsx', fullText: '', sections: [], metadata: { error: 'exceljs parse failed' } };
        }
    }

    private async parseCSV(filePath: string, id: string, filename: string): Promise<ParsedDocument> {
        const raw = fs.readFileSync(filePath, 'utf-8');
        return { id, filename, format: 'csv', fullText: raw, sections: [{ heading: filename, path: filename, content: raw, depth: 0 }], metadata: {} };
    }

    private async parseText(filePath: string, id: string, filename: string): Promise<ParsedDocument> {
        const raw = fs.readFileSync(filePath, 'utf-8');
        return { id, filename, format: 'text', fullText: raw, sections: [{ heading: filename, path: filename, content: raw, depth: 0 }], metadata: {} };
    }

    private async parseJSON(filePath: string, id: string, filename: string): Promise<ParsedDocument> {
        const raw = fs.readFileSync(filePath, 'utf-8');
        // Pretty-print for readability in chunks
        let text = raw;
        try { text = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* keep raw */ }
        return { id, filename, format: 'json', fullText: text, sections: [{ heading: filename, path: filename, content: text, depth: 0 }], metadata: {} };
    }

    private async parseYAML(filePath: string, id: string, filename: string): Promise<ParsedDocument> {
        const raw = fs.readFileSync(filePath, 'utf-8');
        return { id, filename, format: 'yaml', fullText: raw, sections: [{ heading: filename, path: filename, content: raw, depth: 0 }], metadata: {} };
    }

    private async parseImage(filePath: string, id: string, filename: string): Promise<ParsedDocument> {
        // For images, store a placeholder description. In the future, OCR or vision model
        // could extract text / describe the image.
        const text = `[Image file: ${filename}]`;
        return { id, filename, format: 'image', fullText: text, sections: [{ heading: filename, path: filename, content: text, depth: 0 }], metadata: { type: 'image' } };
    }

    // ─── Helpers ────────────────────────────────────────────────────────────

    /** Create a deterministic ID from file path and modification time. */
    private makeId(filePath: string, mtimeMs: number): string {
        const hash = crypto.createHash('sha256')
            .update(`${filePath}:${mtimeMs}`)
            .digest('hex')
            .slice(0, 16);
        return hash;
    }

    /**
     * Extract heading-based sections from Markdown text.
     * Each heading (# through ####) starts a new section.
     */
    private extractMarkdownSections(text: string): DocumentSection[] {
        const lines = text.split('\n');
        const sections: DocumentSection[] = [];
        let currentHeading = 'Introduction';
        let currentPath = 'Introduction';
        let currentDepth = 0;
        let currentContent: string[] = [];
        const headingStack: string[] = [];

        for (const line of lines) {
            const match = line.match(/^(#{1,4})\s+(.+)/);
            if (match) {
                // Flush previous section
                if (currentContent.length > 0) {
                    const content = currentContent.join('\n').trim();
                    if (content) {
                        sections.push({ heading: currentHeading, path: currentPath, content, depth: currentDepth });
                    }
                    currentContent = [];
                }

                const depth = match[1].length - 1;
                const heading = match[2].trim();
                currentHeading = heading;
                currentDepth = depth;

                // Maintain heading hierarchy for path
                headingStack.length = depth;
                headingStack.push(heading);
                currentPath = headingStack.join(' > ');
            } else {
                currentContent.push(line);
            }
        }

        // Flush last section
        if (currentContent.length > 0) {
            const content = currentContent.join('\n').trim();
            if (content) {
                sections.push({ heading: currentHeading, path: currentPath, content, depth: currentDepth });
            }
        }

        // If no sections found, return entire text as one section
        if (sections.length === 0 && text.trim()) {
            sections.push({ heading: 'Content', path: 'Content', content: text.trim(), depth: 0 });
        }

        return sections;
    }
}
