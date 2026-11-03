// Isolated browser fixture. No production API requests or camera connections.
import React from 'react';
import { createRoot } from 'react-dom/client';
import axios from 'axios';
import { MotionNotices } from '../../src/components/MotionNotices';
import { DesktopNoticeControl } from '../../src/components/DesktopNoticeControl';
import { useAuthStore } from '../../src/store/authStore';
import { useVmsDataStore } from '../../src/store/vmsDataStore';
import { useDesktopNoticeStore } from '../../src/store/desktopNoticeStore';
import { NoticePolicyControl } from '../../src/components/NoticePolicyControl';
import { useNoticePolicyStore } from '../../src/store/noticePolicyStore';

const fixture = window as any;
const OriginalNotification = window.Notification;
fixture.notifications = [];
class ObservedNotification extends OriginalNotification {
  constructor(title: string, options: NotificationOptions) { super(title, options); fixture.notifications.push(this); }
}
window.Notification = ObservedNotification;
let pending: any[] = [];
const always={mode:'always',timezone:'America/Fortaleza',periods:[]};
const docs:any={camera:{scope:'camera',id:'fixture-camera',name:'Portaria',policy:{manualMode:'auto',schedule:null},version:'0',groupId:'fixture-group',groupName:'Grupo de teste',inheritedSchedule:always},
  group:{scope:'group',id:'fixture-group',name:'Grupo de teste',policy:{manualMode:'auto',schedule:always},version:'0',groupId:null,groupName:null,inheritedSchedule:always}};
const states=()=>[{cameraId:'fixture-camera',configured:true,active:docs.camera.policy.manualMode!=='off',manualMode:docs.camera.policy.manualMode,schedule:docs.camera.policy.schedule??docs.group.policy.schedule,source:docs.camera.policy.schedule?'camera':'group',groupId:'fixture-group',groupName:'Grupo de teste',reason:docs.camera.policy.manualMode==='off'?'paused':'active'}];
axios.get = (async (url:string) => ({ data:url.endsWith('/notice-policies')?{states:states()}:url.includes('/notice-policies/')?structuredClone(docs[url.includes('/group/')?'group':'camera']):{items:pending.splice(0),cursor:new Date().toISOString(),states:states()} })) as any;
axios.patch=(async(url:string,body:any)=>{
  const doc=docs[url.includes('/group/')?'group':'camera'];
  if(body.expectedVersion!==doc.version)throw Error('version mismatch');
  const {expectedVersion,...policy}=body;doc.policy={...doc.policy,...policy};doc.version=String(Number(doc.version)+1);
  return {data:structuredClone(doc)};
}) as any;
fixture.policies=()=>structuredClone(docs);
fixture.pause=()=>{docs.camera.policy.manualMode='off';useNoticePolicyStore.getState().receive(states() as any);};
useAuthStore.setState({ user:{id:'fixture-user',name:'Operador',mustChangePassword:false} as any,accessToken:'fixture-token',isAuthenticated:true });
useVmsDataStore.setState({cameras:[{id:'fixture-camera',name:'Portaria',enabled:true,objectNoticeEnabled:true,canViewContent:true,noticeSoundEnabled:false}] as any});
fixture.emit = () => pending.push({id:String(Date.now()),cameraId:'fixture-camera',cameraName:'Portaria',occurredAt:new Date().toISOString(),detectionType:'object',objectClass:'person'});
fixture.revokeCamera = () => useVmsDataStore.setState({cameras:[{id:'fixture-camera',name:'Portaria',enabled:true,objectNoticeEnabled:true,canViewContent:false}] as any});
fixture.logout = () => useAuthStore.setState({user:null,accessToken:null,isAuthenticated:false});
fixture.preference = () => useDesktopNoticeStore.getState().enabled;
createRoot(document.getElementById('root')!).render(<><DesktopNoticeControl expanded/><NoticePolicyControl id="fixture-camera" name="Portaria" compact/><NoticePolicyControl scope="group" id="fixture-group" name="Grupo de teste"/><MotionNotices/></>);
