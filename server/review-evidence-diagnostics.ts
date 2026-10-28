import { z } from 'zod';

export const reviewEvidenceFailurePrefix='review_evidence_v1: ';
const length=z.number().int().min(0).max(30_000);
export const reviewEvidenceFailureSchema=z.object({
  version:z.literal(1),
  reason:z.enum(['quote_not_found','missing_evidence','ambiguous_match']),
  pointId:z.string().min(1).max(200),
  citationIndex:z.number().int().min(1).max(8).nullable(),
  citationCount:z.number().int().min(0).max(8),
  quoteExcerpt:z.string().max(1000),quoteLength:length,quoteTruncated:z.boolean(),
  closestSource:z.object({label:z.string().min(1).max(80),excerpt:z.string().max(1000),length,truncated:z.boolean()}).strict().nullable(),
  sourceCount:z.number().int().min(0).max(100),
  contextOnlyMatch:z.enum(['explanation','existing_knowledge','existing_usages']).nullable().optional(),
}).strict().superRefine((value,ctx)=>{
  if(value.reason==='missing_evidence'&&(value.citationIndex!==null||value.citationCount!==0||value.quoteLength!==0||value.quoteExcerpt!==''))ctx.addIssue({code:'custom',message:'缺失引文的诊断计数不一致。'});
  if(value.reason!=='missing_evidence'&&(value.citationIndex===null||value.citationIndex>value.citationCount||value.quoteLength===0))ctx.addIssue({code:'custom',message:'引文位置与计数不一致。'});
});
export type ReviewEvidenceFailure=z.infer<typeof reviewEvidenceFailureSchema>;

/** The envelope contains excerpts only, never arbitrary response objects. */
export function reviewEvidenceFailureFromDetail(detail:string|null|undefined):ReviewEvidenceFailure|null {
  const line=detail?.split('\n').find(value=>value.startsWith(reviewEvidenceFailurePrefix));
  if(!line||line.length>6000)return null;
  try{const result=reviewEvidenceFailureSchema.safeParse(JSON.parse(line.slice(reviewEvidenceFailurePrefix.length)));return result.success?result.data:null;}catch{return null;}
}
