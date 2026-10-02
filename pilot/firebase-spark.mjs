// Spark-plan client. One family Auth account; child request documents are
// append-only, while parent wallet operations require password reauthentication.
import {initializeApp} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {getAuth,onAuthStateChanged,signInWithEmailAndPassword,EmailAuthProvider,reauthenticateWithCredential,getIdTokenResult} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {getFirestore,doc,collection,query,where,getDocsFromServer, getDocFromServer,runTransaction,onSnapshot,serverTimestamp} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import {createSparkStore} from './spark-store.mjs';
import {createOperationTracker} from './live-retry.mjs';

const config={apiKey:'AIzaSyCkWB1di_6G64YFMx2ducpNYypCGs5chUY',authDomain:'discipline-629c3.firebaseapp.com',projectId:'discipline-629c3',storageBucket:'discipline-629c3.firebasestorage.app',messagingSenderId:'920264804175',appId:'1:920264804175:web:b84d3641c3abee6ed4273a'};
function authReady(auth){return new Promise((resolve,reject)=>{const stop=onAuthStateChanged(auth,user=>{stop();resolve(user)},reject)})}
async function ensureSignedIn(auth){
  const signedIn=await authReady(auth);if(signedIn)return signedIn;
  const root=document.getElementById('app');
  root.innerHTML='<div class="card" style="max-width:420px;margin:40px auto"><h2>Discipline · บัญชีครอบครัว</h2><form id="sparkLogin"><label>อีเมล</label><input name="email" type="email" autocomplete="username" required><label>รหัสผ่านบัญชี</label><input name="password" type="password" autocomplete="current-password" required><button class="btn-primary btn-full" type="submit">เข้าสู่ระบบ</button><div id="sparkLoginError" class="muted"></div></form></div>';
  return new Promise(resolve=>root.querySelector('#sparkLogin').addEventListener('submit',async event=>{
    event.preventDefault();const form=event.currentTarget,button=form.querySelector('button'),error=form.querySelector('#sparkLoginError');button.disabled=true;
    try{const email=form.querySelector('[name="email"]'),password=form.querySelector('[name="password"]');
      const signedIn=await signInWithEmailAndPassword(auth,email.value,password.value);password.value='';resolve(signedIn.user)}
    catch(cause){error.textContent='เข้าสู่ระบบไม่สำเร็จ: '+cause.message;button.disabled=false}
  }));
}
export async function connectPilotSpark(){
  const app=initializeApp(config),auth=getAuth(app),user=await ensureSignedIn(auth);
  const store=createSparkStore({db:getFirestore(app),doc,collection,query,where,getDocs:getDocsFromServer,getDoc:getDocFromServer,runTransaction,onSnapshot,serverTimestamp},user.uid);
  const tracker=createOperationTracker();
  let expiresAt=0;
  const hasParentSession=()=>Date.now()<expiresAt;
  return {
    isLive:true,isSpark:true,userUid:user.uid,
    loadOrCreate:()=>store.read(),
    async apply(action,args=[]){
      if(action==='submitTask'||action==='requestReward')return store.submitIntent(action,args);
      if(action==='choosePet')return store.choosePet(args[0],args[1]);
      if(action==='carePet')return store.carePet(args[0],args[1]);
      if(['approveTask','rejectTask','settleReward'].includes(action)&&String(args[0]||'').startsWith('ci-')){
        if(!hasParentSession())throw Error('ยืนยันรหัสผ่านบัญชีครอบครัวอีกครั้งก่อนอนุมัติ');
        const id=args[0].slice(3),approve=action==='approveTask'||(action==='settleReward'&&args[1]===true),sharedConsent=args[2]===true;
        const key=JSON.stringify({action:'decideIntent',id,approve,sharedConsent}),operationId=tracker.idFor(key);
        try{const result=await store.decideIntent(id,approve,operationId,sharedConsent);tracker.succeeded(key);
          return {state:result.state,result:result.result,revision:result.revision}}
        catch(error){tracker.failed(key,operationId,error.code);throw error}
      }
      if(!hasParentSession())throw Error('ยืนยันรหัสผ่านบัญชีครอบครัวอีกครั้งก่อนบันทึก');
      const key=JSON.stringify({action,args}),operationId=tracker.idFor(key);
      try{const result=await store.apply(action,args,operationId);tracker.succeeded(key);
        return {state:result.state,result:result.result,revision:result.revision}}
      catch(error){tracker.failed(key,operationId,error.code);throw error}
    },
    hasParentSession,
    parentStatus:async()=>({enrolled:true,method:'family-password',warning:'ผู้ที่รู้รหัสผ่านบัญชีครอบครัวทำรายการผู้ปกครองได้'}),
    async unlockParent(password){
      if(!user.email)throw Error('บัญชีนี้ไม่มีอีเมลสำหรับยืนยันซ้ำ');
      await reauthenticateWithCredential(user,EmailAuthProvider.credential(user.email,password));
      const token=await getIdTokenResult(user,true),authAt=Date.parse(token.authTime);
      if(!Number.isFinite(authAt)||Date.now()-authAt>=60000)throw Error('การยืนยันซ้ำหมดเวลา');
      expiresAt=authAt+60000;
      return {expiresAt,method:'family-password'};
    },
    async lockParent(){expiresAt=0},
    subscribe:(onState,onError)=>store.subscribe(onState,onError)
  };
}
