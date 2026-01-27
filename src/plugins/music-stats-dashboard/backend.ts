import type { IpcMain } from 'electron';
// CRITICAL: Use "import type" so the class is not bundled for the browser
import type { StatsDatabase } from './database';
import type { PlayRecord, StatsConfig, StatsData } from './types';

// Define channels statically to ensure we can clean them up reliably
const IPC_CHANNELS = {
  ADD_RECORD: 'music-stats:add-play-record',
  GET_STATS: 'music-stats:get-stats',
  EXPORT: 'music-stats:export-data',
  IMPORT: 'music-stats:import-data',
  SAVE_FILE: 'music-stats:save-export-file',
  LOAD_FILE: 'music-stats:load-import-file',
  ARTIST_IMAGE: 'music-stats:artist-image',
  DRIVE_CONNECT: 'music-stats:drive-connect',
  DRIVE_SYNC: 'music-stats:drive-sync',
  DRIVE_STATUS: 'music-stats:drive-status',
  DRIVE_DISCONNECT: 'music-stats:drive-disconnect',
};

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const DRIVE_FILE_NAME = 'music-stats.json';

export class StatsBackend {
  private db: StatsDatabase | null = null;
  private aggregationTimer?: NodeJS.Timeout;
  private syncTimer?: NodeJS.Timeout;
  private isSyncing = false;
  private getConfig: () => Promise<StatsConfig> | StatsConfig;
  private setConfig: (
    conf: Partial<Omit<StatsConfig, 'enabled'>>,
  ) => Promise<void> | void;
  private sessionAccessToken: string | null = null;
  private sessionAccessTokenExpiry = 0;
  private sessionRefreshToken: string | null = null;

  constructor(context: {
    getConfig: () => Promise<StatsConfig> | StatsConfig;
    setConfig: (
      conf: Partial<Omit<StatsConfig, 'enabled'>>,
    ) => Promise<void> | void;
  }) {
    this.getConfig = context.getConfig;
    this.setConfig = context.setConfig;
  }

  async initialize() {
    // Dynamically import Node.js modules here so browser doesn't crash
    const { app, ipcMain, dialog, net, shell } = await import('electron');
    const path =
      (await import('node:path')).default || (await import('node:path'));
    const fs =
      (await import('node:fs/promises')).default ||
      (await import('node:fs/promises'));
    const crypto =
      (await import('node:crypto')).default || (await import('node:crypto'));

    // Dynamically import the Database class to break static dependency
    const { StatsDatabase } = await import('./database');

    // Initialize DB
    const dbPath = path.join(app.getPath('userData'), 'music-stats.json');
    this.db = new StatsDatabase(dbPath);
    await this.db.initialize();

    this.setupIpcHandlers(ipcMain, dialog, fs, net, shell, crypto);
    this.startAggregationTimer();

    const config = await this.getConfig();
    if (config.cloudSyncEnabled) {
      this.startSyncTimer();
    }
  }

  private setupIpcHandlers(
    ipcMain: IpcMain,
    dialog: any,
    fs: any,
    net: any,
    shell: any,
    crypto: any,
  ) {
    // CRITICAL FIX: Force remove handlers before adding them to prevent "Second handler" error on reload
    for (const channel of Object.values(IPC_CHANNELS)) {
      ipcMain.removeHandler(channel);
    }

    ipcMain.handle(IPC_CHANNELS.ADD_RECORD, async (_, record: PlayRecord) => {
      if (!this.db) return;
      await this.db.addPlayRecord(record);
      await this.updateStreak(record.timestamp);
    });

    ipcMain.handle(IPC_CHANNELS.GET_STATS, async () => {
      if (!this.db) return null;
      return await this.computeStats();
    });

    ipcMain.handle(IPC_CHANNELS.EXPORT, async () => {
      if (!this.db) return null;
      return await this.db.exportData();
    });

    ipcMain.handle(IPC_CHANNELS.IMPORT, async (_, jsonData: string) => {
      if (!this.db) return;
      await this.db.importData(jsonData);
    });

    ipcMain.handle(IPC_CHANNELS.SAVE_FILE, async (_, data: string) => {
      const result = await dialog.showSaveDialog({
        title: 'Export Music Stats',
        defaultPath: `music-stats-${new Date().toISOString().split('T')[0]}.json`,
        filters: [{ name: 'JSON Files', extensions: ['json'] }],
      });

      if (!result.canceled && result.filePath) {
        await fs.writeFile(result.filePath, data, 'utf-8');
        return true;
      }
      return false;
    });

    ipcMain.handle(IPC_CHANNELS.LOAD_FILE, async () => {
      const result = await dialog.showOpenDialog({
        title: 'Import Music Stats',
        filters: [{ name: 'JSON Files', extensions: ['json'] }],
        properties: ['openFile'],
      });

      if (!result.canceled && result.filePaths.length > 0) {
        const data = await fs.readFile(result.filePaths[0], 'utf-8');
        return data;
      }
      return null;
    });

    ipcMain.handle(
      IPC_CHANNELS.ARTIST_IMAGE,
      async (_, payload: { artistUrl?: string; artistId?: string }) => {
        const urls: string[] = [];
        if (payload.artistUrl) urls.push(payload.artistUrl);
        if (payload.artistId) {
          urls.push(`https://music.youtube.com/channel/${payload.artistId}`);
          urls.push(`https://www.youtube.com/channel/${payload.artistId}`);
        }

        for (const url of urls) {
          try {
            const response = await net.fetch(url, { method: 'GET' });
            if (!response.ok) continue;
            const html = await response.text();
            const imageUrl = extractArtistImage(html);
            if (imageUrl) return imageUrl;
          } catch (error) {
            console.warn('[Music Stats] Failed to fetch artist image', error);
          }
        }
        return null;
      },
    );

    ipcMain.handle(IPC_CHANNELS.DRIVE_STATUS, async () => {
      const config = await this.getConfig();
      return this.getDriveStatus(config);
    });

    ipcMain.handle(IPC_CHANNELS.DRIVE_CONNECT, async () => {
      const config = await this.getConfig();
      const result = await this.startDriveAuth(config, dialog, shell, net);
      return result;
    });

    ipcMain.handle(IPC_CHANNELS.DRIVE_SYNC, async () => {
      const config = await this.getConfig();
      return await this.syncDriveNow(config, net, crypto);
    });

    ipcMain.handle(IPC_CHANNELS.DRIVE_DISCONNECT, async () => {
      await this.setConfig({
        cloudSyncEnabled: false,
        cloudSyncRefreshToken: '',
        cloudSyncAccessToken: '',
        cloudSyncAccessTokenExpiry: 0,
        cloudSyncFileId: '',
        cloudSyncLastHash: '',
        cloudSyncLastSyncTime: '',
        cloudSyncLastError: '',
      });
      this.stopSyncTimer();
      return { ok: true, message: 'Google Drive disconnected.' };
    });
  }

  private startAggregationTimer() {
    this.aggregationTimer = setInterval(
      () => {
        this.aggregateDailyStats().catch(console.error);
      },
      60 * 60 * 1000,
    );
    this.aggregateDailyStats().catch(console.error);
  }

  private startSyncTimer() {
    if (this.syncTimer) return;
    this.syncTimer = setInterval(
      () => {
        Promise.resolve(this.getConfig())
          .then((config) => this.syncDriveNow(config, null, null))
          .catch(console.error);
      },
      10 * 60 * 1000,
    );
  }

  private stopSyncTimer() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }
  }

  async onConfigChange(newConfig: StatsConfig) {
    if (newConfig.cloudSyncEnabled) {
      this.startSyncTimer();
    } else {
      this.stopSyncTimer();
    }
  }

  private async aggregateDailyStats() {
    if (!this.db) return;
    const today = new Date().toISOString().split('T')[0];
    const startOfDay = new Date(today).getTime();
    const endOfDay = startOfDay + 24 * 60 * 60 * 1000 - 1;

    const records = await this.db.getPlayRecords(startOfDay, endOfDay);
    if (records.length === 0) return;

    const songMap = new Map<string, number>();
    const artistMap = new Map<string, number>();
    const hourlyMap = new Array(24).fill(0);
    let skipCount = 0;

    for (const record of records) {
      songMap.set(record.songId, (songMap.get(record.songId) || 0) + 1);
      artistMap.set(record.artistId, (artistMap.get(record.artistId) || 0) + 1);
      const hour = new Date(record.timestamp).getHours();
      hourlyMap[hour] += 1;
      if (record.skipped) skipCount++;
    }

    const totalMinutes = records.reduce(
      (sum, r) => sum + r.durationListened / 60,
      0,
    );

    const topSongs = Array.from(songMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id, plays]) => {
        const record = records.find((r) => r.songId === id)!;
        return { id, title: record.songTitle, plays };
      });

    const topArtists = Array.from(artistMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([id, plays]) => {
        const record = records.find((r) => r.artistId === id)!;
        return { id, name: record.artistName, plays };
      });

    const genreBreakdown: Record<string, number> = {};

    await this.db.saveDailyAggregate(today, {
      date: today,
      totalMinutes: Math.round(totalMinutes * 10) / 10,
      songsPlayed: records.length,
      uniqueSongs: new Set(records.map((r) => r.songId)).size,
      uniqueArtists: new Set(records.map((r) => r.artistId)).size,
      topSongs,
      topArtists,
      genreBreakdown,
      hourlyBreakdown: hourlyMap,
      skipCount,
    });
  }

  private async updateStreak(timestamp: number) {
    if (!this.db) return;
    const today = new Date(timestamp).toISOString().split('T')[0];
    const streakData = await this.db.getStreak();

    if (!streakData) {
      await this.db.updateStreak(today, 1);
      return;
    }

    const lastDate = new Date(streakData.lastListenDate);
    const currentDate = new Date(today);
    const diffDays = Math.floor(
      (currentDate.getTime() - lastDate.getTime()) / (24 * 60 * 60 * 1000),
    );

    if (diffDays === 1) {
      await this.db.updateStreak(today, streakData.currentStreak + 1);
    } else if (diffDays > 1) {
      await this.db.updateStreak(today, 1);
    }
  }

  private async computeStats(): Promise<StatsData> {
    if (!this.db) throw new Error('DB not initialized');
    const allRecords = await this.db.getPlayRecords();

    const totalMinutes = Math.round(
      allRecords.reduce((sum, r) => sum + r.durationListened / 60, 0),
    );
    const isQualifiedPlay = (record: PlayRecord) =>
      record.durationListened >= 30;
    const totalSongs = allRecords.filter(isQualifiedPlay).length;

    const songPlayMap = new Map<
      string,
      {
        title: string;
        artist: string;
        plays: number;
        minutes: number;
        imageUrl?: string;
      }
    >();
    const artistPlayMap = new Map<
      string,
      { name: string; plays: number; minutes: number; imageUrl?: string }
    >();
    const listeningClock = new Array(24).fill(0);
    const dailyMap = new Map<string, number>();
    const monthlyArtists = new Map<string, Map<string, number>>();
    const skipMap = new Map<
      string,
      {
        title: string;
        artist: string;
        skips: number;
        plays: number;
        imageUrl?: string;
      }
    >();

    for (const record of allRecords) {
      // Songs
      const qualifiedPlay = isQualifiedPlay(record);
      const sExisting = songPlayMap.get(record.songId);
      if (sExisting) {
        if (qualifiedPlay) sExisting.plays++;
        sExisting.minutes += record.durationListened / 60;
        if (!sExisting.imageUrl && record.thumbnailUrl) {
          sExisting.imageUrl = record.thumbnailUrl;
        }
      } else {
        songPlayMap.set(record.songId, {
          title: record.songTitle,
          artist: record.artistName,
          plays: qualifiedPlay ? 1 : 0,
          minutes: record.durationListened / 60,
          imageUrl: record.thumbnailUrl,
        });
      }

      // Artists
      const aExisting = artistPlayMap.get(record.artistId);
      if (aExisting) {
        if (qualifiedPlay) aExisting.plays++;
        aExisting.minutes += record.durationListened / 60;
        if (!aExisting.imageUrl && record.artistImageUrl) {
          aExisting.imageUrl = record.artistImageUrl;
        }
      } else {
        artistPlayMap.set(record.artistId, {
          name: record.artistName,
          plays: qualifiedPlay ? 1 : 0,
          minutes: record.durationListened / 60,
          imageUrl: record.artistImageUrl,
        });
      }

      // Clock
      const hour = new Date(record.timestamp).getHours();
      listeningClock[hour] += record.durationListened / 60;

      // Daily
      const date = new Date(record.timestamp).toISOString().split('T')[0];
      dailyMap.set(
        date,
        (dailyMap.get(date) || 0) + record.durationListened / 60,
      );

      // Monthly Obsessions
      const yearMonth = new Date(record.timestamp).toISOString().slice(0, 7);
      if (!monthlyArtists.has(yearMonth))
        monthlyArtists.set(yearMonth, new Map());
      const monthMap = monthlyArtists.get(yearMonth)!;
      monthMap.set(
        record.artistId,
        (monthMap.get(record.artistId) || 0) + record.durationListened / 60,
      );

      // Skips
      const skipExisting = skipMap.get(record.songId);
      if (skipExisting) {
        if (qualifiedPlay) skipExisting.plays++;
        if (record.skipped) skipExisting.skips++;
        if (!skipExisting.imageUrl && record.thumbnailUrl) {
          skipExisting.imageUrl = record.thumbnailUrl;
        }
      } else {
        skipMap.set(record.songId, {
          title: record.songTitle,
          artist: record.artistName,
          skips: record.skipped ? 1 : 0,
          plays: qualifiedPlay ? 1 : 0,
          imageUrl: record.thumbnailUrl,
        });
      }
    }

    const coverUrl = (id: string, imageUrl?: string) =>
      imageUrl ||
      (/^[a-zA-Z0-9_-]{11}$/.test(id)
        ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
        : undefined);

    const topSongs = Array.from(songPlayMap.entries())
      .sort((a, b) => b[1].plays - a[1].plays)
      .slice(0, 5)
      .map(([id, data]) => ({
        id,
        title: data.title,
        artist: data.artist,
        plays: data.plays,
        minutes: Math.round(data.minutes),
        imageUrl: coverUrl(id, data.imageUrl),
      }));

    const topArtists = Array.from(artistPlayMap.entries())
      .sort((a, b) => b[1].minutes - a[1].minutes)
      .slice(0, 5)
      .map(([id, data]) => ({
        id,
        name: data.name,
        plays: data.plays,
        minutes: Math.round(data.minutes),
        imageUrl: data.imageUrl,
      }));

    let peakListeningDay: { date: string; minutes: number } | undefined;
    let maxMinutes = 0;
    for (const [date, minutes] of dailyMap) {
      if (minutes > maxMinutes) {
        maxMinutes = minutes;
        peakListeningDay = { date, minutes: Math.round(minutes) };
      }
    }

    const monthlyObsessions = Array.from(monthlyArtists.entries())
      .map(([yearMonth, artistMap]) => {
        const topArtist = Array.from(artistMap.entries()).sort(
          (a, b) => b[1] - a[1],
        )[0];
        const artistName =
          allRecords.find((r) => r.artistId === topArtist[0])?.artistName ||
          'Unknown';
        return {
          yearMonth,
          artist: artistName,
          minutes: Math.round(topArtist[1]),
        };
      })
      .sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));

    const skipStats = Array.from(skipMap.entries())
      .filter(([, data]) => data.skips > 0)
      .sort((a, b) => b[1].skips - a[1].skips)
      .slice(0, 10)
      .map(([songId, data]) => ({
        songId,
        title: data.title,
        artist: data.artist,
        skips: data.skips,
        plays: data.plays,
        imageUrl: data.imageUrl,
      }));

    const sortedRecords = [...allRecords].sort(
      (a, b) => a.timestamp - b.timestamp,
    );
    const streakData = await this.db.getStreak();
    const currentYear = new Date().getFullYear();
    const firstThisYear = sortedRecords.find(
      (r) => new Date(r.timestamp).getFullYear() === currentYear,
    );
    const totalSkips = allRecords.filter((r) => r.skipped).length;
    const skipRate = Math.min(
      100,
      Math.round((totalSkips / Math.max(1, allRecords.length)) * 100),
    );

    return {
      totalMinutes,
      totalSongs,
      topSongs,
      topArtists,
      anthem: topSongs[0]
        ? {
            id: topSongs[0].id,
            title: topSongs[0].title,
            artist: topSongs[0].artist,
            plays: topSongs[0].plays,
          }
        : undefined,
      peakListeningDay,
      listeningClock: listeningClock.map((m) => Math.round(m)),
      currentStreak: streakData?.currentStreak || 0,
      firstSongEver: sortedRecords[0]
        ? {
            title: sortedRecords[0].songTitle,
            artist: sortedRecords[0].artistName,
            date: new Date(sortedRecords[0].timestamp)
              .toISOString()
              .split('T')[0],
          }
        : undefined,
      firstSongThisYear: firstThisYear
        ? {
            title: firstThisYear.songTitle,
            artist: firstThisYear.artistName,
            date: new Date(firstThisYear.timestamp).toISOString().split('T')[0],
          }
        : undefined,
      firstSongThisMonth: undefined,
      monthlyObsessions,
      skipStats,
      skipRate,
    };
  }

  async cleanup() {
    if (this.aggregationTimer) {
      clearInterval(this.aggregationTimer);
    }
    // No need to manually remove handlers here as the new instance will force remove them
    // via the setupIpcHandlers method using the static IPC_CHANNELS list.
    if (this.db) {
      await this.db.close();
    }
  }

  private getDriveStatus(config: StatsConfig) {
    return {
      enabled: !!config.cloudSyncEnabled,
      connected: !!config.cloudSyncRefreshToken,
      lastSyncTime: config.cloudSyncLastSyncTime || null,
      lastError: config.cloudSyncLastError || null,
    };
  }

  private async startDriveAuth(
    config: StatsConfig,
    dialog: any,
    shell: any,
    net: any,
  ) {
    if (!config.cloudSyncClientId) {
      return { ok: false, message: 'Missing Google OAuth Client ID.' };
    }

    const http =
      (await import('node:http')).default || (await import('node:http'));
    const crypto =
      (await import('node:crypto')).default || (await import('node:crypto'));
    const codeVerifier = base64UrlEncode(crypto.randomBytes(32));
    const codeChallenge = base64UrlEncode(
      crypto.createHash('sha256').update(codeVerifier).digest(),
    );

    const result = await new Promise<{ ok: boolean; message: string }>(
      (resolve) => {
        let redirectUri = '';
        const server = http.createServer(async (req: any, res: any) => {
          if (!req?.url?.startsWith('/oauth2callback')) {
            res.writeHead(404);
            res.end();
            return;
          }

          const url = new URL(req.url, 'http://127.0.0.1');
          const code = url.searchParams.get('code');
          const error = url.searchParams.get('error');

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<h3>You can close this window now.</h3>');

          server.close();

          if (!code || error) {
            resolve({
              ok: false,
              message: 'Google authorization was cancelled or failed.',
            });
            return;
          }

          try {
            const tokenResponse = await net.fetch(
              'https://oauth2.googleapis.com/token',
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: new URLSearchParams({
                  client_id: config.cloudSyncClientId,
                  client_secret: config.cloudSyncClientSecret || '',
                  grant_type: 'authorization_code',
                  code,
                  code_verifier: codeVerifier,
                  redirect_uri: redirectUri,
                }).toString(),
              },
            );

            if (!tokenResponse.ok) {
              const errorText = await safeReadResponse(tokenResponse);
              const message =
                `Failed to exchange token. ${errorText || ''}`.trim();
              await this.setConfig({
                cloudSyncLastError: message,
              });
              resolve({ ok: false, message });
              return;
            }

            const tokenJson = await tokenResponse.json();
            this.sessionAccessToken = tokenJson.access_token || null;
            this.sessionAccessTokenExpiry =
              Date.now() + (tokenJson.expires_in ?? 3600) * 1000 - 60000;
            this.sessionRefreshToken = tokenJson.refresh_token || null;

            if (!tokenJson.refresh_token) {
              await this.setConfig({
                cloudSyncEnabled: true,
                cloudSyncAccessToken: tokenJson.access_token || '',
                cloudSyncAccessTokenExpiry:
                  Date.now() + (tokenJson.expires_in ?? 3600) * 1000 - 60000,
                cloudSyncLastError:
                  'No refresh token returned. You will need to re-login after restart. Revoke access and re-consent to fix.',
              });
              resolve({
                ok: false,
                message:
                  'Logged in without refresh token. You will need to re-login after restart.',
              });
              return;
            }

            await this.setConfig({
              cloudSyncEnabled: true,
              cloudSyncRefreshToken: tokenJson.refresh_token,
              cloudSyncAccessToken: tokenJson.access_token,
              cloudSyncAccessTokenExpiry:
                Date.now() + (tokenJson.expires_in ?? 3600) * 1000 - 60000,
              cloudSyncLastError: '',
            });
            this.startSyncTimer();

            resolve({ ok: true, message: 'Google Drive connected.' });
          } catch (err) {
            const message =
              `Google authorization failed. ${(err as Error)?.message || ''}`.trim();
            await this.setConfig({
              cloudSyncLastError: message,
            });
            resolve({ ok: false, message });
          }
        });

        server.listen(0, '127.0.0.1', async () => {
          const address = server.address() as { port?: number } | null;
          const port = address?.port;
          if (!port) {
            server.close();
            resolve({
              ok: false,
              message: 'Failed to start local callback server.',
            });
            return;
          }
          redirectUri = `http://127.0.0.1:${port}/oauth2callback`;

          const authUrl = new URL(
            'https://accounts.google.com/o/oauth2/v2/auth',
          );
          authUrl.searchParams.set('client_id', config.cloudSyncClientId);
          authUrl.searchParams.set('redirect_uri', redirectUri);
          authUrl.searchParams.set('response_type', 'code');
          authUrl.searchParams.set('scope', DRIVE_SCOPE);
          authUrl.searchParams.set('code_challenge', codeChallenge);
          authUrl.searchParams.set('code_challenge_method', 'S256');
          authUrl.searchParams.set('access_type', 'offline');
          authUrl.searchParams.set('prompt', 'consent');

          const dialogResult = await dialog.showMessageBox({
            type: 'info',
            title: 'Google Drive Sync',
            message: 'Authorize Google Drive Sync',
            detail:
              'A browser window will open to sign in. After approving, you can close it.',
            buttons: ['Open Google', 'Cancel'],
            defaultId: 0,
            cancelId: 1,
          });

          if (dialogResult.response === 1) {
            server.close();
            await this.setConfig({
              cloudSyncLastError: 'Google authorization cancelled.',
            });
            resolve({ ok: false, message: 'Google authorization cancelled.' });
            return;
          }

          shell.openExternal(authUrl.toString()).catch(console.error);

          setTimeout(
            async () => {
              try {
                server.close();
              } catch {}
              await this.setConfig({
                cloudSyncLastError: 'Google authorization timed out.',
              });
              resolve({
                ok: false,
                message: 'Google authorization timed out.',
              });
            },
            5 * 60 * 1000,
          );
        });
      },
    );

    return result;
  }

  private async ensureAccessToken(config: StatsConfig, net: any) {
    const now = Date.now();
    if (
      config.cloudSyncAccessToken &&
      config.cloudSyncAccessTokenExpiry &&
      config.cloudSyncAccessTokenExpiry > now + 60000
    ) {
      return config.cloudSyncAccessToken;
    }

    if (
      this.sessionAccessToken &&
      this.sessionAccessTokenExpiry > now + 60000
    ) {
      return this.sessionAccessToken;
    }

    if (
      !config.cloudSyncClientId ||
      (!config.cloudSyncRefreshToken && !this.sessionRefreshToken)
    ) {
      throw new Error('Missing refresh token. Reconnect Google Drive.');
    }

    const refreshToken =
      config.cloudSyncRefreshToken || this.sessionRefreshToken;

    const body = new URLSearchParams({
      client_id: config.cloudSyncClientId,
      client_secret: config.cloudSyncClientSecret || '',
      refresh_token: refreshToken || '',
      grant_type: 'refresh_token',
    });

    const response = await net.fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await safeReadResponse(response);
      throw new Error(
        `Failed to refresh Google token. ${errorText || ''}`.trim(),
      );
    }

    const json = await response.json();
    const accessToken = json.access_token as string | undefined;
    if (!accessToken) throw new Error('Missing access token.');

    this.sessionAccessToken = accessToken;
    this.sessionAccessTokenExpiry =
      Date.now() + (json.expires_in ?? 3600) * 1000 - 60000;

    await this.setConfig({
      cloudSyncAccessToken: accessToken,
      cloudSyncAccessTokenExpiry:
        Date.now() + (json.expires_in ?? 3600) * 1000 - 60000,
      cloudSyncLastError: '',
    });

    return accessToken;
  }

  private async syncDriveNow(config: StatsConfig, net: any, crypto: any) {
    if (this.isSyncing)
      return { ok: false, message: 'Sync already in progress.' };
    if (!this.db) return { ok: false, message: 'Database not ready.' };
    if (!config.cloudSyncEnabled)
      return { ok: false, message: 'Cloud sync is disabled.' };
    if (!config.cloudSyncClientId) {
      return { ok: false, message: 'Connect Google Drive first.' };
    }
    if (
      !config.cloudSyncRefreshToken &&
      !config.cloudSyncAccessToken &&
      !this.sessionAccessToken
    ) {
      return { ok: false, message: 'Connect Google Drive first.' };
    }

    this.isSyncing = true;
    try {
      if (!net || !crypto) {
        const electron = await import('electron');
        net = electron.net;
        crypto =
          (await import('node:crypto')).default ||
          (await import('node:crypto'));
      }

      const accessToken = await this.ensureAccessToken(config, net);
      const localJson = await this.db.exportData();
      const localHash = hashString(localJson, crypto);
      const localParsed = parseExport(localJson);

      let fileId = config.cloudSyncFileId || '';
      if (!fileId) {
        const found = await this.findDriveFile(accessToken, net);
        fileId = found?.id || '';
      }

      if (!fileId) {
        const created = await this.createDriveFile(accessToken, net, localJson);
        await this.setConfig({
          cloudSyncFileId: created.id,
          cloudSyncLastSyncTime: new Date().toISOString(),
          cloudSyncLastHash: localHash,
          cloudSyncLastError: '',
        });
        return { ok: true, message: 'Cloud sync initialized.' };
      }

      const remoteJson = await this.downloadDriveFile(accessToken, net, fileId);
      if (!remoteJson) {
        await this.uploadDriveFile(accessToken, net, fileId, localJson);
        await this.setConfig({
          cloudSyncLastSyncTime: new Date().toISOString(),
          cloudSyncLastHash: localHash,
          cloudSyncLastError: '',
        });
        return { ok: true, message: 'Cloud sync updated.' };
      }

      const remoteHash = hashString(remoteJson, crypto);
      if (remoteHash === localHash) {
        await this.setConfig({
          cloudSyncLastSyncTime: new Date().toISOString(),
          cloudSyncLastHash: localHash,
          cloudSyncLastError: '',
        });
        return { ok: true, message: 'Cloud sync up to date.' };
      }

      const remoteParsed = parseExport(remoteJson);
      const lastSyncHash = config.cloudSyncLastHash || '';
      const localChanged = lastSyncHash && localHash !== lastSyncHash;
      const remoteChanged = lastSyncHash && remoteHash !== lastSyncHash;

      if (localChanged && remoteChanged) {
        const merged = mergeExports(localParsed, remoteParsed);
        const mergedJson = JSON.stringify(merged, null, 2);
        await this.db.importData(mergedJson);
        await this.uploadDriveFile(accessToken, net, fileId, mergedJson);
        await this.setConfig({
          cloudSyncLastSyncTime: new Date().toISOString(),
          cloudSyncLastHash: hashString(mergedJson, crypto),
          cloudSyncLastError: '',
        });
        return { ok: true, message: 'Cloud sync merged changes.' };
      }

      if (remoteParsed.exportDate > localParsed.exportDate) {
        await this.db.importData(remoteJson);
        await this.setConfig({
          cloudSyncLastSyncTime: new Date().toISOString(),
          cloudSyncLastHash: remoteHash,
          cloudSyncLastError: '',
        });
        return { ok: true, message: 'Cloud sync pulled updates.' };
      }

      await this.uploadDriveFile(accessToken, net, fileId, localJson);
      await this.setConfig({
        cloudSyncLastSyncTime: new Date().toISOString(),
        cloudSyncLastHash: localHash,
        cloudSyncLastError: '',
      });
      return { ok: true, message: 'Cloud sync pushed updates.' };
    } catch (error) {
      await this.setConfig({
        cloudSyncLastError: (error as Error)?.message || 'Unknown sync error',
      });
      return { ok: false, message: 'Cloud sync failed.' };
    } finally {
      this.isSyncing = false;
    }
  }

  private async findDriveFile(accessToken: string, net: any) {
    const query = encodeURIComponent(
      `name='${DRIVE_FILE_NAME}' and trashed=false`,
    );
    const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,name,modifiedTime)&q=${query}`;
    const response = await net.fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    const json = await response.json();
    return json?.files?.[0] || null;
  }

  private async downloadDriveFile(
    accessToken: string,
    net: any,
    fileId: string,
  ): Promise<string | null> {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    const response = await net.fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    return await response.text();
  }

  private async createDriveFile(
    accessToken: string,
    net: any,
    content: string,
  ) {
    const metadata = { name: DRIVE_FILE_NAME, parents: ['appDataFolder'] };
    const body = buildMultipartBody(metadata, content);
    const response = await net.fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': `multipart/related; boundary=${body.boundary}`,
        },
        body: body.payload,
      },
    );
    if (!response.ok) throw new Error('Failed to create Drive file.');
    return await response.json();
  }

  private async uploadDriveFile(
    accessToken: string,
    net: any,
    fileId: string,
    content: string,
  ) {
    const metadata = { name: DRIVE_FILE_NAME };
    const body = buildMultipartBody(metadata, content);
    const response = await net.fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`,
      {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': `multipart/related; boundary=${body.boundary}`,
        },
        body: body.payload,
      },
    );
    if (!response.ok) throw new Error('Failed to upload Drive file.');
  }
}

function parseExport(jsonData: string): { exportDate: number; data: any } {
  try {
    const parsed = JSON.parse(jsonData) as {
      exportDate?: number;
    } & Record<string, unknown>;
    return { exportDate: parsed.exportDate || 0, data: parsed };
  } catch {
    return {
      exportDate: 0,
      data: {
        playRecords: [],
        dailyAggregates: {},
        monthlyAggregates: {},
        streak: null,
      },
    };
  }
}

function mergeExports(local: { data: any }, remote: { data: any }) {
  const playRecords = [
    ...(local.data.playRecords || []),
    ...(remote.data.playRecords || []),
  ];
  const recordMap = new Map<string, any>();
  for (const record of playRecords) {
    const key = `${record.songId}|${record.artistId}|${record.timestamp}|${record.durationListened}|${record.totalDuration}`;
    if (!recordMap.has(key)) recordMap.set(key, record);
  }

  const mergeAggregate = (
    left: Record<string, any>,
    right: Record<string, any>,
  ) => {
    const result: Record<string, any> = { ...left };
    for (const [key, value] of Object.entries(right || {})) {
      if (!result[key]) {
        result[key] = value;
        continue;
      }
      if (value.totalMinutes && result[key].totalMinutes) {
        result[key] =
          value.totalMinutes > result[key].totalMinutes ? value : result[key];
      }
    }
    return result;
  };

  const streak = (() => {
    const a = local.data.streak;
    const b = remote.data.streak;
    if (!a) return b || null;
    if (!b) return a;
    return new Date(a.lastListenDate) > new Date(b.lastListenDate) ? a : b;
  })();

  return {
    version: 1,
    exportDate: Date.now(),
    playRecords: Array.from(recordMap.values()),
    dailyAggregates: mergeAggregate(
      local.data.dailyAggregates || {},
      remote.data.dailyAggregates || {},
    ),
    monthlyAggregates: mergeAggregate(
      local.data.monthlyAggregates || {},
      remote.data.monthlyAggregates || {},
    ),
    streak,
  };
}

function hashString(value: string, crypto: any) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function base64UrlEncode(buffer: Buffer) {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function buildMultipartBody(metadata: Record<string, any>, content: string) {
  const boundary = `ytm-${Date.now().toString(16)}`;
  const payload =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    'Content-Type: application/json\r\n\r\n' +
    `${content}\r\n` +
    `--${boundary}--`;
  return { boundary, payload };
}

async function safeReadResponse(response: { text: () => Promise<string> }) {
  try {
    const text = await response.text();
    return text?.slice(0, 300);
  } catch {
    return '';
  }
}

function extractArtistImage(html: string): string | null {
  const ogMatch = html.match(
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
  );
  if (ogMatch?.[1]) return ogMatch[1];

  const twitterMatch = html.match(
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/i,
  );
  if (twitterMatch?.[1]) return twitterMatch[1];

  const fallbackMatch = html.match(/https:\/\/yt3\.ggpht\.com\/[^"'\s>]+/i);
  if (fallbackMatch?.[0]) return fallbackMatch[0];

  return null;
}
