import axios from 'axios';
import { create } from 'zustand';
import { getApiBaseUrl } from '../lib/api-base';

export type PermissionKey = 'liveView' | 'playback' | 'ptzControl' | 'alarmAck' | 'cameraConfig' | 'userManage' | 'auditLogs' | 'exportEvidence' | 'serverConfig' | 'roleManage' | 'reportGenerate';
type State = {
  permissions: Partial<Record<PermissionKey, boolean>>;
  role: string;
  loaded: boolean;
  error: boolean;
  load: (token: string) => Promise<void>;
  reset: () => void;
};
let generation = 0;
export const usePermissionsStore = create<State>((set) => ({
  permissions: {}, role: '', loaded: false, error: false,
  reset: () => { generation++; set({ permissions: {}, role: '', loaded: false, error: false }); },
  load: async (token) => {
    const current = ++generation;
    try {
      const { data } = await axios.get(`${getApiBaseUrl()}/role-permissions/me`, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
      if (generation === current) set({ permissions: data.permissions ?? {}, role: data.role, loaded: true, error: false });
    } catch {
      if (generation === current) set({ loaded: true, error: true });
    }
  },
}));
export function hasPermission(key: PermissionKey) {
  const state = usePermissionsStore.getState();
  return state.role === 'SUPER_ADMIN' || state.permissions[key] === true;
}
export const ADMIN_PAGE_PERMISSION: Record<string, PermissionKey> = {
  '/groups': 'cameraConfig', '/roles': 'roleManage', '/settings': 'serverConfig', '/users': 'userManage',
};
