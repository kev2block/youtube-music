import type { RendererContext } from '@/types/contexts';

import type { CurrentPlayback, PlayRecord, StatsData } from './types';

let currentPlayback: CurrentPlayback | null = null;
let updateInterval: ReturnType<typeof setInterval> | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let songObserver: MutationObserver | null = null;
let ipc: RendererContext<{ enabled: boolean }>['ipc'] | null = null;
let userSkipRequested = false;
let lastAutoPlayId: string | null = null;
let skipClickHandler: ((event: Event) => void) | null = null;
const artistImageCache = new Map<string, string>();
const artistImagePending = new Map<string, Promise<string | null>>();

const isVideoId = (id?: string | null) =>
  !!id && /^[a-zA-Z0-9_-]{11}$/.test(id);

const OVERLAY_LOCK_CLASS = 'music-stats-overlay-open';

function lockScroll() {
  document.documentElement.classList.add(OVERLAY_LOCK_CLASS);
  document.body.classList.add(OVERLAY_LOCK_CLASS);
}

function unlockScroll() {
  document.documentElement.classList.remove(OVERLAY_LOCK_CLASS);
  document.body.classList.remove(OVERLAY_LOCK_CLASS);
}

export function start(context: RendererContext<{ enabled: boolean }>) {
  ipc = context.ipc;
  console.log('[Music Stats Dashboard] Renderer initialized');

  // Start tracking
  startTracking();

  // Track user-initiated skips
  setupSkipTracking();

  // Setup IPC listeners
  setupIpcListeners();
}

export function stop() {
  teardownTracking();
  teardownSkipTracking();
  teardownIpcListeners();

  const existing = document.getElementById('music-stats-overlay');
  if (existing) {
    existing.remove();
    unlockScroll();
  }
  ipc = null;
  console.log('[Music Stats Dashboard] Renderer stopped');
}

export default start;

function startTracking() {
  teardownTracking();
  // Listen for song changes
  songObserver = new MutationObserver(() => {
    checkForSongChange();
  });

  // Watch for title changes (song info appears here)
  const titleElement = document.querySelector('title');
  if (titleElement) {
    songObserver.observe(titleElement, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  // Also poll every 2 seconds as backup
  pollInterval = setInterval(() => {
    checkForSongChange();
  }, 2000);

  // Track song progress every second
  updateInterval = setInterval(() => {
    updatePlaybackProgress();
  }, 1000);
}

function teardownTracking() {
  if (songObserver) {
    songObserver.disconnect();
    songObserver = null;
  }
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
  }
  currentPlayback = null;
  userSkipRequested = false;
}

function checkForSongChange() {
  const songInfo = getSongInfo();
  if (!songInfo) return;

  // Check if song changed
  if (
    currentPlayback &&
    (currentPlayback.songId !== songInfo.songId ||
      currentPlayback.songTitle !== songInfo.songTitle)
  ) {
    // Song changed - save the previous song's play record
    savePreviousPlay();
  }

  // Start tracking new song
  if (!currentPlayback || currentPlayback.songId !== songInfo.songId) {
    userSkipRequested = false;
    currentPlayback = {
      songId: songInfo.songId,
      songTitle: songInfo.songTitle,
      artistId: songInfo.artistId,
      artistName: songInfo.artistName,
      artistImageUrl:
        getCachedArtistImage(
          songInfo.artistId,
          songInfo.artistUrl,
          songInfo.artistName,
        ) || undefined,
      albumName: songInfo.albumName,
      thumbnailUrl: songInfo.thumbnailUrl,
      totalDuration: songInfo.totalDuration,
      startTime: Date.now(),
      lastUpdateTime: Date.now(),
      accumulatedTime: 0,
    };

    primeArtistImage(songInfo).catch(console.error);
  }
}

function updatePlaybackProgress() {
  if (!currentPlayback) return;

  const now = Date.now();
  const timeSinceLastUpdate = (now - currentPlayback.lastUpdateTime) / 1000;

  // Only count time if song is actually playing (check if player is paused)
  if (isPlaying()) {
    currentPlayback.accumulatedTime += timeSinceLastUpdate;
  }

  currentPlayback.lastUpdateTime = now;

  // If song duration is reached, mark as completed and save
  if (currentPlayback.accumulatedTime >= currentPlayback.totalDuration * 0.95) {
    savePreviousPlay(true);
  }
}

function savePreviousPlay(completed = false) {
  if (!currentPlayback || currentPlayback.accumulatedTime < 30) {
    // Don't save plays shorter than 30 seconds
    currentPlayback = null;
    userSkipRequested = false;
    return;
  }

  const skipThreshold = 0.65;
  const wasSkipped =
    userSkipRequested &&
    !completed &&
    currentPlayback.totalDuration > 0 &&
    currentPlayback.accumulatedTime <
      currentPlayback.totalDuration * skipThreshold;

  const record: PlayRecord = {
    songId: currentPlayback.songId,
    songTitle: currentPlayback.songTitle,
    artistId: currentPlayback.artistId,
    artistName: currentPlayback.artistName,
    artistImageUrl: currentPlayback.artistImageUrl,
    albumName: currentPlayback.albumName,
    thumbnailUrl: currentPlayback.thumbnailUrl,
    timestamp: currentPlayback.startTime,
    durationListened: Math.floor(currentPlayback.accumulatedTime),
    totalDuration: currentPlayback.totalDuration,
    skipped: wasSkipped,
    completed,
  };

  ipc?.invoke('music-stats:add-play-record', record).catch(console.error);

  currentPlayback = null;
  userSkipRequested = false;
}

function getSongInfo(): {
  songId: string;
  songTitle: string;
  artistId: string;
  artistName: string;
  artistUrl?: string;
  albumName?: string;
  thumbnailUrl?: string;
  totalDuration: number;
} | null {
  try {
    // Get song title
    const titleElement = document.querySelector(
      'ytmusic-player-bar .title',
    ) as HTMLElement;
    const songTitle = titleElement?.textContent?.trim();
    if (!songTitle) return null;

    // Get artist
    const artistElement = document.querySelector(
      'ytmusic-player-bar .byline a',
    ) as HTMLElement;
    const artistName = artistElement?.textContent?.trim() || 'Unknown Artist';

    // Get video ID (use as song ID)
    const videoElement = document.querySelector('video');
    const videoSrc = videoElement?.src;
    const videoIdMatch = videoSrc?.match(/[?&]v=([^&]+)/);
    const playerBar = document.querySelector('ytmusic-player-bar');
    const attrId =
      playerBar?.getAttribute('video-id') ||
      playerBar?.getAttribute('videoId') ||
      playerBar?.getAttribute('data-video-id');
    const songId = videoIdMatch?.[1] || attrId || songTitle; // Fallback to title if no ID

    // Get artist ID from link
    const artistLink = artistElement?.getAttribute('href');
    const artistIdMatch = artistLink?.match(/channel\/([^/?]+)/);
    const browseMatch = artistLink?.match(/browse\/([^/?]+)/);
    const rawArtistId = artistIdMatch?.[1] || browseMatch?.[1];
    const artistId =
      rawArtistId && rawArtistId.startsWith('UC') ? rawArtistId : artistName;
    const artistUrl = artistLink
      ? artistLink.startsWith('http')
        ? artistLink
        : `https://music.youtube.com${artistLink}`
      : undefined;

    // Get album
    const albumElement = document.querySelector(
      'ytmusic-player-bar .subtitle a[href*="/browse/"]',
    ) as HTMLElement;
    const albumName = albumElement?.textContent?.trim();

    // Get thumbnail
    const thumbElement = document.querySelector<HTMLImageElement>(
      'ytmusic-player-bar img#img, ytmusic-player-bar img, ytmusic-player-bar .thumbnail img',
    );
    const thumbnailUrl =
      thumbElement?.src ||
      (songId && /^[a-zA-Z0-9_-]{11}$/.test(songId)
        ? `https://i.ytimg.com/vi/${songId}/hqdefault.jpg`
        : undefined);

    // Get duration
    const duration = videoElement?.duration || 0;

    return {
      songId,
      songTitle,
      artistId,
      artistName,
      artistUrl,
      albumName,
      thumbnailUrl,
      totalDuration: Math.floor(duration),
    };
  } catch (error) {
    console.error('[Music Stats] Error getting song info:', error);
    return null;
  }
}

function isPlaying(): boolean {
  try {
    const videoElement = document.querySelector('video');
    return videoElement ? !videoElement.paused : false;
  } catch {
    return false;
  }
}

function setupIpcListeners() {
  ipc?.on('music-stats:show-wrapped', () => {
    showWrapped();
  });

  ipc?.on('music-stats:show-dashboard', () => {
    showDashboard();
  });

  ipc?.on('music-stats:export', async () => {
    try {
      const data = await ipc?.invoke('music-stats:export-data');
      const saved = await ipc?.invoke('music-stats:save-export-file', data);
      if (saved) {
        showNotification('Stats exported successfully!');
      }
    } catch (error) {
      console.error('[Music Stats] Export failed:', error);
      showNotification('Failed to export stats');
    }
  });

  ipc?.on('music-stats:import', async () => {
    try {
      const data = await ipc?.invoke('music-stats:load-import-file');
      if (data) {
        await ipc?.invoke('music-stats:import-data', data);
        showNotification('Stats imported successfully!');
      }
    } catch (error) {
      console.error('[Music Stats] Import failed:', error);
      showNotification('Failed to import stats');
    }
  });

  ipc?.on('music-stats:drive-connect', async () => {
    try {
      const result = await ipc?.invoke('music-stats:drive-connect');
      if (result?.message) showNotification(result.message);
    } catch (error) {
      console.error('[Music Stats] Drive connect failed:', error);
      showNotification('Google Drive connection failed');
    }
  });

  ipc?.on('music-stats:drive-sync', async () => {
    try {
      const result = await ipc?.invoke('music-stats:drive-sync');
      if (result?.message) showNotification(result.message);
    } catch (error) {
      console.error('[Music Stats] Drive sync failed:', error);
      showNotification('Google Drive sync failed');
    }
  });

  ipc?.on('music-stats:drive-disconnect', async () => {
    try {
      const result = await ipc?.invoke('music-stats:drive-disconnect');
      if (result?.message) showNotification(result.message);
    } catch (error) {
      console.error('[Music Stats] Drive disconnect failed:', error);
      showNotification('Google Drive disconnect failed');
    }
  });
}

function teardownIpcListeners() {
  ipc?.removeAllListeners('music-stats:show-wrapped');
  ipc?.removeAllListeners('music-stats:show-dashboard');
  ipc?.removeAllListeners('music-stats:export');
  ipc?.removeAllListeners('music-stats:import');
  ipc?.removeAllListeners('music-stats:drive-connect');
  ipc?.removeAllListeners('music-stats:drive-sync');
  ipc?.removeAllListeners('music-stats:drive-disconnect');
}

async function showWrapped() {
  const stats = await ipc?.invoke('music-stats:get-stats');
  createWrappedView(stats);
}

async function showDashboard() {
  const stats = await ipc?.invoke('music-stats:get-stats');
  createDashboardView(stats);
}

function createWrappedView(stats: StatsData) {
  // Remove existing overlay
  const existing = document.getElementById('music-stats-overlay');
  if (existing) {
    existing.remove();
    unlockScroll();
  }

  // Create overlay
  const overlay = document.createElement('div');
  overlay.id = 'music-stats-overlay';
  overlay.className = 'music-stats-overlay wrapped-view';

  let currentSlide = 0;
  const slides = createWrappedSlides(stats);

  function renderSlide(index: number) {
    overlay.innerHTML = '';

    const container = document.createElement('div');
    container.className = 'wrapped-container';
    container.innerHTML = slides[index];

    const navigation = document.createElement('div');
    navigation.className = 'wrapped-navigation';

    if (index > 0) {
      const prevBtn = document.createElement('button');
      prevBtn.className = 'wrapped-nav-btn';
      prevBtn.textContent = '← Previous';
      prevBtn.onclick = () => {
        currentSlide--;
        renderSlide(currentSlide);
      };
      navigation.appendChild(prevBtn);
    }

    const progress = document.createElement('div');
    progress.className = 'wrapped-progress';
    progress.textContent = `${index + 1} / ${slides.length}`;
    navigation.appendChild(progress);

    if (index < slides.length - 1) {
      const nextBtn = document.createElement('button');
      nextBtn.className = 'wrapped-nav-btn';
      nextBtn.textContent = 'Next →';
      nextBtn.onclick = () => {
        currentSlide++;
        renderSlide(currentSlide);
      };
      navigation.appendChild(nextBtn);
    } else {
      const closeBtn = document.createElement('button');
      closeBtn.className = 'wrapped-nav-btn primary';
      closeBtn.textContent = 'Close';
      closeBtn.onclick = () => {
        overlay.remove();
        unlockScroll();
      };
      navigation.appendChild(closeBtn);
    }

    const closeIcon = document.createElement('button');
    closeIcon.className = 'wrapped-close';
    closeIcon.innerHTML = '×';
    closeIcon.onclick = () => {
      overlay.remove();
      unlockScroll();
    };

    overlay.appendChild(closeIcon);
    overlay.appendChild(container);
    overlay.appendChild(navigation);

    const progressFill = container.querySelector<HTMLElement>(
      '.wrapped-progress-fill',
    );
    const progressTarget = progressFill?.dataset.progress;
    if (progressFill && progressTarget) {
      progressFill.style.setProperty('--progress', '0');
      requestAnimationFrame(() => {
        progressFill.style.setProperty('--progress', progressTarget);
      });
    }

    const playButtons =
      container.querySelectorAll<HTMLButtonElement>('[data-play-id]');
    playButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.playId;
        if (id) playSongById(id);
      });
    });

    const autoPlayTarget =
      container.querySelector<HTMLElement>('[data-auto-play]');
    const autoPlayId = autoPlayTarget?.getAttribute('data-auto-play');
    if (isVideoId(autoPlayId)) playSongById(autoPlayId, true);

    const obsessions = container.querySelector<HTMLElement>(
      '.wrapped-obsessions',
    );
    if (obsessions) {
      const totalMonths = Number(obsessions.dataset.totalMonths || 0);
      const flips = Array.from(
        container.querySelectorAll<HTMLElement>('.wrapped-flip'),
      );
      const prevBtn = container.querySelector<HTMLButtonElement>(
        '.obsessions-nav.prev',
      );
      const nextBtn = container.querySelector<HTMLButtonElement>(
        '.obsessions-nav.next',
      );
      const indicator = container.querySelector<HTMLElement>(
        '.obsessions-indicator',
      );

      const setActiveMonth = (index: number) => {
        const clamped = Math.max(0, Math.min(totalMonths - 1, index));
        obsessions.dataset.currentIndex = clamped.toString();
        flips.forEach((flip, idx) => {
          flip.classList.toggle('active', idx === clamped);
        });
        if (prevBtn) prevBtn.disabled = clamped <= 0;
        if (nextBtn) nextBtn.disabled = clamped >= totalMonths - 1;
        if (indicator) {
          const activeFlip = flips[clamped];
          const label =
            activeFlip?.querySelector('.flip-front')?.textContent?.trim() || '';
          indicator.textContent = label;
        }
      };

      setActiveMonth(0);

      prevBtn?.addEventListener('click', () => {
        const current = Number(obsessions.dataset.currentIndex || 0);
        setActiveMonth(current - 1);
      });
      nextBtn?.addEventListener('click', () => {
        const current = Number(obsessions.dataset.currentIndex || 0);
        setActiveMonth(current + 1);
      });
    }

    // Trigger animation
    requestAnimationFrame(() => {
      container.classList.add('slide-in');
    });
  }

  renderSlide(currentSlide);
  lockScroll();
  document.body.appendChild(overlay);
}

function createWrappedSlides(stats: StatsData): string[] {
  const slides: string[] = [];
  const year = new Date().getFullYear();
  const totalDays = (stats.totalMinutes / 60 / 24).toFixed(1);
  const progressRatio = 1;
  const topSong = stats.topSongs[0];
  const topSongsNo1 = stats.topSongs.slice(1, 5);
  const topArtists = stats.topArtists.slice(0, 5);
  const autoPlayId = stats.topSongs.find((song) => isVideoId(song.id))?.id;

  const artistImageFallback = new Map<string, string>();
  stats.topSongs.forEach((song) => {
    if (song.imageUrl) artistImageFallback.set(song.artist, song.imageUrl);
  });

  const listeningClock = stats.listeningClock || new Array(24).fill(0);
  const peakHour = listeningClock.indexOf(Math.max(...listeningClock));
  const chronotype =
    peakHour >= 22 || peakHour <= 4
      ? 'Night Owl'
      : peakHour <= 10
        ? 'Early Bird'
        : 'Day Groover';

  const totalPlays = Math.max(1, stats.totalSongs);
  const uniqueSongs = new Set(stats.topSongs.map((s) => s.id)).size;
  const varietyScore = Math.round((uniqueSongs / totalPlays) * 100);
  const topFivePlays = stats.topArtists
    .slice(0, 5)
    .reduce((sum, a) => sum + a.plays, 0);
  const obsessionScore = Math.round((topFivePlays / totalPlays) * 100);
  const topArtistName = stats.topArtists[0]?.name ?? 'your favorites';
  const archetype =
    varietyScore >= 70
      ? 'Trailblazer'
      : varietyScore >= 55
        ? 'Wanderer'
        : obsessionScore >= 55
          ? 'Superfan'
          : obsessionScore >= 35
            ? 'Loyalist'
            : 'Balancer';
  const auraClass =
    varietyScore >= 70
      ? 'aura-explorer'
      : varietyScore >= 55
        ? 'aura-explorer'
        : obsessionScore >= 55
          ? 'aura-superfan'
          : obsessionScore >= 35
            ? 'aura-superfan'
            : 'aura-drifter';

  const currentMonthIndex = new Date().getMonth() + 1;
  const monthly = stats.monthlyObsessions
    .filter((m) => m.yearMonth.startsWith(`${year}-`))
    .filter((m) => {
      const mm = Number(m.yearMonth.split('-')[1]);
      return mm <= currentMonthIndex;
    })
    .slice(0, 12);
  const firstSongYear = stats.firstSongThisYear;

  const peakDay = stats.peakListeningDay?.date || `${year}-01-01`;
  const [peakYear, peakMonth, peakDayNum] = peakDay.split('-').map(Number);
  const daysInMonth = new Date(peakYear, peakMonth, 0).getDate();

  // 1. Intro
  slides.push(`
    <div class="wrapped-slide wrapped-intro" data-auto-play="${autoPlayId || ''}">
      <h1 class="wrapped-title">${year} sounded like this...</h1>
      <p class="wrapped-subtitle">Your year in music, beautifully unraveled.</p>
    </div>
  `);

  // 2. Timekeeper
  slides.push(`
    <div class="wrapped-slide">
      <h2 class="wrapped-heading">The Timekeeper</h2>
      <div class="wrapped-stat-large">${formatNumber(stats.totalMinutes)}</div>
      <div class="wrapped-label">Minutes</div>
      <p class="wrapped-text">That's roughly <strong>${totalDays}</strong> days of non-stop music.</p>
      <div class="wrapped-progress">
        <div class="wrapped-progress-fill" data-progress="${progressRatio}" style="--progress:0"></div>
      </div>
    </div>
  `);

  // 3. Chronotype
  slides.push(`
    <div class="wrapped-slide">
      <h2 class="wrapped-heading">The Chronotype</h2>
      <p class="wrapped-text">You're a <strong>${chronotype}</strong>. Peak time: <strong>${peakHour}:00</strong></p>
      <div class="wrapped-chronotype">${createChronotypeTimeline(listeningClock)}</div>
    </div>
  `);

  // 4. Listening Aura (Wrapped only)
  slides.push(`
    <div class="wrapped-slide">
      <h2 class="wrapped-heading">The Listening Aura</h2>
      <div class="wrapped-aura ${auraClass}">
        <div class="aura-orb"></div>
      </div>
      <div class="wrapped-aura-text">
        <div class="aura-title">You are a ${archetype}.</div>
        <div class="aura-detail">
          ${
            archetype === 'Trailblazer' || archetype === 'Wanderer'
              ? `You jumped across ${uniqueSongs} unique songs. Always hunting something new.`
              : `You replay your favorites a lot. ${obsessionScore}% of your plays came from your top artists led by ${escapeHtml(topArtistName)}.`
          }
        </div>
      </div>
    </div>
  `);

  // 5. Obsessions
  slides.push(`
    <div class="wrapped-slide">
      <h2 class="wrapped-heading">The Obsessions</h2>
      <p class="wrapped-text">Each card shows the artist you played most that month.</p>
      <div class="wrapped-obsessions" data-total-months="${monthly.length}" data-current-index="0">
        <button class="obsessions-nav prev" aria-label="Previous month">←</button>
        <div class="wrapped-flips">
          ${monthly
            .map((m, idx) => {
              const [yy, mm] = m.yearMonth.split('-').map(Number);
              const label = new Date(yy, mm - 1, 1).toLocaleDateString(
                'en-US',
                { month: 'long', year: 'numeric' },
              );
              return `
            <div class="wrapped-flip" data-month-index="${idx}" data-year-month="${m.yearMonth}">
              <div class="flip-front">${label}</div>
              <div class="flip-back">${escapeHtml(m.artist)}</div>
              <div class="flip-sub">${m.minutes} minutes that month</div>
            </div>
          `;
            })
            .join('')}
        </div>
        <button class="obsessions-nav next" aria-label="Next month">→</button>
      </div>
      <div class="obsessions-indicator"></div>
      <div class="wrapped-calendar-title">Peak listening day</div>
      <div class="wrapped-calendar-sub">${formatDate(peakDay)} • ${stats.peakListeningDay?.minutes || 0} min</div>
      <div class="wrapped-calendar">
        ${Array.from({ length: daysInMonth }, (_, i) => {
          const day = i + 1;
          const isPeak = day === peakDayNum;
          return `<div class="calendar-day ${isPeak ? 'peak' : ''}">${day}</div>`;
        }).join('')}
      </div>
    </div>
  `);

  // 6. Honest stats
  slides.push(`
    <div class="wrapped-slide">
      <h2 class="wrapped-heading">The Honest Stats</h2>
      <div class="wrapped-honest">
        <div class="honest-card">
          <div class="honest-label">First song of ${year}</div>
          <div class="honest-value">${firstSongYear ? escapeHtml(firstSongYear.title) : ''}</div>
          <div class="honest-sub">${firstSongYear ? escapeHtml(firstSongYear.artist) : ''}</div>
        </div>
        <div class="honest-card skip">
          <div class="honest-label">Overall skip rate</div>
          <div class="honest-value">${stats.skipRate}%</div>
          <div class="honest-sub">Across all listens</div>
          <div class="skip-icon">⏭</div>
        </div>
      </div>
    </div>
  `);

  // 7. Hall of Fame
  slides.push(`
    <div class="wrapped-slide">
      <h2 class="wrapped-heading">Hall of Fame</h2>
      <div class="wrapped-artist-grid">
        ${topArtists
          .map(
            (artist, idx) => `
            <div class="artist-card">
              <div class="artist-rank">#${idx + 1}</div>
              <div class="artist-avatar">
                ${
                  artist.imageUrl || artistImageFallback.get(artist.name)
                    ? `<img src="${artist.imageUrl || artistImageFallback.get(artist.name)}" alt="${escapeHtml(artist.name)}" />`
                    : `<span>${escapeHtml(artist.name.charAt(0))}</span>`
                }
              </div>
              <div class="artist-name">${escapeHtml(artist.name)}</div>
              <div class="artist-minutes">${artist.minutes} min</div>
            </div>
          `,
          )
          .join('')}
      </div>
    </div>
  `);

  // 8. Soundtrack (Top songs, hide #1)
  slides.push(`
    <div class="wrapped-slide">
      <h2 class="wrapped-heading">The Soundtrack</h2>
      <div class="wrapped-songlist">
        ${topSongsNo1
          .map(
            (song, idx) => `
            <div class="song-row">
              <div class="song-rank">#${idx + 2}</div>
              <div class="song-art">
                ${
                  song.imageUrl ||
                  (isVideoId(song.id)
                    ? `https://i.ytimg.com/vi/${song.id}/hqdefault.jpg`
                    : '')
                    ? `<img src="${song.imageUrl || `https://i.ytimg.com/vi/${song.id}/hqdefault.jpg`}" alt="${escapeHtml(song.title)}" />`
                    : `<span>${escapeHtml(song.title.charAt(0))}</span>`
                }
              </div>
              <div class="song-meta">
                <div class="song-title">${escapeHtml(song.title)}</div>
                <div class="song-artist">${escapeHtml(song.artist)}</div>
              </div>
              <div class="song-bars">
                <span></span><span></span><span></span><span></span>
              </div>
              ${isVideoId(song.id) ? `<button class="song-play" data-play-id="${song.id}">Play</button>` : ''}
            </div>
          `,
          )
          .join('')}
      </div>
    </div>
  `);

  // 9. Anthem
  slides.push(`
    <div class="wrapped-slide wrapped-anthem-final" data-auto-play="${topSong?.id || ''}">
      <div class="anthem-art">
        ${
          topSong
            ? `<img src="${topSong.imageUrl || (isVideoId(topSong.id) ? `https://i.ytimg.com/vi/${topSong.id}/maxresdefault.jpg` : '')}" onerror="if (!this.dataset.fallback) { this.dataset.fallback = '1'; this.src = 'https://i.ytimg.com/vi/${topSong.id}/hqdefault.jpg'; }" alt="${escapeHtml(topSong.title)}" />`
            : '<div class="anthem-placeholder"></div>'
        }
      </div>
      <div class="anthem-content">
        <div class="anthem-label">Your #1 Song</div>
        <div class="anthem-title">${topSong ? escapeHtml(topSong.title) : ''}</div>
        <div class="anthem-artist">${topSong ? escapeHtml(topSong.artist) : ''}</div>
        <div class="anthem-plays">You played this ${topSong ? topSong.plays : 0} times</div>
        <div class="anthem-minutes">${topSong ? topSong.minutes : 0} minutes total</div>
      </div>
    </div>
  `);

  return slides;
}

function createDashboardView(stats: StatsData) {
  // Remove existing overlay
  const existing = document.getElementById('music-stats-overlay');
  if (existing) {
    existing.remove();
    unlockScroll();
  }

  // Create overlay
  const overlay = document.createElement('div');
  overlay.id = 'music-stats-overlay';
  overlay.className = 'music-stats-overlay dashboard-view';

  overlay.innerHTML = `
    <div class="dashboard-container">
      <div class="dashboard-header">
        <h1 class="dashboard-title">Music Stats Dashboard</h1>
        <button class="dashboard-close">×</button>
      </div>

      <div class="dashboard-summary">
        <div class="dashboard-card">
          <div class="card-label">Total Minutes</div>
          <div class="card-value">${formatNumber(stats.totalMinutes)}</div>
        </div>

        <div class="dashboard-card">
          <div class="card-label">Songs Played</div>
          <div class="card-value">${formatNumber(stats.totalSongs)}</div>
        </div>

        <div class="dashboard-card">
          <div class="card-label">Current Streak</div>
          <div class="card-value">${stats.currentStreak} days</div>
        </div>

        ${
          stats.peakListeningDay
            ? `
        <div class="dashboard-card">
          <div class="card-label">Peak Day</div>
          <div class="card-value">${stats.peakListeningDay.minutes} min</div>
          <div class="card-sublabel">${formatDate(stats.peakListeningDay.date)}</div>
        </div>
        `
            : ''
        }
      </div>

      <div class="dashboard-grid">
        <div class="dashboard-card wide">
          <h3 class="card-title">Top 5 Songs</h3>
          <div class="dashboard-list">
            ${stats.topSongs
              .map(
                (song) => `
              <div class="list-item">
                <div class="list-left">
                  <div class="list-thumb">
                    ${
                      song.imageUrl
                        ? `<img src="${song.imageUrl}" alt="${escapeHtml(song.title)}" />`
                        : `<span>${escapeHtml(song.title.charAt(0))}</span>`
                    }
                  </div>
                  <div class="list-content">
                    <div class="list-title">${escapeHtml(song.title)}</div>
                    <div class="list-subtitle">${escapeHtml(song.artist)}</div>
                  </div>
                </div>
                <div class="list-stat">${song.plays} plays</div>
              </div>
            `,
              )
              .join('')}
          </div>
        </div>

        <div class="dashboard-card wide">
          <h3 class="card-title">Top 5 Artists</h3>
          <div class="dashboard-list">
            ${stats.topArtists
              .map(
                (artist) => `
              <div class="list-item">
                <div class="list-left">
                  <div class="list-thumb">
                    ${
                      artist.imageUrl
                        ? `<img src="${artist.imageUrl}" alt="${escapeHtml(artist.name)}" />`
                        : `<span>${escapeHtml(artist.name.charAt(0))}</span>`
                    }
                  </div>
                  <div class="list-content">
                    <div class="list-title">${escapeHtml(artist.name)}</div>
                  </div>
                </div>
                <div class="list-stat">${artist.minutes} min</div>
              </div>
            `,
              )
              .join('')}
          </div>
        </div>

        <div class="dashboard-card full-width">
          <h3 class="card-title">Listening Activity (by hour)</h3>
          <div class="listening-clock">
            ${createListeningClock(stats.listeningClock)}
          </div>
        </div>

        ${
          stats.skipStats.length > 0
            ? `
        <div class="dashboard-card full-width">
          <h3 class="card-title">Most Skipped Songs</h3>
          <div class="dashboard-list">
            ${stats.skipStats
              .slice(0, 5)
              .map(
                (song) => `
              <div class="list-item">
                <div class="list-left">
                  <div class="list-thumb">
                    ${
                      song.imageUrl
                        ? `<img src="${song.imageUrl}" alt="${escapeHtml(song.title)}" />`
                        : `<span>${escapeHtml(song.title.charAt(0))}</span>`
                    }
                  </div>
                  <div class="list-content">
                    <div class="list-title">${escapeHtml(song.title)}</div>
                    <div class="list-subtitle">${escapeHtml(song.artist)}</div>
                  </div>
                </div>
                <div class="list-stat">${song.skips} skips / ${song.plays} plays</div>
              </div>
            `,
              )
              .join('')}
          </div>
        </div>
        `
            : ''
        }
      </div>
    </div>
  `;

  const closeBtn = overlay.querySelector('.dashboard-close');
  closeBtn?.addEventListener('click', () => {
    overlay.remove();
    unlockScroll();
  });
  document.body.appendChild(overlay);

  lockScroll();

  const chart = overlay.querySelector<HTMLElement>('.listening-chart');
  const tooltip = overlay.querySelector<HTMLElement>('.listening-tooltip');
  const svg = overlay.querySelector<SVGSVGElement>('.listening-svg');
  if (chart && tooltip && svg) {
    const showTooltip = (target: SVGCircleElement) => {
      const hour = target.dataset.hour ?? '00';
      const minutes = target.dataset.minutes ?? '0';
      const xPct = Number(target.dataset.x || 0);
      const yPct = Number(target.dataset.y || 0);

      const rect = svg.getBoundingClientRect();
      const left = rect.left + rect.width * xPct;
      const top = rect.top + rect.height * yPct;

      tooltip.textContent = `${hour}:00 • ${minutes} min`;
      tooltip.style.left = `${left - rect.left}px`;
      tooltip.style.top = `${top - rect.top - 12}px`;
      tooltip.classList.add('show');
    };

    svg.addEventListener('mousemove', (event) => {
      const target = (
        event.target as Element | null
      )?.closest<SVGCircleElement>('.listening-dot');
      if (!target) return;
      showTooltip(target);
    });

    svg.addEventListener('mouseleave', () => {
      tooltip.classList.remove('show');
    });
  }
}

function createListeningClock(hourlyData: number[]): string {
  if (!hourlyData || hourlyData.length !== 24) {
    return '<div class="listening-empty">No activity yet</div>';
  }

  const maxMinutes = Math.max(...hourlyData, 1);
  const hasActivity = hourlyData.some((m) => m > 0);
  if (!hasActivity) {
    return '<div class="listening-empty">No activity yet</div>';
  }

  const width = 1200;
  const height = 320;
  const padding = 36;
  const plotWidth = width - padding * 2;
  const plotHeight = height - padding * 2;

  const points = hourlyData.map((minutes, hour) => {
    const x = padding + (hour / 23) * plotWidth;
    const y = padding + (1 - minutes / maxMinutes) * plotHeight;
    return { x, y, minutes, hour };
  });

  const linePath = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(' ');

  const areaPath = `${linePath} L ${points[points.length - 1].x.toFixed(2)} ${(
    height - padding
  ).toFixed(2)} L ${points[0].x.toFixed(2)} ${(height - padding).toFixed(2)} Z`;

  return `
    <div class="listening-chart">
      <svg class="listening-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Listening activity by hour">
        <defs>
          <linearGradient id="listening-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="rgba(255, 77, 77, 0.65)" />
            <stop offset="100%" stop-color="rgba(255, 77, 77, 0.05)" />
          </linearGradient>
          <linearGradient id="listening-line" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="#ff4d4d" />
            <stop offset="100%" stop-color="#ff8f4d" />
          </linearGradient>
        </defs>

        <rect x="${padding}" y="${padding}" width="${plotWidth}" height="${plotHeight}" rx="16" class="listening-bg" />

        <path d="${areaPath}" fill="url(#listening-fill)" class="listening-area" />
        <path d="${linePath}" fill="none" stroke="url(#listening-line)" stroke-width="3" class="listening-line" />

        ${points
          .map((p) => {
            if (p.minutes <= 0) return '';
            const xPct = (p.x / width).toFixed(4);
            const yPct = (p.y / height).toFixed(4);
            return `
              <circle class="listening-dot" cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="4" 
                data-hour="${p.hour.toString().padStart(2, '0')}" data-minutes="${Math.round(p.minutes)}"
                data-x="${xPct}" data-y="${yPct}" />
            `;
          })
          .join('')}

        ${[0, 4, 8, 12, 16, 20, 23]
          .map((hour) => {
            const x = padding + (hour / 23) * plotWidth;
            return `<text x="${x.toFixed(2)}" y="${height - 8}" class="listening-tick">${hour.toString().padStart(2, '0')}</text>`;
          })
          .join('')}
      </svg>
      <div class="listening-tooltip"></div>
      <div class="listening-legend">Click a peak to see the exact time.</div>
    </div>
  `;
}

function formatNumber(num: number): string {
  return num.toLocaleString();
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function showNotification(message: string) {
  const notification = document.createElement('div');
  notification.className = 'music-stats-notification';
  notification.textContent = message;
  document.body.appendChild(notification);

  setTimeout(() => {
    notification.classList.add('show');
  }, 10);

  setTimeout(() => {
    notification.classList.remove('show');
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

function setupSkipTracking() {
  const isSkipButton = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return false;
    return !!target.closest(
      '.next-button.ytmusic-player-bar, .previous-button.ytmusic-player-bar',
    );
  };

  skipClickHandler = (event: Event) => {
    if (isSkipButton(event.target)) {
      userSkipRequested = true;
    }
  };

  document.addEventListener('click', skipClickHandler, true);
}

function teardownSkipTracking() {
  if (skipClickHandler) {
    document.removeEventListener('click', skipClickHandler, true);
    skipClickHandler = null;
  }
}

function createChronotypeTimeline(hourlyData: number[]): string {
  const maxMinutes = Math.max(...hourlyData, 1);
  const bars = hourlyData
    .map((minutes, hour) => {
      const height = Math.max(6, (minutes / maxMinutes) * 80);
      const label = `${hour.toString().padStart(2, '0')}`;
      return `
        <div class="chronotype-bar" style="--h:${height}px" title="${label}:00 • ${Math.round(minutes)} min">
          <span class="chronotype-bar-inner"></span>
          <span class="chronotype-label">${label}</span>
        </div>
      `;
    })
    .join('');

  return `
    <div class="chronotype-timeline">
      ${bars}
    </div>
  `;
}

function playSongById(videoId: string, auto = false) {
  if (!videoId) return;
  if (auto && lastAutoPlayId === videoId) return;
  lastAutoPlayId = videoId;
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    showNotification('Cannot play: missing video ID');
    return;
  }
  if (!ipc) return;

  ipc.send('peard:add-to-queue', videoId, 'INSERT_AFTER_CURRENT_VIDEO');
  ipc.send('peard:next-video');
}

function getCachedArtistImage(
  artistId?: string,
  artistUrl?: string,
  artistName?: string,
) {
  const key =
    artistId && artistId.startsWith('UC') ? artistId : artistUrl || artistName;
  if (!key) return null;
  return artistImageCache.get(key) || null;
}

async function primeArtistImage(songInfo: {
  artistId: string;
  artistName: string;
  artistUrl?: string;
}) {
  const key = songInfo.artistId.startsWith('UC')
    ? songInfo.artistId
    : songInfo.artistUrl || songInfo.artistName;
  if (!key) return;
  const cached = artistImageCache.get(key);
  if (cached) {
    if (currentPlayback?.artistId === songInfo.artistId) {
      currentPlayback.artistImageUrl = cached;
    }
    return;
  }

  let pending = artistImagePending.get(key);
  if (!pending) {
    pending = fetchArtistImage(songInfo.artistUrl, songInfo.artistId);
    artistImagePending.set(key, pending);
  }

  const imageUrl = await pending;
  artistImagePending.delete(key);
  if (!imageUrl) return;

  artistImageCache.set(key, imageUrl);
  if (currentPlayback?.artistId === songInfo.artistId) {
    currentPlayback.artistImageUrl = imageUrl;
  }
}

async function fetchArtistImage(
  artistUrl?: string,
  artistId?: string,
): Promise<string | null> {
  if (!ipc) return null;
  try {
    return await ipc.invoke('music-stats:artist-image', {
      artistUrl,
      artistId,
    });
  } catch (error) {
    console.warn('[Music Stats] Failed to fetch artist image', error);
    return null;
  }
}
