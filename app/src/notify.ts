// Notifications:
// - While the app is open: native local notification (mobile) or the Notification API (desktop/browser).
// - When the app is closed (mobile only): Firebase push, if the server has it enabled and the user allowed it.
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { PushNotifications } from '@capacitor/push-notifications';
import { api } from './api';

let nextId = 1;
let pushStatus = '';

export const isNative = () => Capacitor.isNativePlatform();
export const getPushStatus = () => pushStatus;

export async function requestNotificationPermission(): Promise<void> {
  try {
    if (isNative()) {
      await LocalNotifications.requestPermissions();
    } else if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      await Notification.requestPermission();
    }
  } catch {
    /* ignore */
  }
}

export async function showSystemNotification(title: string, body: string): Promise<void> {
  try {
    if (isNative()) {
      await LocalNotifications.schedule({
        notifications: [{ id: nextId++, title, body, schedule: { at: new Date(Date.now() + 200) } }],
      });
    } else if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus()) return;
      new Notification(title, { body });
    }
  } catch {
    /* ignore */
  }
}

/**
 * Registers this phone for push notifications and sends the device token to the server.
 * Safe to call on every sign-in; does nothing in the browser / desktop app.
 */
export async function enablePush(onOpen?: (data: Record<string, string>) => void): Promise<void> {
  if (!isNative()) {
    pushStatus = 'Push while closed is available in the mobile app.';
    return;
  }
  try {
    let perm = await PushNotifications.checkPermissions();
    if (perm.receive === 'prompt') perm = await PushNotifications.requestPermissions();
    if (perm.receive !== 'granted') {
      pushStatus = 'Notification permission not granted.';
      return;
    }
    await PushNotifications.removeAllListeners();
    PushNotifications.addListener('registration', async (token) => {
      try {
        const r = await api.registerDevice(token.value, Capacitor.getPlatform());
        pushStatus = `Push: ${r.push}`;
      } catch (e) {
        pushStatus = `Could not register device: ${(e as Error).message}`;
      }
    });
    PushNotifications.addListener('registrationError', (err) => {
      pushStatus = `Push registration failed: ${JSON.stringify(err)}`;
    });
    PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      onOpen?.((action.notification.data || {}) as Record<string, string>);
    });
    await PushNotifications.register();
  } catch (e) {
    pushStatus = `Push unavailable: ${(e as Error).message}`;
  }
}
