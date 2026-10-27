import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {openDatabase} from '../server/db.js';
import {seedDatabase,type Question} from '../server/seed.js';
import {LearningService,validateBackup,type AIProvider} from '../server/learning.js';
import {buildReadingPlan,passageCharacterCount,readGroupedModelPayload,validateReadingGroups,type ReadingPlan} from '../server/reading-groups.js';

const ordinary=(index:number)=>({type:'fill',prompt:`普通助詞 ${index}：学校（　）行きます。`,answer:'へ',acceptedAnswers:['へ'],explanation:'方向用「へ」。',knowledgePoints:['助词'],points:10,rubric:'填へ。'});
const subquestion=(index:number)=>({prompt:`第${index+1}問：本文の説明に合うものはどれですか。`,options:[{id:'A',text:'最初の説明に合う内容。'},{id:'B',text:'条件を取り違えた内容。'},{id:'C',text:'原因と結果が逆の内容。'},{id:'D',text:'本文に書かれていない内容。'}],answer:'A',acceptedAnswers:[],explanation:'原文の「説明」を根拠にAを選びます。Bは条件違い、Cは因果逆転、Dは記載なし。',knowledgePoints:['文章理解'],points:10,rubric:'Aのみ正解。'});
function payload(plan:ReadingPlan,serial=1){return {questions:Array.from({length:plan.ordinaryQuestionCount},(_,index)=>ordinary(index)),readingGroups:plan.groups.map((group,index)=>({title:`資料 ${serial}-${index}`,kind:group.kind,passage:`資料${serial}-${index}。\n`+'これは学校からのお知らせです。毎日、友達と一緒に日本語を勉強しています。'.repeat(Math.ceil(group.targetCharacters/36)),questions:Array.from({length:group.questionCount},(_,index)=>subquestion(index))}))};}
function setup(t:TestContext,reply?:(input:any,serial:number)=>unknown){
  const directory=mkdtempSync(join(tmpdir(),'japanese-reading-groups-')),db=openDatabase(':memory:');seedDatabase(db);const requests:any[]=[];
  const ai:AIProvider={async generate(messages){const input=JSON.parse(messages[1].content);requests.push(input);return JSON.stringify(reply?reply(input,requests.length):payload(input.readingPlan,requests.length));}};
  const service=new LearningService(db,ai,{backupDir:join(directory,'backups')});
  t.after(()=>{db.close();assert.ok(resolve(directory).startsWith(resolve(tmpdir())+sep));rmSync(directory,{recursive:true,force:true});});
  return {db,service,requests};
}
test('level plans prioritize a true mix while reserving each ordinary type and counting every subquestion',()=>{
  for(const level of ['N5','N4','N3','N2','N1'])for(const count of [1,3,5,10,40]){
    const plan=buildReadingPlan({level,count,types:['reading']});assert.equal(plan.readingQuestionCount,count);assert.equal(plan.ordinaryQuestionCount,0);assert.equal(plan.groups.reduce((sum,group)=>sum+group.questionCount,0),count);
    assert.ok(plan.groups.every(group=>group.questionCount>=1&&group.questionCount<=4&&group.minCharacters<=group.targetCharacters&&group.targetCharacters<=group.maxCharacters));
    if(['N5','N4'].includes(level))assert.ok(!plan.groups.some(group=>['long','integrated'].includes(group.kind)));
    if(count>=10){for(const kind of ['short','medium','information'])assert.ok(plan.groups.some(group=>group.kind===kind));if(['N3','N2','N1'].includes(level))assert.ok(plan.groups.some(group=>group.kind==='long'));if(['N2','N1'].includes(level))assert.ok(plan.groups.some(group=>group.kind==='integrated'));}
  }
  const n4=buildReadingPlan({level:'N4',count:10,types:['single','fill','reading']});assert.equal(n4.readingQuestionCount,5);assert.equal(n4.ordinaryQuestionCount,5);
  const n3=buildReadingPlan({level:'N3',count:10,types:['single','reading']});assert.equal(n3.readingQuestionCount,8);assert.equal(n3.ordinaryQuestionCount,2);
  assert.throws(()=>buildReadingPlan({level:'KANA',count:3,types:['reading']}),/N5/);
  assert.equal(buildReadingPlan({level:'N4',count:3,types:['fill']}).readingQuestionCount,0);
  assert.equal(buildReadingPlan({level:'N4',count:5,types:['reading','reading']}).readingQuestionCount,5);
});
test('grouped raw material validates exact plan, Japanese length and trusted server-owned fields',()=>{
  const plan=buildReadingPlan({level:'N4',count:5,types:['reading']}),valid=payload(plan);assert.doesNotThrow(()=>readGroupedModelPayload(valid,plan));
  const changes=[(p:any)=>p.readingGroups[1].passage='短い文です。',(p:any)=>p.readingGroups[0].kind='long',(p:any)=>p.readingGroups[1].questions.pop(),(p:any)=>p.readingGroups[0].questions[0].type='reading',(p:any)=>p.readingGroups[0].questions[0].passage='forged',(p:any)=>p.readingGroups[0].questions[0].id='forged',(p:any)=>p.readingGroups[0].passage='a'.repeat(100)];
  for(const change of changes){const invalid=structuredClone(valid);change(invalid);assert.throws(()=>readGroupedModelPayload(invalid,plan));}
  assert.equal(passageCharacterCount('あ\nい 😀'),3,'length is Unicode characters excluding whitespace, while source anchors keep exact UTF-16 text');
});
test('reading-only generation freezes one shared group identity, preserves options and hides every answer until its reveal time',async t=>{
  const {service,requests}=setup(t);const created=await service.createExam({level:'N4',count:5,types:['reading'],source:'ai',mode:'practice',readingMode:'grouped'});const exam=service.getExam(created.id);
  assert.equal(requests.length,1);assert.equal(requests[0].readingPlan.readingQuestionCount,5);assert.equal(exam.questions.length,5);
  const groups=new Map<string,any[]>();for(const q of exam.questions){assert.equal(q.answer,undefined);assert.equal(q.explanation,undefined);assert.equal(Array.isArray(q.options)?q.options.length:0,4);const id=(q.readingGroup as any).id;groups.set(id,[...(groups.get(id)||[]),q]);}
  assert.equal(groups.size,3);for(const siblings of groups.values()){assert.equal(new Set(siblings.map(q=>q.passage)).size,1);assert.equal(new Set(siblings.map(q=>q.readingGroup.title)).size,1);}
  const first=exam.questions[0];service.saveAnswers(created.id,{[String(first.id)]:'A'});await service.feedback(created.id,String(first.id));const feedback=service.getExam(created.id);assert.equal(feedback.questions[0].answer,'A');assert.equal(feedback.questions[1].answer,undefined);assert.equal(requests.length,1);
  service.saveAnswers(created.id,Object.fromEntries(feedback.questions.slice(1).map(q=>[String(q.id),'A'])));const result=await service.submit(created.id);assert.equal(result.score,50);assert.ok(result.questions.every(q=>q.answer==='A'));assert.equal(requests.length,1,'local objective grading does not invoke the model');
});
test('mismatched or incomplete groups receive only one repair and never save a partial paper',async t=>{
  const {db,service,requests}=setup(t,input=>{const value=payload(input.readingPlan);value.readingGroups[1].passage='短すぎます。';return value;});
  await assert.rejects(service.createExam({level:'N3',count:10,types:['reading'],source:'ai',readingMode:'grouped'}),(error:any)=>error.code==='INVALID_MODEL_OUTPUT');assert.equal(requests.length,2);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM exams').get()!.n,0);
});
test('group consistency and backup plans reject broken material, metadata and ordering before restoring any rows',async t=>{
  const {service,db}=setup(t);const created=await service.createExam({level:'N4',count:5,types:['reading'],source:'ai',readingMode:'grouped'});const backup=JSON.parse(readFileSync(service.createDeletionBackup(),'utf8'));assert.doesNotThrow(()=>validateBackup(backup));
  const examRow=backup.tables.exams[0];const questions=JSON.parse(examRow.questions_json) as Question[];assert.doesNotThrow(()=>validateReadingGroups(questions));
  const mutations=[(q:Question[])=>{q[2].passage+='改';},(q:Question[])=>{q[2].readingGroup!.title+='改';},(q:Question[])=>{q[2].readingGroup!.kind='long';},(q:Question[])=>{[q[2],q[3]]=[q[3],q[2]];},(q:Question[])=>{q[2].prompt=q[1].prompt;},(q:Question[])=>{q[1].options!.pop();}];
  for(const change of mutations){const invalid=structuredClone(backup),qs=JSON.parse(invalid.tables.exams[0].questions_json);change(qs);invalid.tables.exams[0].questions_json=JSON.stringify(qs);const before=db.prepare('SELECT total_changes() AS n').get()!.n;assert.throws(()=>service.restore(invalid));assert.equal(db.prepare('SELECT total_changes() AS n').get()!.n,before);}
  assert.equal(service.getExam(created.id).questions.length,5);
});
test('new groups cannot recycle a historical article merely by changing the question prompt',async t=>{
  const {db,service,requests}=setup(t,(input,serial)=>{const value=payload(input.readingPlan,1);if(serial>1)for(const group of value.readingGroups)for(const q of group.questions)q.prompt+='新しい問い';return value;});
  await service.createExam({level:'N4',count:5,types:['reading'],source:'ai',readingMode:'grouped'});
  await assert.rejects(service.createExam({level:'N4',count:5,types:['reading'],source:'ai',readingMode:'grouped'}),(error:any)=>error.code==='DUPLICATE_AI_QUESTION');assert.equal(requests.length,3);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM exams').get()!.n,1);
});
test('grouped configuration rejects unsupported offline and kana modes before contacting the model',async t=>{
  const {service,requests}=setup(t);
  for(const config of [{level:'KANA',source:'ai',types:['reading']},{level:'N4',source:'builtin',types:['reading']},{level:'N4',source:'ai',types:['fill']}])await assert.rejects(service.createExam({...config,count:5,readingMode:'grouped'} as any));
  assert.equal(requests.length,0);
});
