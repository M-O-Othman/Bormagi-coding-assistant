import * as fs from 'fs';
import * as path from 'path';

export type PEC = {
  filesCreated: string[];
  dirsCreated: string[];
  hostOS: 'win32' | 'linux' | 'darwin';
  lastErrors: string[];
  planHash: string;
};

function initPEC() {
  const dirPath = path.join(process.cwd(), '.bormagi');
  const contextPath = path.join(dirPath, 'ctx.json');

  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  const initialContext: PEC = {
    filesCreated: [],
    dirsCreated: [],
    hostOS: process.platform as 'win32' | 'linux' | 'darwin',
    lastErrors: [],
    planHash: ''
  };

  fs.writeFileSync(contextPath, JSON.stringify(initialContext, null, 2), 'utf8');
  console.log(`Initialized PEC at ${contextPath}`);
}

if (require.main === module) {
  initPEC();
}
