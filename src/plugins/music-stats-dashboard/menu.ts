import prompt from 'custom-electron-prompt';

import promptOptions from '@/providers/prompt-options';
import { t } from '@/i18n';

import type { MenuContext } from '@/types/contexts';
import type { MenuTemplate } from '@/menu';
import type { StatsConfig } from './types';

export default async (ctx: MenuContext<StatsConfig>): Promise<MenuTemplate> => {
  const config = await ctx.getConfig();
  const lastSyncLabel = config.cloudSyncLastSyncTime
    ? `Last sync: ${new Date(config.cloudSyncLastSyncTime).toLocaleString()}`
    : 'Last sync: never';
  const lastErrorLabel = config.cloudSyncLastError
    ? `Last error: ${config.cloudSyncLastError}`
    : 'Last error: none';

  return [
    {
      label: t('plugins.music-stats-dashboard.menu.title', 'Music Stats Dashboard'),
      click: () => {
        ctx.window.webContents.send('music-stats:show-dashboard');
      },
      submenu: [
        {
          label: t('plugins.music-stats-dashboard.menu.dashboard', 'View Dashboard'),
          click: () => {
            ctx.window.webContents.send('music-stats:show-dashboard');
          },
        },
        {
          label: t('plugins.music-stats-dashboard.menu.wrapped', 'View Wrapped'),
          click: () => {
            ctx.window.webContents.send('music-stats:show-wrapped');
          },
        },
        {
          type: 'separator',
        },
        {
          label: 'Google Drive Sync',
          submenu: [
            {
              label: 'Enable Sync',
              type: 'checkbox',
              checked: !!config.cloudSyncEnabled,
              click: async () => {
                await ctx.setConfig({ cloudSyncEnabled: !config.cloudSyncEnabled });
                ctx.refresh?.();
              },
            },
            {
              label: 'Set Google Client ID (Desktop)…',
              click: async () => {
                const clientId = await prompt(
                  {
                    title: 'Google Drive Client ID (Desktop)',
                    label: 'Paste your OAuth Client ID (Desktop app):',
                    type: 'input',
                    value: config.cloudSyncClientId || '',
                    ...promptOptions(),
                  },
                  ctx.window,
                );

                if (clientId && clientId.trim()) {
                  await ctx.setConfig({ cloudSyncClientId: clientId.trim() });
                  ctx.refresh?.();
                }
              },
            },
            {
              label: 'Set Google Client Secret…',
              click: async () => {
                const clientSecret = await prompt(
                  {
                    title: 'Google Client Secret',
                    label: 'Paste your OAuth Client Secret:',
                    type: 'input',
                    value: config.cloudSyncClientSecret || '',
                    ...promptOptions(),
                  },
                  ctx.window,
                );

                if (clientSecret && clientSecret.trim()) {
                  await ctx.setConfig({ cloudSyncClientSecret: clientSecret.trim() });
                  ctx.refresh?.();
                }
              },
            },
            {
              label: 'Connect Google Drive…',
              click: () => {
                ctx.window.webContents.send('music-stats:drive-connect');
              },
            },
            {
              label: 'Sync Now',
              enabled: !!config.cloudSyncEnabled,
              click: () => {
                ctx.window.webContents.send('music-stats:drive-sync');
              },
            },
            {
              label: lastSyncLabel,
              enabled: false,
            },
            {
              label: lastErrorLabel,
              enabled: false,
            },
            {
              label: 'Disconnect Google Drive',
              enabled: !!config.cloudSyncEnabled,
              click: () => {
                ctx.window.webContents.send('music-stats:drive-disconnect');
              },
            },
          ],
        },
        {
          type: 'separator',
        },
        {
          label: t('plugins.music-stats-dashboard.menu.export', 'Export Stats'),
          click: async () => {
            ctx.window.webContents.send('music-stats:export');
          },
        },
        {
          label: t('plugins.music-stats-dashboard.menu.import', 'Import Stats'),
          click: async () => {
            ctx.window.webContents.send('music-stats:import');
          },
        },
      ],
    },
  ];
};
