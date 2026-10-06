/** Same demand at boot, live start and watchdog; never changes recording. */
export const MOTION_NOTICE_DEMAND = {
  OR: [
    { recordingMode: { in: ['motion', 'object'] }, motionTrigger: 'SYSTEM' },
    { motionNoticeEnabled: true },
  ],
};

export function needsSystemMotion(camera: { recordingMode?: string; motionTrigger?: string; motionNoticeEnabled?: boolean }): boolean {
  return camera.motionNoticeEnabled === true
    || (['motion', 'object'].includes(camera.recordingMode ?? '') && camera.motionTrigger === 'SYSTEM');
}
