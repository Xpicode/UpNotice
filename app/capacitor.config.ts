import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.upright.upnotice',
  appName: 'UpNotice',
  webDir: 'dist',
  server: {
    // Production builds only talk to the server over HTTPS. To test against a plain http:// server on your LAN,
    // build with CAP_CLEARTEXT=1 (e.g. CAP_CLEARTEXT=1 npm run mobile:sync).
    androidScheme: 'https',
    ...(process.env.CAP_CLEARTEXT === '1' ? { cleartext: true } : {}),
  },
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_icon_config_sample',
      iconColor: '#1d4ed8',
    },
  },
};

export default config;
