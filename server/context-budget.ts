export type ContextMessage={role:'user'|'assistant';content:string};

export const contextBudgets={historyCharacters:24_000,conversationPairs:10,examQuestionPairs:8,focusCharacters:6000} as const;

/** A character budget is deliberately not presented as a token estimate. The
 * JSON wire representation counts escaped text and message structure as well.
 * Keep the original language anchor and latest complete exchange verbatim even
 * when those essential messages alone exceed the soft budget. Only older
 * complete exchanges may be omitted; stored conversations are never changed. */
export function selectContextHistory(messages:readonly ContextMessage[],options:{maxPairs:number;maxCharacters?:number;preserveFirstUser?:boolean}):ContextMessage[] {
  const maxCharacters=options.maxCharacters??contextBudgets.historyCharacters;
  const pairs:ContextMessage[][]=[];
  for(let index=0;index<messages.length-1;index++){
    if(messages[index].role==='user'&&messages[index+1].role==='assistant'){
      pairs.push([messages[index],messages[index+1]]);index++;
    }
  }
  const anchor=options.preserveFirstUser?messages.find(message=>message.role==='user'):undefined;
  const assemble=(selected:ContextMessage[][])=>{
    const history=selected.flat();
    return anchor&&!history.includes(anchor)?[anchor,...history]:history;
  };
  if(!pairs.length)return anchor?[anchor]:[];
  const selected=[pairs.at(-1)!];
  for(let index=pairs.length-2;index>=0&&selected.length<options.maxPairs;index--){
    const candidate=[pairs[index],...selected];
    if(JSON.stringify(assemble(candidate)).length>maxCharacters)break;
    selected.unshift(pairs[index]);
  }
  return assemble(selected);
}

/** Rotate the first eligible point as well as the rest of the window, so an
 * entry cannot be permanently excluded by another entry's size or list order. */
export function selectFocusKnowledge(points:readonly string[],questionCount:number,previousPapers:number,preferredFocus=''):string[] {
  const available=[...new Set(points)];
  if(!available.length)return [];
  const maxItems=Math.min(60,Math.max(12,questionCount*2));
  if(available.length<=maxItems&&JSON.stringify(available).length<=contextBudgets.focusCharacters)return available;
  const gcd=(a:number,b:number):number=>b?gcd(b,a%b):a;
  // A coprime stride eventually makes every available point the first choice,
  // including when the character budget allows fewer than maxItems entries.
  let stride=Math.min(maxItems,available.length);
  while(stride>1&&gcd(stride,available.length)!==1)stride--;
  const start=((previousPapers%available.length)*stride)%available.length;
  const normalizedFocus=preferredFocus.normalize('NFC').trim();
  // The user's exact requested saved word/point takes precedence over rotation.
  // Match literal text only; all returned entries retain their saved spelling.
  const preferred=normalizedFocus?available.filter(point=>{
    const normalized=point.normalize('NFC').trim();
    return normalized.length>0&&normalizedFocus.includes(normalized);
  }):[];
  const preferredSet=new Set(preferred);
  const rotated=available.map((_,offset)=>available[(start+offset)%available.length]).filter(point=>!preferredSet.has(point));
  const candidates=[...preferred,...rotated];
  const selected:string[]=[];
  for(const point of candidates){
    if(selected.length>=maxItems)break;
    // Keep a single unusual but valid learning point whole. Never silently
    // alter its Japanese text just to make the nominal budget fit.
    if(selected.length&&JSON.stringify([...selected,point]).length>contextBudgets.focusCharacters)break;
    selected.push(point);
  }
  return selected;
}
