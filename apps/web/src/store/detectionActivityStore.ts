import { create } from 'zustand';
import { DetectionActivityTimeline } from '../lib/detection-activity';

const timeline = new DetectionActivityTimeline();
let timer: ReturnType<typeof setInterval> | undefined;
export const useDetectionActivityStore = create<{
  active: Record<string, true>;
  mark: (cameraId: string) => void;
  reset: () => void;
}>((set) => ({
  active: {},
  mark: cameraId => {
    if (timeline.mark(cameraId)) set(state => ({ active: { ...state.active, [cameraId]: true } }));
    if (timer === undefined) timer = setInterval(() => {
      const expired = timeline.expire();
      if (expired.length) set(state => {
        const active = { ...state.active };
        for (const id of expired) delete active[id];
        return { active };
      });
      if (!timeline.size) { clearInterval(timer); timer = undefined; }
    }, 250);
  },
  reset: () => { timeline.clear(); if (timer !== undefined) clearInterval(timer); timer = undefined; set({ active: {} }); },
}));
