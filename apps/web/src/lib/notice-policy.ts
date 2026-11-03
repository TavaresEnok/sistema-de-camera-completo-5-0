export type NoticePeriod={days:number[];start:string;end:string};
export type NoticeSchedule={mode:'always'|'periods'|'off';timezone:string;periods:NoticePeriod[]};
export type NoticePolicy={manualMode:'auto'|'on'|'off';schedule:NoticeSchedule|null};
export type NoticeState={cameraId:string;configured:boolean;active:boolean;manualMode:NoticePolicy['manualMode'];schedule:NoticeSchedule;source:string;groupId:string|null;groupName:string|null;reason:string};
export type NoticePolicyDocument={scope:'camera'|'group';id:string;name:string;policy:NoticePolicy;version:string;groupId:string|null;groupName:string|null;inheritedSchedule:NoticeSchedule};
export function noticeStateLabel(state?:NoticeState):string {
  if(!state)return 'Consultando avisos';
  if(state.reason==='not-configured')return 'Avisos não configurados';
  if(state.reason==='invalid-policy')return 'Confira a programação dos avisos';
  if(state.reason==='paused')return 'Avisos pausados manualmente';
  if(state.reason==='manual-on')return 'Avisos ativados manualmente';
  return state.active?'Avisos ativos':'Avisos fora do horário';
}
