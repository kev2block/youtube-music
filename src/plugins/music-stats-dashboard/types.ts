export interface StatsConfig {
  enabled: boolean;
  trackingStartDate: string;
  cloudSyncEnabled: boolean;
  cloudSyncClientId?: string;
  cloudSyncClientSecret?: string;
  cloudSyncRefreshToken?: string;
  cloudSyncAccessToken?: string;
  cloudSyncAccessTokenExpiry?: number;
  cloudSyncFileId?: string;
  cloudSyncLastSyncTime?: string;
  cloudSyncLastHash?: string;
  cloudSyncLastError?: string;
}

export interface PlayRecord {
  id?: number;
  songId: string;
  songTitle: string;
  artistId: string;
  artistName: string;
  artistImageUrl?: string;
  albumName?: string;
  thumbnailUrl?: string;
  timestamp: number;
  durationListened: number; // in seconds
  totalDuration: number; // in seconds
  skipped: boolean;
  completed: boolean;
}

export interface DailyAggregate {
  date: string; // YYYY-MM-DD
  totalMinutes: number;
  songsPlayed: number;
  uniqueSongs: number;
  uniqueArtists: number;
  topSongs: Array<{ id: string; title: string; plays: number }>;
  topArtists: Array<{ id: string; name: string; plays: number }>;
  genreBreakdown: Record<string, number>; // genre -> minutes
  hourlyBreakdown: number[]; // 24 hours
  skipCount: number;
}

export interface MonthlyAggregate {
  yearMonth: string; // YYYY-MM
  totalMinutes: number;
  topSongs: Array<{ id: string; title: string; artist: string; plays: number }>;
  topArtists: Array<{ id: string; name: string; minutes: number }>;
  genreBreakdown: Record<string, number>;
  daysActive: number;
}

export interface StatsData {
  totalMinutes: number;
  totalSongs: number;
  topSongs: Array<{
    id: string;
    title: string;
    artist: string;
    plays: number;
    minutes: number;
    imageUrl?: string;
  }>;
  topArtists: Array<{
    id: string;
    name: string;
    plays: number;
    minutes: number;
    imageUrl?: string;
  }>;
  anthem?: { id: string; title: string; artist: string; plays: number };
  peakListeningDay?: { date: string; minutes: number };
  listeningClock: number[]; // 24 hours
  currentStreak: number;
  firstSongEver?: { title: string; artist: string; date: string };
  firstSongThisYear?: { title: string; artist: string; date: string };
  firstSongThisMonth?: { title: string; artist: string; date: string };
  monthlyObsessions: Array<{ yearMonth: string; artist: string; minutes: number }>;
  skipStats: Array<{ songId: string; title: string; artist: string; skips: number; plays: number; imageUrl?: string }>;
  skipRate: number;
}

export interface CurrentPlayback {
  songId: string;
  songTitle: string;
  artistId: string;
  artistName: string;
  artistImageUrl?: string;
  albumName?: string;
  thumbnailUrl?: string;
  totalDuration: number;
  startTime: number;
  lastUpdateTime: number;
  accumulatedTime: number;
}
