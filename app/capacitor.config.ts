import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.upright.upnotice',
  appName: 'UpNotice',
  webDir: 'dist',
  server: {
    // Allows the app to talk to a plain http:// server on your LAN during development.
    androidScheme: 'http',
    cleartext: true,
  },
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_icon_config_sample',
      iconColor: '#1d4ed8',
    },
  },
};

export default config;
