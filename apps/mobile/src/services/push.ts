import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { request } from './api';
import { flushPushRemovals, queuePushRemoval, rememberPushRegistration } from './push-revocation';

// Como o app se comporta ao receber um push com o app EM PRIMEIRO PLANO.
// (SDK 54: banner + som + badge; a lista mantém no centro de notificações.)
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

let cachedDeviceToken: string | null = null;

async function ensureAndroidChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('alarms', {
    name: 'Alarmes',
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#EF4444',
    sound: 'default',
    bypassDnd: false,
    // Em tela bloqueada, o sistema anuncia que há um alarme sem expor câmera,
    // local ou conteúdo do evento para quem estiver com o aparelho na mão.
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
  });

    // ── CANAL DO BOTÃO DE PÂNICO ────────────────────────────────────────────
    //
    // Pedido em 25/08/2026: quando um morador do condomínio aperta ALERTA, o
    // aparelho dos outros vibra TRÊS vezes, "para chamar atenção".
    //
    // Canal PRÓPRIO, separado de 'alarms', por dois motivos:
    //   · alarme de movimento é rotina e o de pânico é pedido de socorro —
    //     misturar os dois faz o morador ignorar os dois;
    //   · no Android o usuário silencia POR CANAL. Quem cansar do movimento
    //     noturno silencia 'alarms' e continua recebendo pânico, que é
    //     exatamente o que se quer.
    //
    // O padrão é [espera, vibra, pausa, vibra, pausa, vibra]: três pulsos
    // longos, distinguíveis do padrão curto do alarme comum.
    await Notifications.setNotificationChannelAsync('panico', {
      name: 'Alerta de pânico',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 500, 300, 500, 300, 500],
      lightColor: '#EF4444',
      sound: 'default',
      // Atravessa o "não perturbe". É o único caso em que isso se justifica, e
      // é justamente o motivo de o canal existir separado.
      bypassDnd: true,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
    });
}

/**
 * Registra o aparelho para push de alarmes:
 *  1) cria o canal Android 'alarms';
 *  2) pede permissão (Android 13+/iOS);
 *  3) obtém o token nativo do FCM (Android), sem Expo Push Service;
 *  4) envia ao backend (POST /notifications/devices).
 * Retorna o token nativo (para desregistrar no logout) ou null se indisponível.
 * NUNCA lança — falha de push jamais deve quebrar o login.
 */
export async function registerForPush(apiUrl: string, authToken: string, signal?: AbortSignal): Promise<string | null> {
  try {
    await flushPushRemovals();
    if (signal?.aborted) return null;
    await ensureAndroidChannel();

    // Push real só funciona em aparelho físico (emulador não recebe).
    if (!Device.isDevice) return null;

    const current = await Notifications.getPermissionsAsync();
    let granted = current.granted || current.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
    if (!granted && current.canAskAgain !== false) {
      const asked = await Notifications.requestPermissionsAsync();
      granted = asked.granted || asked.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
    }
    if (!granted) return null;

    // O SDK Expo continua apenas como biblioteca nativa de notificações. Não
    // pedimos ExponentPushToken nem usamos exp.host: no Android o valor abaixo
    // é o registration token do FCM, enviado pela Central diretamente ao FCM.
    if (Platform.OS !== 'android') {
      // iOS exigirá credencial APNs própria antes da migração direta. Não
      // registramos um token que a Central ainda não sabe entregar.
      console.warn('[push] entrega direta está habilitada apenas para Android nesta versão.');
      return null;
    }
    const nativeToken = await Notifications.getDevicePushTokenAsync();
    const fcmToken = String(nativeToken.data || '').trim();
    if (!fcmToken) return null;
    // Prefixo persiste o provedor junto ao token sem migração destrutiva no
    // banco: aparelhos antigos Expo continuam recebendo até serem atualizados.
    const token = `fcm:${fcmToken}`;
    if (signal?.aborted) return null;
    cachedDeviceToken = token;

    const registration = await request<{ revocationReceipt?: string }>(apiUrl, '/notifications/devices', authToken, {
      method: 'POST',
      body: JSON.stringify({ token, platform: Platform.OS }),
      signal,
    });
    if (registration.revocationReceipt) await rememberPushRegistration(apiUrl, token, registration.revocationReceipt);
    if (signal?.aborted) { await unregisterFromPush(apiUrl, authToken, token); return null; }
    return token;
  } catch (error) {
    console.warn('[push] registro falhou:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

/** Remove o token do backend (logout). Best-effort, nunca lança. */
export async function unregisterFromPush(apiUrl: string, authToken: string, deviceToken?: string | null) {
  const token = deviceToken ?? cachedDeviceToken;
  await queuePushRemoval(apiUrl, token).catch(() => undefined);
  void flushPushRemovals();
  if (!token) return;
  try {
    await request(apiUrl, '/notifications/devices', authToken, {
      method: 'DELETE',
      body: JSON.stringify({ token }),
    });
  } catch {
    /* ignore */
  } finally {
    cachedDeviceToken = null;
  }
}

/**
 * Assina o toque na notificação. `onOpenAlarm` recebe os dados do push
 * (alarmId/cameraId) para o app navegar até os alarmes. Retorna um unsubscribe.
 */
export function subscribeToNotificationTaps(
  onOpenAlarm: (data: { alarmId?: string; cameraId?: string }) => void,
) {
  let active = true;
  const handled = new Set<string>();
  const handle = (response: Notifications.NotificationResponse | null) => {
    if (!active || !response) return;
    const notificationId = response.notification.request.identifier;
    if (handled.has(notificationId)) return;
    handled.add(notificationId);
    const data = (response.notification.request.content.data ?? {}) as {
      alarmId?: string;
      cameraId?: string;
    };
    onOpenAlarm(data);
    void Notifications.clearLastNotificationResponseAsync().catch(() => undefined);
  };

  // O listener cobre app aberto/background. A última resposta cobre o cold start
  // (usuário tocou no push quando o processo ainda não existia).
  void Notifications.getLastNotificationResponseAsync().then(handle).catch(() => undefined);
  const sub = Notifications.addNotificationResponseReceivedListener(handle);
  return () => {
    active = false;
    sub.remove();
  };
}
