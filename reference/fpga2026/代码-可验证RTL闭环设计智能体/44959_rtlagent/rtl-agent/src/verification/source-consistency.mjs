import {invariant} from '../dual/snapshot.mjs';
const check=(ok,m)=>invariant(ok,'TEST_PLAN_INVALID',m);
const esc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const words={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,sixteen:16,thirtytwo:32};
export function shiftEvidence(p,spec,outputWidth){
 const text=spec.replace(/\s+/g,' '),receipts=[];
 const depth=/\b(?:shift register with|chain of)\s+(\d+|one|two|three|four|five|six|seven|eight|sixteen)\s+(?:D\s*(?:flops|flip-flops)|stages|bits)\b/i.exec(text);
 if(depth){const n=Number(depth[1])||words[depth[1].toLowerCase()];check((p.storage?.bits??p.read?.storage_bits??outputWidth)===n,'Source storage depth differs from output width; supply independently sourced storage bits and tap');receipts.push({kind:'depth',quote:depth[0],bits:n});}
 if(p.storage){
  check(p.out!==null&&!p.read,'A fixed storage tap needs an output, not an addressed read');
  check(p.storage.tap+outputWidth<=p.storage.bits,'Tap slice exceeds storage depth');
  check(typeof p.storage.quote==='string'&&text.includes(p.storage.quote.replace(/\s+/g,' ')),'Storage depth/tap must quote original text');
  const quote=p.storage.quote.replace(/\s+/g,' '),numbers=quote.match(/\b\d+\b|\b(?:one|two|three|four|five|six|seven|eight|sixteen)\b/gi)??[];
  check(numbers.some(x=>(Number(x)||words[x.toLowerCase()])===p.storage.bits),'Storage depth must be explicit in its quote');
  const slice=outputWidth===1?String(p.storage.tap):String(p.storage.tap+outputWidth-1)+'\\s*:\\s*'+p.storage.tap;
  check(new RegExp('\\[\\s*'+slice+'\\s*\\]').test(quote)||p.storage.tap+outputWidth===p.storage.bits&&/last|final|end of|oldest/i.test(quote),'Tap position needs explicit index or last-stage wording');
 }
 if(!p.serial)return receipts;
 // Explicit endpoints override temporal word order. Neither a port width nor
 // the visual arrow direction supplies insertion semantics.
 const insertion=new RegExp('\\b'+esc(p.serial)+'\\b[^.;]{0,60}?(?:feeds(?: the input of)?|insert(?:ed|s)?(?: (?:at|into))?|enters)\\s+(?:the\\s+)?(?:[A-Za-z_]\\w*\\s*\\[\\s*(\\d+)\\s*\\]|(LSB|MSB|least.significant bit|most.significant bit))','i').exec(text);
 let direction;
 if(insertion){const bits=p.storage?.bits??p.read?.storage_bits??outputWidth,index=insertion[1]===undefined?(/^(?:LSB|least)/i.test(insertion[2])?0:bits-1):Number(insertion[1]);
  check(index===0||index===bits-1,'Serial insertion must specify an endpoint');direction=index===0?'left':'right';receipts.push({kind:'insertion',quote:insertion[0],index,direction});
 }else if(/most.significant.bit first|MSB.first/i.test(text)){direction='left';receipts.push({kind:'word_order',direction});}
 else if(/least.significant.bit first|LSB.first/i.test(text)){direction='right';receipts.push({kind:'word_order',direction});}
 else {const physical=/\bshift(?:s|ed|ing)?\s+(left|right)\b/i.exec(text)??/\b(left|right)[ -]shift(?:er|ed|ing)?\b/i.exec(text);if(physical)direction=physical[1].toLowerCase();}
 check(direction,'Serial shift direction/insertion lacks explicit source evidence');
 check(p.modes.every(m=>m.direction===direction),'Source serial insertion/word order requires '+direction+' shift');return receipts;
}

// Deliberately small, exact linguistic contracts. Unknown prose is NOT called
// verified; this catches contradictions, not general natural-language meaning.
export function checkFsmEventScope({spec,states,initial,events,vectors,advance}){
 const text=spec.replace(/\s+/g,' '),receipts=[];
 check(!requiresMealy(spec),'Source requires current-input/Mealy output; use mealy_table or sequence_detector_v2, not Moore state outputs');
 check(!contradictoryOutputHold(spec),'Source gives contradictory clear/hold values until the same event; unavailable without a consistent output contract');
 // An exact N-cycle pulse contract can disprove a table without choosing an
 // unspecified overlap policy: a positive pulse must end in the named word.
 const pulse=/changes? from\s*([01](?:\s+to\s+[01]){1,7})\s*\(\s*(\d+)\s*cycles?\)/i.exec(text);
 const outputNames=Object.keys(states.get(initial).outputs);
 if(pulse&&events.length===1&&outputNames.length===1&&/end cycle[^.;]*pulse|end cycle of the ["']?pulse/i.test(text)){
  const word=pulse[1].replace(/[^01]/g,'');check(word.length===+pulse[2],'Explicit pulse word and cycle count contradict');
  const queue=[[initial,'']],visited=new Set();
  for(const [state,history] of queue)for(const vector of vectors){const h=(history+vector[events[0].name]).slice(-word.length),s=advance(state,vector),key=s+':'+h;
   check(!states.get(s).outputs[outputNames[0]]||h===word,'Moore table asserts a pulse without the complete source-defined N-cycle input word');
   if(!visited.has(key)){visited.add(key);queue.push([s,h]);}
  }
  receipts.push({kind:'exact_pulse_word',quote:pulse[0],pattern:word});
 }
 for(const event of events){
  const only=new RegExp('\\b'+esc(event.name)+'\\s+(?:input\\s+)?is\\s+(?:used|effective|relevant)\\s+only\\s+in\\s+state\\s+([A-Za-z_]\\w*)','i').exec(text);
  if(only){let named=states.has(only[1])?only[1]:null;
   if(!named&&new RegExp('reset state (?:called )?'+esc(only[1])+'\\b','i').test(text))named=initial;
   if(named){for(const s of states.keys())if(s!==named)for(const v of vectors)check(advance(s,v)===advance(s,{...v,[event.name]:1-v[event.name]}),'Source says '+event.name+' is used only in state '+only[1]+'; table depends on it elsewhere');receipts.push({event:event.name,only_state:named,quote:only[0]});}
  }
 }
 // Explicit output-gated acknowledge/reset contract. This is deliberately
 // narrower than inferring arbitrary prose state transitions.
 for(const out of Object.keys(states.get(initial).outputs))for(const event of events){
  const rule=new RegExp('assert\\s+(?:output\\s+)?'+esc(out)+'\\b[^.;]{0,180}?waits? until\\s+(?:input\\s+)?'+esc(event.name)+'\\s+is\\s+(?:1|high)\\s+before being reset','i').exec(text);
  if(!rule)continue;
  for(const [name,state] of states)if(state.outputs[out]===1)for(const v of vectors){
   const next=advance(name,v);
   check(v[event.name]===1?next===initial:states.get(next).outputs[out]===1,'Source wait/acknowledge contract for '+out+' contradicts event '+event.name);
  }
  receipts.push({kind:'wait_acknowledge',output:out,event:event.name,quote:rule[0]});
 }
 return receipts;
}

export function requiresMealy(spec){
 const text=spec.replace(/\b(?:not|non[- ]?|rather than)\s*Mealy\b/gi,'');
 return /\bMealy\b|outputs?[^.;\n]{0,70}(?:depends? on|determined by)[^.;\n]{0,70}current inputs?|outputs?[^.;\n]{0,70}immediately[^.;\n]{0,50}(?:match|input)|(?:match|input)[^.;\n]{0,70}immediately[^.;\n]{0,50}outputs?/i.test(text);
}
export function literalSequence(spec){
 return /(?:sequence|pattern)\s*(?:of\s*)?(?:["'`(]\s*)?([01]{2,8})(?![01])/i.exec(spec)?.[1]??/\binput(?:\s+\w+)?\s+is\s+([01]{2,8})(?![01])/i.exec(spec)?.[1]??null;
}
export function contradictoryOutputHold(spec){
 const text=spec.replace(/\s+/g,' '),clears=[...text.matchAll(/return(?:s)? to (?:0|zero|low) until ([^.;]+)/gi)];
 return clears.some(m=>new RegExp('(?:These|The) output signals[^.;]{0,100}(?:remain|stay|hold)(?:s)? (?:set )?(?:to |at )?(?:1|one|high) until '+esc(m[1]),'i').test(text));
}
export function adderNumberSystemAllowed(spec){
 const text=spec.replace(/\b(?:not|non[- ]?|without|rather than)\s*(?:sign(?:ed)?[- ]magnitude|BCD|floating[- ]point)\b/gi,'');
 const magnitudeAlgorithm=/absolute values?[^.;\n]{0,30}(?:add|sum)|(?:add|sum)[^.;\n]{0,30}absolute values?/i.test(text)&&
  /(?:MSB|sign bit) (?:of (?:the )?result|of (?:the )?sum)[^.;\n]{0,80}(?:set|match)|(?:set|match)[^.;\n]{0,40}(?:result|sum) sign bit/i.test(text);
 return !magnitudeAlgorithm&&!/sign(?:ed)?[- ](?:and[- ]?)?magnitude|\bBCD\b|binary[- ]coded decimal|floating[- ]point|IEEE[- ]?754|one['’]?s complement/i.test(text);
}
// comb_expr also covers subtraction. Keep D's adder contract unchanged: the
// additional evidence here requires magnitude arithmetic AND a separately
// chosen result sign; fixed-point wording alone does not imply sign-magnitude.
export function combNumberSystemAllowed(spec){
 const magnitudeArithmetic=/absolute values?[^.;\n]{0,60}(?:add|sum|subtract)|(?:add|sum|subtract)[^.;\n]{0,60}absolute values?/i.test(spec);
 const separateSign=/(?:result|difference)[^.;\n]{0,100}(?:positive|negative) sign|(?:result|difference)['’]?s? sign[^.;\n]{0,100}(?:relative|magnitude)|sign of (?:the )?(?:result|difference)[^.;\n]{0,100}same as (?:the )?inputs/i.test(spec);
 return adderNumberSystemAllowed(spec)&&!(magnitudeArithmetic&&separateSign);
}
// The method compiler's generated plan marker carries the method through the
// shared plan boundary, avoiding changes to E's combinational interpreter or
// the non-FSM portions of methods.mjs. Hand-authored scenarios are not inferred
// to be adders merely because they contain arithmetic words.
export function checkDeclaredPlanSemantics(raw,spec){
 if(raw.scenarios?.some(s=>s.description==='Harness-generated adder checks'))check(adderNumberSystemAllowed(spec),'adder supports binary unsigned/two-complement only; source specifies a different number representation');
 if(raw.scenarios?.some(s=>s.description==='CPU-evaluated combinational expression samples'))check(combNumberSystemAllowed(spec),'comb_expr supports binary unsigned/two-complement only; source specifies a different number representation');
}
