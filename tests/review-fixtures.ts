import type { AIProvider } from '../server/learning.js';

/** Existing transport tests return six-field teacher fixtures. Give those
 * fixtures an explicit checked verdict; malformed fixtures stay malformed. */
export function checkedReviewReply(output:string,messages:Parameters<AIProvider['generate']>[0]):string {
  let result:Record<string,unknown>;
  try{result=JSON.parse(output);}catch{return output;}
  if(!result||Array.isArray(result)||Object.keys(result).sort().join(',')!=='focus,kind,meaning,note,reading,title')return output;
  if(['title','kind','meaning','focus'].some(key=>typeof result[key]!=='string'||!String(result[key]).trim())||typeof result.reading!=='string'||typeof result.note!=='string')return output;
  const payload=JSON.parse(messages.find(message=>message.role==='user')!.content);
  const context=String(payload.context||payload.selectedText||'');
  const evidence=Array.from(context).slice(0,80).join('');
  return JSON.stringify({...result,usageKey:'全体用法',assessment:{outcome:'verified',reason:'测试老师已结合提供的原文核查整体用法。',evidence:[evidence],originalUnderstanding:''}});
}
