const SAFE_FIELDS = {
  sites: ['id', 'name', 'description', 'location', 'isActive', 'createdAt', 'updatedAt'],
  siteMapLayouts: ['id', 'siteId', 'floor', 'markers', 'createdAt', 'updatedAt'],
  areas: ['id', 'siteId', 'name', 'description', 'isActive', 'createdAt', 'updatedAt'],
  groups: ['id', 'name', 'description', 'isActive', 'accessStatus', 'accessMessage', 'maxPrivateCameras', 'retentionDays', 'createdAt', 'updatedAt'],
  users: ['id', 'name', 'email', 'role', 'isActive', 'createdAt', 'updatedAt'],
  cameras: [
    'id', 'name', 'ip', 'rtspPort', 'onvifPort', 'httpPort', 'username', 'rtspPath',
    'onvifPath', 'onvifProfileToken', 'ptzCapable', 'ptzCapableSource', 'objectMode',
    'aiObjectClasses', 'aiSensitivity', 'aiConfidence',
    'recordingObjectClasses', 'channel', 'subtype', 'liveChannel', 'liveSubtype',
    'recordingChannel', 'recordingSubtype', 'analyticsChannel', 'analyticsSubtype',
    'siteId', 'areaId', 'locationAddress', 'latitude', 'longitude', 'groupId', 'groupIds', 'recordingEnabled', 'recordingMode', 'retentionDays',
    'retentionFollowsGroup', 'preferredRtspTransport', 'preferredLiveProtocol', 'sourceMode',
    'streamVideoCodec', 'streamWidth', 'streamHeight', 'streamFps', 'streamBitrateKbps',
    'recordingVideoCodec', 'recordingWidth', 'recordingHeight', 'recordingFps',
    'recordingBitrateKbps', 'audioEnabled', 'aiEnabled', 'alarmsEnabled', 'hasEdgeAi',
    'motionTrigger', 'detectionZones', 'isPrivate', 'ownerUserId', 'createdAt', 'updatedAt',
  ],
  cameraPermissions: ['id', 'userId', 'cameraId', 'groupId', 'level', 'createdAt'],
  liveLayouts: ['id', 'userId', 'name', 'gridSize', 'cameraIds', 'lastUsedAt', 'createdAt', 'updatedAt'],
  aiSettings: ['id', 'enabled', 'mode', 'showObjectBox', 'updatedAt'],
  rolePermissions: ['role', 'permissions', 'updatedAt'],
  systemSettings: ['key', 'value', 'updatedAt', 'updatedByUserId'],
} as const;

type SnapshotCollection = keyof typeof SAFE_FIELDS;

function pick(record: Record<string, unknown>, fields: readonly string[]) {
  return Object.fromEntries(fields.filter((field) => record[field] !== undefined).map((field) => [field, record[field]]));
}

function settingIsSafe(record: Record<string, unknown>) {
  const key = String(record.key ?? '');
  return !/(password|secret|token|credential|license|cloud\.)/i.test(key);
}

export function sanitizeReactivationCollection(name: SnapshotCollection, rows: unknown[]) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object' && !Array.isArray(row)))
    .filter((row) => name !== 'systemSettings' || settingIsSafe(row))
    .map((row) => pick(row, SAFE_FIELDS[name]));
}

export interface ReactivationSnapshot {
  version: 1;
  createdAt: string;
  installation: { id: string; customerName: string | null };
  sites: Record<string, unknown>[];
  siteMapLayouts: Record<string, unknown>[];
  areas: Record<string, unknown>[];
  groups: Record<string, unknown>[];
  users: Record<string, unknown>[];
  cameras: Record<string, unknown>[];
  cameraPermissions: Record<string, unknown>[];
  liveLayouts: Record<string, unknown>[];
  aiSettings: Record<string, unknown>[];
  rolePermissions: Record<string, unknown>[];
  systemSettings: Record<string, unknown>[];
}

export function buildReactivationSnapshot(input: {
  installationId: string;
  customerName?: string | null;
  createdAt?: Date;
  collections: Record<SnapshotCollection, unknown[]>;
}): ReactivationSnapshot {
  return {
    version: 1,
    createdAt: (input.createdAt ?? new Date()).toISOString(),
    installation: { id: input.installationId, customerName: input.customerName ?? null },
    sites: sanitizeReactivationCollection('sites', input.collections.sites),
    siteMapLayouts: sanitizeReactivationCollection('siteMapLayouts', input.collections.siteMapLayouts),
    areas: sanitizeReactivationCollection('areas', input.collections.areas),
    groups: sanitizeReactivationCollection('groups', input.collections.groups),
    users: sanitizeReactivationCollection('users', input.collections.users),
    cameras: sanitizeReactivationCollection('cameras', input.collections.cameras),
    cameraPermissions: sanitizeReactivationCollection('cameraPermissions', input.collections.cameraPermissions),
    liveLayouts: sanitizeReactivationCollection('liveLayouts', input.collections.liveLayouts),
    aiSettings: sanitizeReactivationCollection('aiSettings', input.collections.aiSettings),
    rolePermissions: sanitizeReactivationCollection('rolePermissions', input.collections.rolePermissions),
    systemSettings: sanitizeReactivationCollection('systemSettings', input.collections.systemSettings),
  };
}
