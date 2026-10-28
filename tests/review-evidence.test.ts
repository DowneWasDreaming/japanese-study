import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openDatabase} from '../server/db.js';
import {FailureDiagnostics} from '../server/diagnostics.js';
import {ReviewService,validateReviewBackup} from '../server/review.js';
import {matchReviewEvidence,evidenceFailureDetail} from '../server/review-evidence.js';
import {reviewEvidenceFailureFromDetail} from '../server/review-evidence-diagnostics.js';

const sources=(...texts:string[])=>texts.map((text,index)=>({label:`原文 ${index+1}`,text}));
const plain={title:'～ておく',kind:'grammar' as const,reading:'ておく',meaning:'为之后的事情事先准备。',focus:'根据原句复习事前准备。',note:''};
const reply=(evidence:string[],outcome:'verified'|'corrected'|'uncertain'='verified')=>({...plain,usageKey:'事前準備',assessment:{outcome,reason:'模拟老师根据原文核查。',evidence,originalUnderstanding:''}});
function setup(t:TestContext,generate:(input:any)=>unknown){
  const db=openDatabase(':memory:');let calls=0;const diagnostics=new FailureDiagnostics(db);
  const service=new ReviewService(db,{async generate(messages){calls++;return JSON.stringify(generate(JSON.parse(messages[1].content)));}},{diagnostics,now:()=>new Date('2026-10-28T12:00:00.000Z')});
  const add=(text:string)=>service.add({text,scope:'context',level:'N4'}).item;
  const snapshot=()=>({review_points:db.prepare('SELECT * FROM review_points').all(),review_sources:db.prepare('SELECT * FROM review_sources').all(),review_events:db.prepare('SELECT * FROM review_events').all()});
  t.after(()=>db.close());return {db,service,diagnostics,add,snapshot,calls:()=>calls};
}

test('balanced quote wrappers and outer whitespace do not change the original citation',()=>{
  const original='旅行の前に予約します。';
  for(const [left,right] of [['「','」'],['『','』'],['“','”'],['‘','’'],['"','"'],["'","'"],['＂','＂'],['«','»']])assert.deepEqual(matchReviewEvidence(` \n${left}${original}${right}\t`,sources(original)),{matched:true,text:original});
  assert.equal(matchReviewEvidence('「旅行の前に予約します。』',sources(original)).matched,false,'mismatched wrappers must not be silently stripped');
  assert.deepEqual(matchReviewEvidence('「旅行の前に予約します。」',sources('本文は「旅行の前に予約します。」です。')),{matched:true,text:'「旅行の前に予約します。」'},'exact quoted source remains exact');
});

test('width, line endings and Japanese layout whitespace map to an exact raw contiguous slice',()=>{
  const original='料金：１２００円、受付（Ａ）です。\r\n先に 予約しておきます。';
  const quote='料金:1200円、受付(A)です。先に予約しておきます。';
  assert.deepEqual(matchReviewEvidence(quote,sources(original)),{matched:true,text:original});
  assert.deepEqual(matchReviewEvidence('first line\nsecond line',sources('first line\r\nsecond line')),{matched:true,text:'first line\r\nsecond line'});
});

test('NFC equivalence retains original combining sequences and UTF-16 source text',()=>{
  const original='🗾 カ\u3099ラスを見ました。';
  assert.deepEqual(matchReviewEvidence('ガラスを見ました。',sources(original)),{matched:true,text:'カ\u3099ラスを見ました。'});
  assert.equal(matchReviewEvidence('👩',sources('👩‍👩‍👦')).matched,true,'literal substrings keep the existing exact-match rule');
  assert.equal(matchReviewEvidence('ガラス',sources('ｶﾞﾗｽ')).matched,false,'half-width kana is intentionally not broad NFKC equivalence');
});

test('ASCII word and numeric whitespace boundaries cannot be joined',()=>{
  assert.deepEqual(matchReviewEvidence('can not 12 34',sources('can\r\nnot\t12  34')),{matched:true,text:'can\r\nnot\t12  34'});
  assert.equal(matchReviewEvidence('cannot',sources('can not')).matched,false);
  assert.equal(matchReviewEvidence('1234',sources('12 34')).matched,false);
  assert.equal(matchReviewEvidence('12',sources('1\n2')).matched,false);
});

test('non-exact matches cannot choose between different original typography',()=>{
  assert.deepEqual(matchReviewEvidence('日　 本',sources('日 本','日\t本')),{matched:false,reason:'ambiguous_match'});
  assert.deepEqual(matchReviewEvidence('日 本',sources('日 本','日\t本')),{matched:true,text:'日 本'},'exact source text resolves its own form');
  assert.deepEqual(matchReviewEvidence('日　 本',sources('日 本','日 本')),{matched:true,text:'日 本'},'duplicate copies of identical raw text are not ambiguity');
});

test('particles, blanks, inflection, negation, numbers, small kana and punctuation are not format differences',()=>{
  const cases=[
    ['床にジュースがこぼれました。','床にジュースをこぼしました。'],
    ['洗濯物を干しました。','洗濯物を干す。'],
    ['ベランダ（　）洗濯物を干しました。','ベランダに洗濯物を干しました。'],
    ['行きます。','行きません。'],['１２００円です。','1300円です。'],
    ['きゃくです。','きやくです。'],['①です。','1です。'],['ABC','abc'],
    ['旅行の前に予約しておきます。','旅行の前に…おきます。'],['これは、日本です。','これは日本です。'],
  ];
  for(const [original,quote] of cases)assert.equal(matchReviewEvidence(quote,sources(original)).matched,false,quote);
  assert.equal(matchReviewEvidence('旅行の前に予約します。',sources('旅行の前に','予約します。')).matched,false,'separate fields cannot be joined');
});

test('failed-citation details are bounded, redacted and label comparison text as a source excerpt',()=>{
  const token=['sk','synthetic','fixture','12345678901234567890'].join('-');
  const quote='Bearer '+token+' '+'引用'.repeat(600);
  const detail=evidenceFailureDetail({pointId:'point-fixture',reason:'quote_not_found',quote,citationIndex:2,citationCount:3,sources:sources('保留的原文，与错误引文不同。')});
  assert.ok(!detail.includes(token));assert.ok(detail.length<6000);
  const parsed=reviewEvidenceFailureFromDetail(detail)!;assert.equal(parsed.citationIndex,2);assert.equal(parsed.citationCount,3);assert.equal(parsed.quoteLength,quote.length);assert.equal(parsed.quoteTruncated,true);assert.ok(parsed.quoteExcerpt.length<=1000);
});

test('comparison windows redact a full long credential before locating and cutting the source excerpt',()=>{
  const marker='LEAKTAILMARKER',token=['sk','HEADER'+'X'.repeat(900)+marker].join('-');
  const original='Bearer '+token+'\n旅行の前にホテルを予約しておきます。';
  const quote='旅行の前にホテルを予約します。';
  const detail=evidenceFailureDetail({pointId:'point-long-redaction',reason:'quote_not_found',quote,citationIndex:1,citationCount:1,sources:sources(original)});
  const parsed=reviewEvidenceFailureFromDetail(detail)!;
  assert.ok(parsed.closestSource);assert.equal(parsed.closestSource.length,original.length);
  assert.ok(parsed.closestSource.excerpt.includes('旅行の前にホテルを予約しておきます。'));
  assert.ok(parsed.closestSource.excerpt.includes('[已隐藏]'));
  for(const secret of [token,marker,'X'.repeat(20)])assert.ok(!detail.includes(secret),'must redact both credential prefix and tail before slicing');
});

test('one normalization saves canonical raw evidence, leaves source anchors untouched and passes backup validation',async t=>{
  const original='料金：１２００円です。\r\n先に 予約しておきます。';
  const {service,add,snapshot,calls}=setup(t,()=>reply(['  「料金:1200円です。先に予約しておきます。」 \n']));
  const draft=add(original),before=snapshot().review_sources;const result=await service.normalize(draft.id);
  assert.equal(result.item.status,'active');assert.deepEqual(result.item.verification?.evidence,[original]);assert.deepEqual(snapshot().review_sources,before);assert.equal(calls(),1);assert.doesNotThrow(()=>validateReviewBackup(snapshot()));
  await service.audit(result.item.id);assert.equal(calls(),1,'cached lookup does not request or repair a second time');
  const tampered=structuredClone(snapshot());const report=JSON.parse(String(tampered.review_points[0].verification_json));report.evidence=['料金:1200円です。先に予約しておきます。'];tampered.review_points[0].verification_json=JSON.stringify(report);assert.throws(()=>validateReviewBackup(tampered),'stored backup evidence must still be literal raw text');
});

test('a changed model quote preserves an existing card and progress and records the failed quote and comparison source',async t=>{
  const original='天気がいいので、ベランダ（　）洗濯物を干しました。';
  const quote='天気がいいので、ベランダに洗濯物を干しました。';
  const {service,add,snapshot,diagnostics,calls}=setup(t,()=>reply(['洗濯物を干しました。',quote]));
  const draft=add(original);service.confirm(draft.id,plain);service.rate(draft.id,{rating:'mastered',requestId:randomUUID()});const before=snapshot();
  const result=await service.audit(draft.id);assert.equal(result.item.normalizationStatus,'failed');assert.equal(result.item.stage,7);assert.equal(calls(),1);assert.deepEqual(snapshot().review_events,before.review_events);
  for(const key of ['title','meaning','focus','stage','due_at','verification_json'])assert.equal(snapshot().review_points[0][key],before.review_points[0][key]);
  const failure=diagnostics.list({operation:'review'}).items[0];assert.equal(failure.category,'validation');const detail=reviewEvidenceFailureFromDetail(failure.detail)!;
  assert.equal(detail.reason,'quote_not_found');assert.equal(detail.citationIndex,2);assert.equal(detail.citationCount,2);assert.equal(detail.quoteExcerpt,quote);assert.ok(detail.closestSource?.excerpt.includes('ベランダ（　）'));
});

test('uncertain replies still cannot attach fabricated quotations',async t=>{
  const {service,add,diagnostics}=setup(t,()=>reply(['この原文は存在しません。'],'uncertain'));const draft=add('ように');const result=await service.normalize(draft.id);
  assert.equal(result.item.status,'draft');assert.equal(result.item.verification,null);assert.equal(result.item.normalizationStatus,'failed');assert.equal(reviewEvidenceFailureFromDetail(diagnostics.list().items[0].detail)?.reason,'quote_not_found');
});

test('missing citations produce a distinct diagnostic without fabricated comparison text',async t=>{
  const {service,add,diagnostics}=setup(t,()=>reply([]));const draft=add('予約しておきます。');await service.normalize(draft.id);
  const detail=reviewEvidenceFailureFromDetail(diagnostics.list().items[0].detail)!;assert.equal(detail.reason,'missing_evidence');assert.equal(detail.citationIndex,null);assert.equal(detail.citationCount,0);assert.equal(detail.quoteExcerpt,'');assert.equal(detail.closestSource,null);
});

test('explanation-only quotations are identified but never accepted as original evidence',async t=>{
  const explanation='これは原文ではなく教師が追加した説明です。';
  const {db,service,diagnostics}=setup(t,()=>reply([explanation]));
  const q={id:'q-evidence',type:'fill',level:'N4',category:'grammar',prompt:'原文：ホテルを予約しておきます。',answer:'予約',acceptedAnswers:['予約'],explanation,knowledgePoints:['予約'],points:10,rubric:'原文に合う答え。'};
  db.prepare('INSERT INTO exams(id,title,level,category,mode,source,status,created_at,submitted_at,questions_json,config_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('exam-evidence','引用验收','N4','grammar','practice','builtin','completed','2026-10-28T01:00:00.000Z','2026-10-28T01:01:00.000Z',JSON.stringify([q]),JSON.stringify({level:'N4',count:1,types:['fill'],source:'builtin'}));
  const start=q.prompt.indexOf('予約'),draft=service.add({examId:'exam-evidence',questionId:q.id,source:'prompt',start,end:start+2,text:'予約',scope:'context'}).item;
  const result=await service.normalize(draft.id);assert.equal(result.item.normalizationStatus,'failed');assert.equal(reviewEvidenceFailureFromDetail(diagnostics.list().items[0].detail)?.contextOnlyMatch,'explanation');
});

test('editable notes alone cannot become evidence that disappears after model normalization',async t=>{
  const note='これは既存メモだけにある独立の説明です。';const {service,add,diagnostics}=setup(t,()=>reply([note]));const draft=add('予約しておきます。');service.confirm(draft.id,{...plain,note});
  const result=await service.audit(draft.id);assert.equal(result.item.normalizationStatus,'failed');assert.equal(result.item.note,note);assert.equal(reviewEvidenceFailureFromDetail(diagnostics.list().items[0].detail)?.contextOnlyMatch,'existing_knowledge');
});

test('multiple possible raw sources stop with ambiguity while preserving each original source',async t=>{
  const {service,add,snapshot,diagnostics}=setup(t,()=>reply(['ホテルを　予約しておきます。']));const draft=add('ホテルを 予約しておきます。');service.clarify(draft.id,{text:'ホテルを\t予約しておきます。'});const before=snapshot().review_sources;
  const result=await service.normalize(draft.id);assert.equal(result.item.status,'draft');assert.equal(result.item.normalizationStatus,'failed');assert.equal(reviewEvidenceFailureFromDetail(diagnostics.list().items[0].detail)?.reason,'ambiguous_match');assert.deepEqual(snapshot().review_sources,before);
});
