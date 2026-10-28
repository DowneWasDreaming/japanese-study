import { redactFailureText } from './diagnostics.js';
import { reviewEvidenceFailurePrefix,reviewEvidenceFailureSchema,type ReviewEvidenceFailure } from './review-evidence-diagnostics.js';

export type EvidenceSource={label:string;text:string};
export type ContextOnlySource={kind:'explanation'|'existing_knowledge'|'existing_usages';text:string};
export type EvidenceMatch={matched:true;text:string}|{matched:false;reason:'quote_not_found'|'ambiguous_match'};
type Unit={value:string;start:number;end:number};
type IndexedText={text:string;starts:number[];ends:number[]};
const segmenter=new Intl.Segmenter('ja',{granularity:'grapheme'});
const japanese=/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const wrappers:readonly [string,string][]=[['「','」'],['『','』'],['“','”'],['‘','’'],['"','"'],["'","'"],['＂','＂'],['＇','＇'],['«','»']];

function unwrap(value:string){
  const text=value.trim();
  const pair=wrappers.find(([start,end])=>text.length>=start.length+end.length&&text.startsWith(start)&&text.endsWith(end));
  return pair?text.slice(pair[0].length,text.length-pair[1].length).trim():text;
}
/** Only width variants of ASCII have a one-to-one display mapping. General
 * NFKC would also change circled numbers, units and Japanese compatibility forms. */
const displayWidth=(value:string)=>value.replace(/[！-～]/gu,char=>String.fromCharCode(char.charCodeAt(0)-0xfee0));
function indexText(value:string):IndexedText {
  const units:Unit[]=[];
  for(const segment of segmenter.segment(value)){
    const normalized=displayWidth(segment.segment.normalize('NFC'));
    const unit={value:normalized,start:segment.index,end:segment.index+segment.segment.length};
    if(/^\s+$/u.test(normalized)&&units.length&&/^\s+$/u.test(units.at(-1)!.value)){
      units.at(-1)!.end=unit.end;units.at(-1)!.value+=' ';
    }else units.push(unit);
  }
  let text='';const starts:number[]=[],ends:number[]=[];
  for(const [index,unit] of units.entries()){
    let content=unit.value;
    if(/^\s+$/u.test(content)){
      if(index===0||index===units.length-1)continue;
      // Japanese layout spaces do not form word boundaries. ASCII words do:
      // "can not" must never be accepted as "cannot".
      const before=units[index-1].value.at(-1)||'',after=units[index+1].value[0]||'';
      if(japanese.test(before)||japanese.test(after))continue;
      content=' ';
    }
    text+=content;
    for(let offset=0;offset<content.length;offset++){starts.push(unit.start);ends.push(unit.end);}
  }
  return {text,starts,ends};
}
function distinctSources(sources:readonly EvidenceSource[]){
  const seen=new Set<string>();return sources.filter(source=>{if(!source.text||seen.has(source.text))return false;seen.add(source.text);return true;});
}

/** Formatting matches are mapped back to a real contiguous source slice.
 * Neither model wording nor normalized text is persisted as the citation. */
export function createReviewEvidenceMatcher(sources:readonly EvidenceSource[]){
  const originals=distinctSources(sources);
  let indexes:{source:EvidenceSource;index:IndexedText}[]|undefined;
  return (quote:string):EvidenceMatch=>{
    const trimmed=quote.trim(),unquoted=unwrap(quote);
    for(const literal of [trimmed,unquoted])if(literal&&originals.some(source=>source.text.includes(literal)))return {matched:true,text:literal};
    const needle=indexText(unquoted).text;if(!needle)return {matched:false,reason:'quote_not_found'};
    indexes??=originals.map(source=>({source,index:indexText(source.text)}));
    const matches=new Set<string>();
    for(const {source,index} of indexes){
      let offset=0;
      while(offset<=index.text.length-needle.length){
        const found=index.text.indexOf(needle,offset);if(found<0)break;
        const last=found+needle.length-1;
        const startsInside=found>0&&index.starts[found]===index.starts[found-1];
        const endsInside=last+1<index.text.length&&index.ends[last]===index.ends[last+1];
        // Reject partial matches inside a normalized grapheme without
        // re-segmenting every repeated occurrence in a long article.
        if(!startsInside&&!endsInside)matches.add(source.text.slice(index.starts[found],index.ends[last]));
        if(matches.size>1)return {matched:false,reason:'ambiguous_match'};
        offset=found+1;
      }
    }
    return matches.size?{matched:true,text:matches.values().next().value!}:{matched:false,reason:'quote_not_found'};
  };
}
export function matchReviewEvidence(quote:string,sources:readonly EvidenceSource[]):EvidenceMatch{return createReviewEvidenceMatcher(sources)(quote);}

const sliceSafe=(value:string,max:number)=>{const part=value.slice(0,max);return /[\uD800-\uDBFF]$/.test(part)?part.slice(0,-1):part;};
const excerpt=(value:string,max:number)=>sliceSafe(redactFailureText(value,max+200)||'',max);
function closestSource(quote:string,sources:readonly EvidenceSource[]):ReviewEvidenceFailure['closestSource'] {
  const needle=indexText(unwrap(quote)).text;
  if(!needle)return null;
  let best:{source:EvidenceSource;sanitized:string;position:number;score:number}|undefined;
  for(const source of distinctSources(sources)){
    // Redact the complete field before choosing a window. Cutting a long
    // credential first could remove its recognizable prefix but leak its tail.
    const sanitized=redactFailureText(source.text,Number.MAX_SAFE_INTEGER)||'';
    const index=indexText(sanitized);
    for(const size of [32,16,8,4,2]){
      if(needle.length<size)continue;
      const step=Math.max(1,Math.floor((needle.length-size)/20));
      let anchor=-1,matched=0;
      for(let offset=0;offset<=needle.length-size;offset+=step){
        const position=index.text.indexOf(needle.slice(offset,offset+size));
        if(position>=0){matched++;if(anchor<0)anchor=position;}
      }
      if(anchor>=0){
        const score=size*100+matched;
        if(!best||score>best.score)best={source,sanitized,position:index.starts[anchor],score};
        break;
      }
    }
  }
  if(!best)return null;
  let start=Math.max(0,best.position-160);
  if(start>0&&/[\uDC00-\uDFFF]/.test(best.sanitized[start]))start--;
  const end=Math.min(best.sanitized.length,start+850);
  const window=best.sanitized.slice(start,end);
  return {label:excerpt(best.source.label,80)||'原文',excerpt:excerpt(window,900),length:best.source.text.length,truncated:start>0||end<best.sanitized.length};
}

/** Capture one rejected quotation and one bounded comparison excerpt, never
 * whole model responses, unrelated sources or student answers. */
export function evidenceFailureDetail(input:{pointId:string;reason:ReviewEvidenceFailure['reason'];quote:string;citationIndex:number|null;citationCount:number;sources:readonly EvidenceSource[];contextOnly?:readonly ContextOnlySource[]}){
  const contextOnlyMatch=input.quote?input.contextOnly?.find(source=>matchReviewEvidence(input.quote,[{label:'context',text:source.text}]).matched)?.kind||null:null;
  const detail:ReviewEvidenceFailure={version:1,reason:input.reason,pointId:input.pointId,citationIndex:input.citationIndex,citationCount:input.citationCount,
    quoteExcerpt:excerpt(input.quote,700),quoteLength:input.quote.length,quoteTruncated:input.quote.length>700,
    closestSource:input.quote?closestSource(input.quote,input.sources):null,sourceCount:input.sources.filter(source=>!!source.text).length,contextOnlyMatch};
  return reviewEvidenceFailurePrefix+JSON.stringify(reviewEvidenceFailureSchema.parse(detail));
}
