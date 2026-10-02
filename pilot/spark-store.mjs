// Browser transaction bridge for Firebase Spark. Child inbox writes use strict
// append-only rules; only parent reauthentication permits wallet transactions.
// The parent is trusted to run the engine: Rules cannot recalculate it.
import * as E from './engine.mjs';
import {makeIntent,mergeIntents,decideIntent,intentBucket,INTENT_DAYS_VISIBLE} from './spark-intents.mjs';
import {careId,mergePetActivity} from './spark-pets.mjs';

export const SPARK_ACTIONS = new Set([
  'setPlan','submitTask','approveTask','rejectTask','settleLegacyChore','requestReward','settleReward',
  'cancelReward','openDeposit','withdrawDeposit','matureDeposits','openLoan','repayLoan',
  'penalty','adjust','transfer','hatchPet','carePet','choosePet','startJourney','completeJourneyStage'
]);
const MAX_STATE_BYTES=750000;
const ID=/^[\w-]{8,128}$/;
const clone=value=>structuredClone(value);
function checkSize(state){
  if(new TextEncoder().encode(JSON.stringify(state)).length>MAX_STATE_BYTES)
    throw Error('ข้อมูลใกล้ขนาดสูงสุดของเอกสาร Firestore ต้องเก็บประวัติเก่าก่อน');
}
export function createSparkStore({db,doc,collection,query,where,getDocs,runTransaction,getDoc,onSnapshot,serverTimestamp},familyId){
  if(!/^[\w-]+$/.test(familyId||''))throw Error('familyId ไม่ถูกต้อง');
  const stateRef=doc(db,'families',familyId,'sparkPilot','state');
  const opRef=id=>doc(db,'families',familyId,'sparkOps',id);
  const gateRef=doc(db,'families',familyId,'config','migrationGate');
  const intentsRef=collection?.(db,'families',familyId,'sparkIntents');
  const intentRef=id=>doc(db,'families',familyId,'sparkIntents',id);
  const choicesRef=collection(db,'families',familyId,'sparkPetChoices');
  const careRef=collection(db,'families',familyId,'sparkPetCare');
  const choiceDoc=kidId=>doc(db,'families',familyId,'sparkPetChoices',kidId);
  const careDoc=(kidId,pet,action)=>doc(db,'families',familyId,'sparkPetCare',careId(kidId,pet,action));
  const recent=()=>query(intentsRef,where('dayBucket','>=',intentBucket(Date.now())-INTENT_DAYS_VISIBLE));
  const decodeIntent=snap=>({id:snap.id,...snap.data(),createdAt:snap.data().createdAt.toMillis()});
  async function intents(){return (await getDocs(recent())).docs.map(decodeIntent)}
  const decodeChoice=snap=>({kidId:snap.id,pet:snap.data().pet});
  const decodeCare=snap=>({...snap.data(),lastAt:snap.data().lastAt.toMillis()});
  async function overlays(){const [pending,choices,care]=await Promise.all([intents(),getDocs(choicesRef),getDocs(careRef)]);
    return {pending,choices:choices.docs.map(decodeChoice),care:care.docs.map(decodeCare)}}
  const mergeAll=(state,{pending,choices,care})=>mergePetActivity(mergeIntents(state,pending),choices,care);
  return {
    async gate(){const snap=await getDoc(gateRef);return snap.exists()?snap.data():null},
    async read(){const [snap,extra]=await Promise.all([getDoc(stateRef),overlays()]);if(!snap.exists())throw Error('ยังไม่ติดตั้งข้อมูลรุ่นแผนฟรี');return mergeAll(snap.data().state,extra)},
    async choosePet(kidId,pet){
      await runTransaction(db,async tx=>{
        const [gate,state,choice]=await Promise.all([tx.get(gateRef),tx.get(stateRef),tx.get(choiceDoc(kidId))]);
        if(!gate.exists()||gate.data().mode!=='active'||!state.exists())throw Error('ระบบใหม่ยังไม่เปิดใช้');
        const kid=state.data().state.kids.find(k=>k.id===kidId);
        if(!kid?.pets?.includes(pet))throw Error('ยังไม่มีสัตว์ตัวนี้');
        if(choice.exists()&&choice.data().pet===pet)return;
        tx.set(choiceDoc(kidId),{kidId,pet,updatedAt:serverTimestamp()});
      });
      return {state:await this.read(),result:pet,revision:null};
    },
    async carePet(kidId,action){
      if(!['feed','play','wash'].includes(action))throw Error('การดูแลไม่ถูกต้อง');
      const result=await runTransaction(db,async tx=>{
        const [gate,state,choice]=await Promise.all([tx.get(gateRef),tx.get(stateRef),tx.get(choiceDoc(kidId))]);
        if(!gate.exists()||gate.data().mode!=='active'||!state.exists())throw Error('ระบบใหม่ยังไม่เปิดใช้');
        const kid=state.data().state.kids.find(k=>k.id===kidId),pet=choice.exists()?choice.data().pet:kid?.pet;
        if(!kid?.pets?.includes(pet))throw Error('เลือกสัตว์ก่อน');
        const ref=careDoc(kidId,pet,action),old=await tx.get(ref),count=(old.exists()?old.data().count:0)+1;
        tx.set(ref,{kidId,pet,action,count,lastAt:serverTimestamp()});
        return {pet,action,count};
      });
      return {state:await this.read(),result,revision:null};
    },
    async submitIntent(action,args){
      const {id,data}=makeIntent(action,args);
      const submitted=await runTransaction(db,async tx=>{
        const [gate,state,old]=await Promise.all([tx.get(gateRef),tx.get(stateRef),tx.get(intentRef(id))]);
        if(!gate.exists()||gate.data().mode!=='active'||!state.exists())throw Error('ระบบใหม่ยังไม่เปิดใช้');
        if(old.exists()){
          if(Object.entries(data).every(([key,value])=>old.data()[key]===value))return {replayed:true};
          throw Error('ส่งคำขอนี้แล้ววันนี้');
        }
        if(!state.data().state.kids.some(k=>k.id===data.kidId))throw Error('ไม่พบเด็กคนนี้');
        if(data.partnerId&&!state.data().state.kids.some(k=>k.id===data.partnerId))throw Error('ไม่พบผู้ร่วมใช้');
        tx.set(intentRef(id),{...data,createdAt:serverTimestamp()});
        return {replayed:false};
      });
      return {state:await this.read(),result:{id,...submitted},revision:null};
    },
    async decideIntent(id,approve,operationId=crypto.randomUUID(),sharedConsent=false){
      if(typeof id!=='string'||!/^b\d+_[A-Za-z0-9_-]{1,64}_(chore|reward)_[A-Za-z0-9_-]{1,64}$/.test(id))throw Error('รหัสคำขอไม่ถูกต้อง');
      if(!ID.test(operationId))throw Error('operationId ไม่ถูกต้อง');
      const outcome=await runTransaction(db,async tx=>{
        const [gateSnap,stateSnap,intentSnap,opSnap]=await Promise.all([tx.get(gateRef),tx.get(stateRef),tx.get(intentRef(id)),tx.get(opRef(operationId))]);
        if(!gateSnap.exists()||gateSnap.data().mode!=='active'||!gateSnap.data().oldClientsBlocked)throw Error('ระบบใหม่ยังไม่เปิดใช้');
        if(!stateSnap.exists()||!intentSnap.exists())throw Error('ไม่พบคำขอ');
        if(opSnap.exists())return {state:E.validate(clone(stateSnap.data().state)),result:JSON.parse(opSnap.data().resultJson),replayed:true,revision:stateSnap.data().revision};
        const state=E.validate(clone(stateSnap.data().state));
        if(state.sparkIntentOutcomes?.[id])throw Error('คำขอนี้ตัดสินแล้ว');
        if(state.deposits.some(d=>d.status==='open'&&d.dueAt<=Date.now()))E.matureDeposits(state,Date.now());
        const intent=decodeIntent(intentSnap);
        const result=decideIntent(state,intent,approve,{sharedConsent});
        const storedState=E.validate(JSON.parse(JSON.stringify(state)));checkSize(storedState);
        const revision=stateSnap.data().revision+1;
        tx.update(stateRef,{state:storedState,revision,lastOperationId:operationId,updatedAt:serverTimestamp()});
        tx.set(opRef(operationId),{operationId,action:'decideIntent',argsJson:JSON.stringify([id,approve,sharedConsent]),resultJson:JSON.stringify(result),revision,version:E.VERSION,createdAt:serverTimestamp()});
        return {state:storedState,result,replayed:false,revision};
      });
      return {...outcome,state:mergeAll(outcome.state,await overlays())};
    },
    async apply(action,args=[],operationId=crypto.randomUUID()){
      if(!SPARK_ACTIONS.has(action)||typeof E[action]!=='function')throw Error('operation ไม่ได้รับอนุญาต');
      if(!ID.test(operationId))throw Error('operationId ไม่ถูกต้อง');
      const outcome=await runTransaction(db,async tx=>{
        const [gateSnap,stateSnap,opSnap,choiceSnap]=await Promise.all([tx.get(gateRef),tx.get(stateRef),tx.get(opRef(operationId)),
          action==='startJourney'?tx.get(choiceDoc(args[0])):Promise.resolve(null)]);
        if(!gateSnap.exists()||gateSnap.data().mode!=='active'||!gateSnap.data().oldClientsBlocked)
          throw Error('ระบบใหม่ยังไม่เปิดใช้');
        if(!stateSnap.exists())throw Error('ยังไม่ติดตั้งข้อมูลรุ่นแผนฟรี');
        if(opSnap.exists())return {state:E.validate(clone(stateSnap.data().state)),result:JSON.parse(opSnap.data().resultJson),replayed:true,revision:stateSnap.data().revision};
        const state=E.validate(clone(stateSnap.data().state));
        const now=Date.now();
        if(action!=='matureDeposits'&&state.deposits.some(d=>d.status==='open'&&d.dueAt<=now))E.matureDeposits(state,now);
        if(action==='startJourney'&&choiceSnap?.exists())E.choosePet(state,args[0],choiceSnap.data().pet);
        const result=E[action](state,...args)??null;
        // Firestore rejects undefined nested fields; preserve exactly the JSON
        // state and result represented by the journal and UI.
        const storedState=E.validate(JSON.parse(JSON.stringify(state)));
        checkSize(storedState);
        const revision=stateSnap.data().revision+1;
        tx.update(stateRef,{state:storedState,revision,lastOperationId:operationId,updatedAt:serverTimestamp()});
        tx.set(opRef(operationId),{operationId,action,argsJson:JSON.stringify(args),resultJson:JSON.stringify(result),revision,version:E.VERSION,createdAt:serverTimestamp()});
        return {state:storedState,result,replayed:false,revision};
      });
      return {...outcome,state:mergeAll(outcome.state,await overlays())};
    },
    subscribe(onState,onError){let state=null,pending=[],choices=[],care=[];const publish=()=>{if(state)try{onState(mergeAll(state,{pending,choices,care}))}catch(error){onError(error)}};
      const stopState=onSnapshot(stateRef,snap=>{if(snap.exists()){state=E.validate(clone(snap.data().state));publish()}},onError);
      const stopIntents=onSnapshot(recent(),snap=>{pending=snap.docs.map(decodeIntent);publish()},onError);
      const stopChoices=onSnapshot(choicesRef,snap=>{choices=snap.docs.map(decodeChoice);publish()},onError);
      const stopCare=onSnapshot(careRef,snap=>{care=snap.docs.map(decodeCare);publish()},onError);
      return ()=>{stopState();stopIntents();stopChoices();stopCare()};}
  };
}
