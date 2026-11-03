import {create} from 'zustand';
import axios from 'axios';
import {getApiBaseUrl} from '../lib/api-base';
import type {NoticeState} from '../lib/notice-policy';
import {useAuthStore} from './authStore';
export const useNoticePolicyStore=create<{
  states:Record<string,NoticeState>; reset:()=>void; receive:(states:NoticeState[])=>void; refresh:()=>Promise<void>;
}>((set,get)=>({
  states:{},reset:()=>set({states:{}}),
  receive:states=>set({states:Object.fromEntries(states.map(s=>[s.cameraId,s]))}),
  refresh:async()=>{
    const token=useAuthStore.getState().accessToken;if(!token)return;
    const {data}=await axios.get<{states:NoticeState[]}>(`${getApiBaseUrl()}/notice-policies`,{headers:{Authorization:`Bearer ${token}`},timeout:10000});
    if(token===useAuthStore.getState().accessToken)get().receive(data.states);
  },
}));
