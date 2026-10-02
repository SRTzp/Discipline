// Child requests are immutable inbox entries. They never reserve points or
// change the authoritative game state; a recently reauthenticated parent
// decides them in one state/journal transaction.
import * as E from './engine.mjs';

export const INTENT_DAYS_VISIBLE=30;
const DAY_MS=86400000;
const ID=/^[A-Za-z0-9_-]{1,64}$/;
// A deterministic Bangkok-day slot bounds each child to one request per item.
export const intentBucket=ts=>Math.floor((ts+7*3600000)/DAY_MS);
export const intentId=(bucket,kidId,kind,itemId)=>`b${bucket}_${kidId}_${kind}_${itemId}`;
export const requestIdForIntent=id=>`ci-${id}`;

export function makeIntent(action,args,now=Date.now()){
  const bucket=intentBucket(now);
  if(action==='submitTask'){
    const [kidId,taskId,,options={}]=args;
    if(!ID.test(kidId)||!Object.hasOwn(E.RULES.tasks,taskId))throw Error('งานหรือชื่อเด็กไม่ถูกต้อง');
    const minutes=Number(options.minutes||0);
    if(!Number.isSafeInteger(minutes)||minutes<0||minutes>240)throw Error('จำนวนนาทีไม่ถูกต้อง');
    const data={kind:'chore',kidId,itemId:taskId,dayBucket:bucket,
      complete:options.complete===true,minutes,assignmentDone:options.assignmentDone===true};
    return {id:intentId(bucket,kidId,'chore',taskId),data};
  }
  if(action==='requestReward'){
    const [rewardId,participants,shares]=args;
    const kidId=participants?.[0],partnerId=participants?.[1]||'';
    if(!ID.test(kidId)||!Object.hasOwn(E.RULES.rewards,rewardId)
      ||!Array.isArray(participants)||participants.length<1||participants.length>2
      ||(partnerId&&(!ID.test(partnerId)||partnerId===kidId)))throw Error('รางวัลหรือผู้ร่วมใช้ไม่ถูกต้อง');
    const ownShare=shares?.[kidId],cost=E.RULES.rewards[rewardId].cost;
    if(!Number.isSafeInteger(ownShare)||ownShare<0||ownShare>cost
      ||(partnerId?shares?.[partnerId]!==cost-ownShare:ownShare!==cost))throw Error('ส่วนแบ่งแต้มไม่ถูกต้อง');
    const data={kind:'reward',kidId,itemId:rewardId,dayBucket:bucket,partnerId,ownShare};
    return {id:intentId(bucket,kidId,'reward',rewardId),data};
  }
  throw Error('รายการนี้ต้องให้ผู้ปกครองยืนยัน');
}

export function intentAsRequest(intent){
  const r={id:requestIdForIntent(intent.id),status:'pending',type:intent.kind,
    kidId:intent.kidId,createdAt:intent.createdAt,childIntentId:intent.id};
  if(intent.kind==='chore')return {...r,taskId:intent.itemId,day:E.dayKey(intent.createdAt),
    finishedAt:intent.createdAt,complete:intent.complete,minutes:intent.minutes,
    assignmentDone:intent.assignmentDone};
  const cost=E.RULES.rewards[intent.itemId]?.cost;
  if(!Number.isSafeInteger(cost))throw Error('รางวัลไม่ถูกต้อง');
  const participants=intent.partnerId?[intent.kidId,intent.partnerId]:[intent.kidId];
  return {...r,type:'reward',rewardId:intent.itemId,participants,
    shares:{[intent.kidId]:intent.ownShare,...(intent.partnerId?{[intent.partnerId]:cost-intent.ownShare}:{})},
    ts:intent.createdAt,day:E.dayKey(intent.createdAt)};
}

export function mergeIntents(state,intents){
  const next=structuredClone(E.validate(state));
  const done=next.sparkIntentOutcomes||{};
  const existing=new Set(next.requests.map(r=>r.id));
  for(const intent of intents){
    const id=requestIdForIntent(intent.id);
    if(!done[intent.id]&&!existing.has(id))next.requests.push(intentAsRequest(intent));
  }
  return next;
}

export function decideIntent(state,intent,approve,{sharedConsent=false}={}){
  if(!intent||typeof intent.id!=='string')throw Error('ไม่พบคำขอ');
  state.sparkIntentOutcomes ||= {};
  if(state.sparkIntentOutcomes[intent.id])return state.sparkIntentOutcomes[intent.id];
  const req=intentAsRequest(intent),id=req.id;
  if(intent.kind==='chore'){
    E.submitTask(state,intent.kidId,intent.itemId,intent.createdAt,{
      complete:intent.complete,minutes:intent.minutes,assignmentDone:intent.assignmentDone,requestId:id});
    if(approve)E.approveTask(state,id);else E.rejectTask(state,id);
  }else if(intent.kind==='reward'&&approve){
    // Reserve and settle inside the same parent transaction. An unapproved
    // child request never locks either child's balance or weekly quota.
    const now=Date.now(),group=E.RULES.rewards[intent.itemId].group;
    if(req.participants.length>1&&sharedConsent!==true)
      throw Error('ผู้ปกครองต้องยืนยันส่วนแบ่งและความยินยอมของผู้ร่วมใช้');
    if(['screen','dinner','icecream'].includes(group)&&E.dayKey(intent.createdAt)!==E.dayKey(now))
      throw Error('คำขอรางวัลนี้ข้ามวันแล้ว ให้เด็กส่งคำขอใหม่');
    E.requestReward(state,intent.itemId,req.participants,req.shares,now,id);
    E.settleReward(state,id,true,now);
  }
  const outcome={status:approve?'approved':'rejected',kind:intent.kind,at:Date.now(),
    ...(approve&&intent.kind==='reward'&&req.participants.length>1?{sharedConsentConfirmed:true}:{})};
  state.sparkIntentOutcomes[intent.id]=outcome;
  return outcome;
}
