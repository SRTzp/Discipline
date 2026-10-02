// Keep the same operation ID after an uncertain network failure. A confirmed
// server rejection or success frees the ID for a new, intentional operation.
const REJECTED=new Set(['functions/failed-precondition','functions/permission-denied',
  'functions/invalid-argument','functions/unauthenticated',
  'failed-precondition','permission-denied','invalid-argument','unauthenticated']);
export function createOperationTracker(makeId=()=>crypto.randomUUID()){
  const uncertain=new Map();
  return {
    idFor(key){return uncertain.get(key)||makeId()},
    failed(key,id,code){if(REJECTED.has(code))uncertain.delete(key);else{
      if(uncertain.size>=20)uncertain.delete(uncertain.keys().next().value);
      uncertain.set(key,id);
    }},
    succeeded(key){uncertain.delete(key)}
  };
}
