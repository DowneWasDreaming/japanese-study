import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { contextBudgets,selectContextHistory,selectFocusKnowledge,type ContextMessage } from '../server/context-budget.js';
import { openDatabase } from '../server/db.js';
import { seedDatabase,type Question } from '../server/seed.js';
import { LearningService,type AIProvider } from '../server/learning.js';

const pair=(user:string,assistant:string):ContextMessage[]=>[{role:'user',content:user},{role:'assistant',content:assistant}];
const stamp='2026-10-20T00:00:00.000Z';
function setup(t:TestContext,ai:AIProvider){
  const db=openDatabase(':memory:');seedDatabase(db);const service=new LearningService(db,ai);
  t.after(()=>db.close());return {db,service};
}
const generated=(prompt:string)=>({type:'fill',prompt,answer:'は',acceptedAnswers:['は'],explanation:'主題を示します。',knowledgePoints:['助词'],points:10,rubric:'助词正确10分。'});

test('context budgeting preserves complete normal exchanges and measures escaped serialized characters',()=>{
  const normal=[...pair('学校へ行きます。','「へ」表示方向。'),...pair('这里可用「に」吗？','也可以。')];
  const original=structuredClone(normal);
  assert.deepEqual(selectContextHistory(normal,{maxPairs:10,preserveFirstUser:true}),normal);
  const large=Array.from({length:12},(_,index)=>pair(`问题${index}`,'\\\n'.repeat(1600))).flat();
  const history=selectContextHistory(large,{maxPairs:10,preserveFirstUser:true});
  assert.ok(JSON.stringify(history).length<=contextBudgets.historyCharacters);
  assert.equal(history[0].content,'问题0');assert.deepEqual(history.slice(-2),large.slice(-2));
  assert.equal((history.length-1)%2,0,'omitted original answer leaves only its intact language anchor');
  assert.deepEqual(normal,original,'selection must not mutate stored input');
});

test('oversized essential context is retained whole instead of clipping Japanese or losing the latest answer',()=>{
  const original='まだ学校へ行っていません。'.repeat(100);
  const latestAnswer='「きって」と「きつて」は異なります。'.repeat(2500);
  const history=selectContextHistory([...pair(original,'最初の説明。'),...pair('直前の質問。',latestAnswer)],{maxPairs:10,preserveFirstUser:true});
  assert.deepEqual(history,[{role:'user',content:original},...pair('直前の質問。',latestAnswer)]);
  assert.ok(JSON.stringify(history).length>contextBudgets.historyCharacters,'budget is soft only for mandatory unmodified context');
});

test('history contains only complete exchanges within the recent-pair limit and keeps the source anchor',()=>{
  const source=Array.from({length:15},(_,index)=>pair(`原句${index}`,'説明')).flat();
  const history=selectContextHistory(source,{maxPairs:10,preserveFirstUser:true});
  assert.equal(history.length,21);assert.equal(history[0].content,'原句0');assert.equal(history[1].content,'原句5');
  const orphaned=[{role:'assistant' as const,content:'orphan'},...pair('日本語','中文'),{role:'user' as const,content:'not yet answered'}];
  assert.deepEqual(selectContextHistory(orphaned,{maxPairs:8}),pair('日本語','中文'));
});

test('focus selection leaves ordinary lists intact and rotates bounded full points with eventual fair coverage',()=>{
  const small=['学校','きって','カーテン'];assert.deepEqual(selectFocusKnowledge(small,5,100),small);
  const points=Array.from({length:100},(_,index)=>`知识点${index}`);const original=[...points];
  const first=selectFocusKnowledge(points,5,0);const second=selectFocusKnowledge(points,5,1);
  assert.equal(first.length,12);assert.equal(second.length,12);assert.notDeepEqual(first,second);
  const starts=new Set<string>();
  for(let index=0;index<points.length;index++){
    const selected=selectFocusKnowledge(points,5,index);starts.add(selected[0]);
    assert.ok(selected.length<=12);assert.ok(selected.every(point=>points.includes(point)));
    assert.ok(JSON.stringify(selected).length<=contextBudgets.focusCharacters);
  }
  assert.equal(starts.size,points.length,'every point eventually becomes first even with a budget-limited window');
  assert.deepEqual(points,original);assert.equal(selectFocusKnowledge(points,50,0).length,60);
});

test('focus selection counts JSON escaping, deduplicates and retains an oversized sole learning point verbatim',()=>{
  const points=Array.from({length:30},(_,index)=>`知识点${index}${'\\\n'.repeat(500)}`);
  const selected=selectFocusKnowledge(points,10,0);assert.ok(selected.length<12);assert.ok(selected.length>0);
  assert.ok(JSON.stringify(selected).length<=contextBudgets.focusCharacters);
  const long='かな・カナ・っ・ー'.repeat(1000);assert.deepEqual(selectFocusKnowledge([long,long],1,0),[long]);
  assert.deepEqual(selectFocusKnowledge([],1,0),[]);
});

test('literal explicit eligible focus is retained ahead of a rotating large list without changing its saved Japanese',()=>{
  const points=[...Array.from({length:79},(_,index)=>`単語${index}`),'か\u3099っこう'];
  const focus='请重点练习「がっこう」，以及「単語77」。';
  const first=selectFocusKnowledge(points,5,0,focus);const next=selectFocusKnowledge(points,5,1,focus);
  assert.equal(first.length,12);assert.ok(first.includes('か\u3099っこう'));assert.ok(first.includes('単語77'));
  assert.ok(next.includes('か\u3099っこう'));assert.ok(next.includes('単語77'));assert.notDeepEqual(first,next);
  assert.ok(first.every(point=>points.includes(point)));assert.ok(JSON.stringify(first).length<=contextBudgets.focusCharacters);
  assert.ok(!selectFocusKnowledge(points,5,0,'不存在于保存数据中的词').includes('不存在于保存数据中的词'));
});

test('sentence followup keeps the complete original language and latest pair while isolating and preserving stored history',async t=>{
  let request:Parameters<AIProvider['generate']>[0]=[];
  const {db,service}=setup(t,{async generate(messages){request=messages;return '新的讲解。';}});
  for(const id of ['main','other'])db.prepare('INSERT INTO conversations(id,title,kind,level,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,'标题仅保留80字','sentence','N5',stamp,stamp);
  const insert=db.prepare('INSERT INTO messages(conversation_id,role,content,created_at) VALUES(?,?,?,?)');
  const original='昨日、学校へ行かなかったのはどうしてですか。'.repeat(20);
  const messages=[...pair(original,'第一轮讲解。'),...Array.from({length:14},(_,index)=>pair(`旧追问${index}`,'中文解释。'.repeat(1300))).flat()];
  for(const message of messages)insert.run('main',message.role,message.content,stamp);
  insert.run('other','user','OTHER_CONVERSATION_PRIVATE',stamp);insert.run('other','assistant','别的主题',stamp);
  const before=db.prepare('SELECT * FROM messages ORDER BY id').all();
  const current='如果把「行かなかった」换成「行けなかった」呢？';
  await service.followup('main',current);
  assert.equal(request[1].content,original);assert.deepEqual(request.slice(-3),[...messages.slice(-2),{role:'user',content:current}]);
  assert.ok(JSON.stringify(request.slice(1,-1)).length<=contextBudgets.historyCharacters);
  assert.ok(!JSON.stringify(request).includes('OTHER_CONVERSATION_PRIVATE'));
  assert.match(request[0].content,/不要猜测未提供的历史/);
  assert.deepEqual(db.prepare('SELECT * FROM messages ORDER BY id LIMIT ?').all(before.length),before);
  assert.equal(service.conversation('main').messages.length,messages.length+2);
});

test('targeted AI papers rotate a bounded same-level selection while preserving all saved words and full-history deduplication',async t=>{
  const requests:any[]=[];let calls=0;
  const {db,service}=setup(t,{async generate(messages){requests.push(JSON.parse(messages[1].content));calls++;return JSON.stringify({questions:[generated(`第${calls}套、（　）を選んでください。`)]});}});
  const content=db.prepare('INSERT INTO content(id,kind,level,title,summary,body_json,examples_json,knowledge_points_json) VALUES(?,?,?,?,?,?,?,?)');
  const saved=db.prepare('INSERT INTO saved(content_id,type,created_at) VALUES(?,?,?)');
  const words=Array.from({length:80},(_,index)=>`追加単語${index}`);
  for(const [index,word]of words.entries()){content.run(`budget-word-${index}`,'word','N5',word,'用于测试','{}','[]',JSON.stringify([word]));saved.run(`budget-word-${index}`,'word',stamp);}
  content.run('other-level-word','word','N4','OTHER_LEVEL_WORD','其他等级','{}','[]','[]');saved.run('other-level-word','word',stamp);
  const before=db.prepare('SELECT * FROM saved ORDER BY content_id').all();
  const config={source:'ai' as const,basis:'words' as const,level:'N5' as const,count:1,types:['fill' as const],mode:'practice' as const};
  await service.createExam(config);await service.createExam(config);
  assert.equal(calls,2);assert.equal(requests[0].relatedKnowledge.length,12);assert.equal(requests[1].relatedKnowledge.length,12);
  assert.notDeepEqual(requests[0].relatedKnowledge,requests[1].relatedKnowledge);
  assert.ok(requests.every(request=>request.relatedKnowledge.every((point:string)=>words.includes(point))));
  assert.ok(requests[1].recentQuestions.some((question:any)=>question.prompt==='第1套、（　）を選んでください。'));
  await service.createExam({...config,focus:'我想重点练习「追加単語79」。'});
  assert.ok(requests[2].relatedKnowledge.includes('追加単語79'));assert.equal(requests[2].focus,'我想重点练习「追加単語79」。');
  assert.deepEqual(db.prepare('SELECT * FROM saved ORDER BY content_id').all(),before);
});

test('exam followup keeps a large latest complete exchange and unchanged saved question, answer and rubric',async t=>{
  let request:Parameters<AIProvider['generate']>[0]=[];
  const {db,service}=setup(t,{async generate(messages){request=messages;return '针对追问的回答。';}});
  const {id}=await service.createExam({source:'builtin',level:'N5',count:1,types:['reading'],mode:'practice'});
  const question=JSON.parse(String(db.prepare('SELECT questions_json FROM exams WHERE id=?').get(id)!.questions_json))[0] as Question;
  service.saveAnswers(id,{[question.id]:question.answer});await service.submit(id);
  const oldAnswer='这是上一轮的完整日语解析。'.repeat(2200);
  const turnInsert=db.prepare('INSERT INTO exam_qa_turns(id,exam_id,question_id,user_text,assistant_text,status,error,client_request_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
  turnInsert.run('older',id,question.id,'旧问题','旧说明','completed',null,randomUUID(),stamp,stamp);
  turnInsert.run('latest',id,question.id,'请解释这句话。',oldAnswer,'completed',null,randomUUID(),stamp,stamp);
  const before=db.prepare('SELECT * FROM exam_qa_turns ORDER BY rowid').all();const grades=db.prepare('SELECT * FROM grades').all();
  const current='能具体讲一下刚才说的「ために」吗？';
  await service.discussions.ask(id,{questionId:question.id,text:current,clientRequestId:randomUUID()});
  const payload=JSON.parse(request[1].content);
  assert.deepEqual(payload.history,pair('请解释这句话。',oldAnswer));assert.deepEqual(payload.question,question);
  assert.equal(payload.learnerAnswer,question.answer);assert.equal(payload.currentQuestion,current);assert.equal(payload.question.rubric,question.rubric);
  assert.match(request[0].content,/不要猜测未提供的历史/);
  assert.deepEqual(db.prepare('SELECT * FROM exam_qa_turns ORDER BY rowid LIMIT 2').all(),before);
  assert.deepEqual(db.prepare('SELECT * FROM grades').all(),grades);
});
