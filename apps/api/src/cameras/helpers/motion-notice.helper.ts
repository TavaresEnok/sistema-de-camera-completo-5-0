/** Same demand at boot, live start and watchdog; never changes recording. */
export const MOTION_NOTICE_DEMAND = {
  OR: [
    { recordingMode: { in: ['motion', 'object'] }, motionTrigger: 'SYSTEM' },
    { motionNoticeEnabled: true },
    { objectNoticeEnabled: true },
  ],
};

export function needsSystemMotion(camera: { recordingMode?: string; motionTrigger?: string; motionNoticeEnabled?: boolean; objectNoticeEnabled?: boolean }): boolean {
  return camera.motionNoticeEnabled === true
    || camera.objectNoticeEnabled === true
    || (['motion', 'object'].includes(camera.recordingMode ?? '') && camera.motionTrigger === 'SYSTEM');
}
