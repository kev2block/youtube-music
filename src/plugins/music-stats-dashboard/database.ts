import { PlayRecord, DailyAggregate, MonthlyAggregate } from './types';

interface DatabaseSchema {
  playRecords: PlayRecord[];
  dailyAggregates: Record<string, DailyAggregate>;
  monthlyAggregates: Record<string, MonthlyAggregate>;
  streak: { lastListenDate: string; currentStreak: number } | null;
}

export class StatsDatabase {
  private dbPath: string;
  private data: DatabaseSchema;
  private saveTimer?: NodeJS.Timeout;
  private isDirty = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.data = {
      playRecords: [],
      dailyAggregates: {},
      monthlyAggregates: {},
      streak: null,
    };
  }

  async initialize() {
    try {
      // Lazy load Node.js modules
      const fs = (await import('node:fs/promises')).default || (await import('node:fs/promises'));
      const fileData = await fs.readFile(this.dbPath, 'utf-8');
      this.data = JSON.parse(fileData);
    } catch {
      this.data = {
        playRecords: [],
        dailyAggregates: {},
        monthlyAggregates: {},
        streak: null,
      };
    }

    this.saveTimer = setInterval(() => {
      if (this.isDirty) {
        this.save().catch(console.error);
      }
    }, 30000);
  }

  private async save() {
    try {
      // Lazy load Node.js modules
      const fs = (await import('node:fs/promises')).default || (await import('node:fs/promises'));
      const path = (await import('node:path')).default || (await import('node:path'));

      const dir = path.dirname(this.dbPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(this.dbPath, JSON.stringify(this.data, null, 2), 'utf-8');
      this.isDirty = false;
    } catch (error) {
      console.error('[Music Stats] Failed to save database:', error);
    }
  }

  private markDirty() {
    this.isDirty = true;
  }

  async addPlayRecord(record: PlayRecord): Promise<void> {
    this.data.playRecords.push({
      ...record,
      id: this.data.playRecords.length + 1,
    });
    this.markDirty();
  }

  async getPlayRecords(startDate?: number, endDate?: number): Promise<PlayRecord[]> {
    let records = this.data.playRecords;
    if (startDate && endDate) {
      records = records.filter((r) => r.timestamp >= startDate && r.timestamp <= endDate);
    } else if (startDate) {
      records = records.filter((r) => r.timestamp >= startDate);
    }
    return [...records].sort((a, b) => b.timestamp - a.timestamp);
  }

  async saveDailyAggregate(date: string, data: DailyAggregate): Promise<void> {
    this.data.dailyAggregates[date] = data;
    this.markDirty();
  }

  async getDailyAggregate(date: string): Promise<DailyAggregate | null> {
    return this.data.dailyAggregates[date] || null;
  }

  async saveMonthlyAggregate(yearMonth: string, data: MonthlyAggregate): Promise<void> {
    this.data.monthlyAggregates[yearMonth] = data;
    this.markDirty();
  }

  async getMonthlyAggregates(): Promise<MonthlyAggregate[]> {
    return Object.entries(this.data.monthlyAggregates)
      .map(([yearMonth, data]) => ({ yearMonth, ...data }))
      .sort((a, b) => b.yearMonth.localeCompare(a.yearMonth));
  }

  async updateStreak(date: string, streak: number): Promise<void> {
    this.data.streak = { lastListenDate: date, currentStreak: streak };
    this.markDirty();
  }

  async getStreak(): Promise<{ lastListenDate: string; currentStreak: number } | null> {
    return this.data.streak;
  }

  async exportData(): Promise<string> {
    return JSON.stringify({ version: 1, exportDate: Date.now(), ...this.data }, null, 2);
  }

  async importData(jsonData: string): Promise<void> {
    const imported = JSON.parse(jsonData);
    this.data = {
      playRecords: imported.playRecords || [],
      dailyAggregates: imported.dailyAggregates || {},
      monthlyAggregates: imported.monthlyAggregates || {},
      streak: imported.streak || null,
    };
    this.markDirty();
    await this.save();
  }

  async close() {
    if (this.saveTimer) {
      clearInterval(this.saveTimer);
    }
    if (this.isDirty) {
      await this.save();
    }
  }
}
