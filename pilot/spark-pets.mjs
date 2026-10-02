// Harmless pet choice/care lives outside the wallet document. Rules validate
// ownership and a monotonic care count; ticket use and prizes remain parent-only.
import * as E from './engine.mjs';

export const careId=(kidId,pet,action)=>`${kidId}_${pet}_${action}`;
export function mergePetActivity(state,choices=[],care=[]){
  const next=structuredClone(E.validate(state));
  for(const row of choices){
    const kid=next.kids.find(k=>k.id===row.kidId);
    if(kid?.pets?.includes(row.pet))kid.pet=row.pet;
  }
  for(const row of care){
    const kid=next.kids.find(k=>k.id===row.kidId);
    if(!kid?.pets?.includes(row.pet)||!['feed','play','wash'].includes(row.action)||!Number.isSafeInteger(row.count))continue;
    kid.petst ||= {};
    const stats=kid.petst[row.pet]||{f:0,p:0,w:0,c:0,b:row.lastAt};
    stats.c=(stats.c||0)+row.count;
    const field={feed:'f',play:'p',wash:'w'}[row.action];
    stats[field]=Math.max(stats[field]||0,row.lastAt||0);
    kid.petst[row.pet]=stats;
  }
  return next;
}
