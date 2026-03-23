import { classifyAndAdaptError } from '../../agents/execution/ErrorClassifier';

describe('ErrorClassifier Micro-Policy', () => {
    it('should adapt write_file duplicate-write error securely', () => {
        const result = classifyAndAdaptError(
            'write_file', 
            { path: 'test.ts', content: 'foo' }, 
            '[BLOCKED] File already exists at test.ts'
        );
        expect(result).toContain('[REMEDIATION]');
        expect(result).toContain('edit_file');
    });

    it('should not adapt normal successful messages', () => {
        const result = classifyAndAdaptError(
            'write_file', 
            { path: 'test.ts', content: 'foo' }, 
            'File written successfully'
        );
        expect(result).toBe('File written successfully');
    });

    it('should adapt Windows mkdir -p rejection', () => {
        const result = classifyAndAdaptError(
            'run_command', 
            { command: 'mkdir -p foo/bar' }, 
            '[BLOCKED] Unix command syntax "mkdir" is not available on this Windows host.'
        );
        expect(result).toContain('[REMEDIATION]');
        expect(result).toContain('mkdir');
    });

    it('should adapt WRITE_ONLY phase constraints', () => {
        const result = classifyAndAdaptError(
            'read_file',
            { path: 'test.ts' },
            '[READ BLOCKED] Repeated read_file call on "test.ts". Phase is now WRITE_ONLY.'
        );
        expect(result).toContain('[REMEDIATION]');
        expect(result).toContain('WRITE_ONLY phase');
    });
});
