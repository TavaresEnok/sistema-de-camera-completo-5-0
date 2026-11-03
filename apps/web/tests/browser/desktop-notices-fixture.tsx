// Isolated browser fixture. No production API requests or camera connections.
import React from 'react';
import { createRoot } from 'react-dom/client';
import axios from 'axios';
import { MotionNotices } from '../../src/components/MotionNotices';
import { DesktopNoticeControl } from '../../src/components/DesktopNoticeControl';
import { useAuthStore } from '../../src/store/authStore';
import { useVmsDataStore } from '../../src/store/vmsDataStore';
import { useDesktopNoticeStore } from '../../src/store/desktopNoticeStore';

const fixture = window as any;
const OriginalNotification = window.Notification;
fixture.notifications = [];
class ObservedNotification extends OriginalNotification {
  constructor(title: string, options: NotificationOptions) { super(title, options); fixture.notifications.push(this); }
}
window.Notification = ObservedNotification;
let pending: any[] = [];
axios.get = (async () => ({ data:{items:pending.splice(0),cursor:new Date().toISOString()} })) as any;
useAuthStore.setState({ user:{id:'fixture-user',name:'Operador',mustChangePassword:false} as any,accessToken:'fixture-token',isAuthenticated:true });
useVmsDataStore.setState({cameras:[{id:'fixture-camera',name:'Portaria',enabled:true,objectNoticeEnabled:true,canViewContent:true,noticeSoundEnabled:false}] as any});
fixture.emit = () => pending.push({id:String(Date.now()),cameraId:'fixture-camera',cameraName:'Portaria',occurredAt:new Date().toISOString(),detectionType:'object',objectClass:'person'});
fixture.revokeCamera = () => useVmsDataStore.setState({cameras:[{id:'fixture-camera',name:'Portaria',enabled:true,objectNoticeEnabled:true,canViewContent:false}] as any});
fixture.logout = () => useAuthStore.setState({user:null,accessToken:null,isAuthenticated:false});
fixture.preference = () => useDesktopNoticeStore.getState().enabled;
createRoot(document.getElementById('root')!).render(<><DesktopNoticeControl expanded/><MotionNotices/></>);
