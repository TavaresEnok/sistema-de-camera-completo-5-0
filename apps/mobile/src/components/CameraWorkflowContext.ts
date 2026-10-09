import { createContext, useContext } from 'react';
import type { Camera } from '../types';

export const CameraWorkflowContext = createContext<{
  userId: string;
  openCamera: (camera: Camera) => void;
  editCamera: (camera: Camera) => void;
} | null>(null);

export const useCameraWorkflow = () => useContext(CameraWorkflowContext);
