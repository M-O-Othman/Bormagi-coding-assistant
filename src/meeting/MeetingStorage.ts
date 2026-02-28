import * as fs from 'fs';
import * as path from 'path';
import { Meeting } from './types';

export class MeetingStorage {
  private readonly meetingsDir: string;

  constructor(bormagiDir: string) {
    this.meetingsDir = path.join(bormagiDir, 'virtual-meetings');
  }

  private meetingDir(id: string): string {
    return path.join(this.meetingsDir, id);
  }

  private meetingFile(id: string): string {
    return path.join(this.meetingDir(id), 'meeting.json');
  }

  generateId(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `meeting-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  }

  async saveMeeting(m: Meeting): Promise<void> {
    const dir = this.meetingDir(m.id);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.meetingFile(m.id), JSON.stringify(m, null, 2), 'utf8');
  }

  async loadMeeting(id: string): Promise<Meeting | null> {
    const file = this.meetingFile(id);
    if (!fs.existsSync(file)) { return null; }
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as Meeting;
    } catch {
      return null;
    }
  }

  async listMeetingIds(): Promise<string[]> {
    if (!fs.existsSync(this.meetingsDir)) { return []; }
    return fs.readdirSync(this.meetingsDir).filter(name => {
      return fs.statSync(path.join(this.meetingsDir, name)).isDirectory();
    });
  }

  async saveMinutes(id: string, markdown: string): Promise<void> {
    const dir = this.meetingDir(id);
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    fs.writeFileSync(path.join(dir, 'minutes.md'), markdown, 'utf8');
  }
}
