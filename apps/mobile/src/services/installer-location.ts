import * as Location from 'expo-location';
import { buildInstallerLocationPayload, type InstallerLocationPayload } from './installer-location-core';

/**
 * O sistema operacional mostra o consentimento. Qualquer indisponibilidade
 * devolve null para que o cadastro prossiga e o servidor aplique GeoIP.
 */
export async function captureInstallerLocation(): Promise<InstallerLocationPayload | null> {
  try {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (permission.status !== Location.PermissionStatus.GRANTED) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 8_000); }),
    ]).finally(() => clearTimeout(timer));
    if (!current) return null;
    return buildInstallerLocationPayload(
      current.coords.latitude,
      current.coords.longitude,
      current.coords.accuracy,
    );
  } catch {
    return null;
  }
}
