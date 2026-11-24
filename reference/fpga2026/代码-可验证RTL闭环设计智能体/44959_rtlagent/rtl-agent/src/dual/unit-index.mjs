import { invariant, sha256, sliceBytes, utf8 } from './snapshot.mjs';

export const INDEX_VERSION = 'bounded-verilog-units.v1';
const ID=/^[A-Za-z_][A-Za-z0-9_$]*$/;
const DECL=new Set(['wire','reg','logic','integer','localparam']);
const WORDS=new Set(['module','endmodule','input','output','inout','wire','reg','logic','integer','localparam','signed','unsigned','always','always_ff','always_comb','always_latch','assign','begin','end','if','else','case','casex','casez','endcase','default','posedge','negedge','or','function','endfunction','automatic']);
// Lexer preserves offsets into the original string. No normalization, preprocessor
// expansion, regex line windows, or source copied by a model is involved.
export function lex(source,{headerOnly=false}={}) {
  utf8(source); const tokens=[];
  for(let i=0;i<source.length;) {
    if(/\s/.test(source[i])) {i++;continue;}
    if(source.startsWith('//',i)) { const e=source.indexOf('\n',i);i=e<0?source.length:e;continue; }
    if(source.startsWith('/*',i)) {const e=source.indexOf('*/',i+2);invariant(e>=0,'DEPENDENCY_UNRESOLVED','Unclosed comment');i=e+2;continue;}
    invariant(!['`','\\','"','#','$'].includes(source[i]),'DEPENDENCY_UNRESOLVED','Macros, escaped IDs, strings, delays and system calls require full regeneration');
    const start=i;
    const word=/^[A-Za-z_][A-Za-z0-9_$]*/.exec(source.slice(i));
    const num=/^(?:(?:\d+)?'[sS]?[bBoOdDhH][0-9a-fA-FxXzZ?_]+|\d+|'[01xXzZ])/.exec(source.slice(i));
    if(word) i+=word[0].length;
    else if(num) i+=num[0].length;
    else {const op=/^(?:===|!==|>>>|<<<|<=|>=|==|!=|&&|\|\||<<|>>|\*\*|~\^|\^~)/.exec(source.slice(i));
      if(op)i+=op[0].length; else {invariant('()[]{};,:?@=+-*/%&|^~!<>.'.includes(source[i]),'DEPENDENCY_UNRESOLVED','Unsupported token');i++;}}
    tokens.push({value:source.slice(start,i),start,end:i});
    if(headerOnly&&tokens.at(-1).value===';')break;
  }
  return tokens;
}

// Separate ANSI interface contract: usable even if the body is unsupported or
// syntactically broken. Net/variable spelling may change; order, signedness,
// range orientation, names and directions cannot silently change.
export function portContract(source,topName) {
  try {
    if(topName){
      invariant(ID.test(topName)&&!source.includes('`'),'DEPENDENCY_UNRESOLVED');
      // Select the actual top header, not a preceding helper module. Mask
      // comments and strings before locating it; ambiguous definitions abstain.
      const view=source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"/g,s=>' '.repeat(s.length));
      const declarations=[...view.matchAll(/\bmodule\s+([A-Za-z_][A-Za-z0-9_$]*)\b/g)].filter(m=>m[1]===topName);
      invariant(declarations.length===1,'DEPENDENCY_UNRESOLVED');source=source.slice(declarations[0].index);
    }
    const t=lex(source,{headerOnly:true}).map(x=>x.value);let i=0;
    invariant(t[i++]==='module','DEPENDENCY_UNRESOLVED');const top=t[i++];
    invariant(ID.test(top)&&t[i++]==='(','DEPENDENCY_UNRESOLVED');
    const ports=[];let direction,signed=false,range=null;
    while(t[i]!==')') {
      if(['input','output','inout'].includes(t[i])){direction=t[i++];signed=false;range=null;}
      invariant(direction,'DEPENDENCY_UNRESOLVED');
      if(['wire','reg','logic'].includes(t[i]))i++;
      if(['signed','unsigned'].includes(t[i]))signed=t[i++]==='signed';
      if(t[i]==='['){i++;invariant(/^\d+$/.test(t[i])&&t[i+1]===':'&&/^\d+$/.test(t[i+2])&&t[i+3]===']','DEPENDENCY_UNRESOLVED');range=[t[i],t[i+2]];i+=4;if(range[0]==='0'&&range[1]==='0')range=null;}
      const name=t[i++];invariant(ID.test(name)&&!WORDS.has(name),'DEPENDENCY_UNRESOLVED');
      ports.push({name,direction,signed,range});
      if(t[i]===',')i++;else invariant(t[i]===')','DEPENDENCY_UNRESOLVED');
    }
    invariant(t[++i]===';'&&i===t.length-1&&ports.length&&new Set(ports.map(p=>p.name)).size===ports.length,'DEPENDENCY_UNRESOLVED');
    return {top,ports};
  } catch{return null;}
}

class Parser {
  constructor(source) {this.source=source;this.t=lex(source);this.i=0;this.units=[];}
  get v(){return this.t[this.i]?.value;}
  take(v) {invariant(this.v===v,'DEPENDENCY_UNRESOLVED',`Expected ${v}, found ${this.v ?? 'EOF'}`);return this.t[this.i++];}
  name(){invariant(ID.test(this.v??'')&&!WORDS.has(this.v),'DEPENDENCY_UNRESOLVED','Expected simple identifier');return this.t[this.i++].value;}
  group(open,close) {
    this.take(open);let depth=1;const start=this.i;
    while(this.i<this.t.length&&depth){if(this.v===open)depth++;if(this.v===close)depth--;this.i++;}
    invariant(depth===0,'DEPENDENCY_UNRESOLVED','Unbalanced delimiter');return this.t.slice(start,this.i-1);
  }
  throughSemicolon() {
    const stack=[];const start=this.i;
    for(;this.i<this.t.length;this.i++){
      const v=this.v;
      invariant(!['module','endmodule','begin','end','endcase','generate','endgenerate','function','endfunction'].includes(v),'DEPENDENCY_UNRESOLVED','Unsafe unit boundary');
      if(['(','[','{'].includes(v))stack.push({'(':')','[':']','{':'}'}[v]);
      if([')',']','}'].includes(v))invariant(stack.pop()===v,'DEPENDENCY_UNRESOLVED','Unbalanced expression');
      if(v===';'&&!stack.length){this.i++;return this.t.slice(start,this.i-1);}
    }
    invariant(false,'DEPENDENCY_UNRESOLVED','Missing semicolon');
  }
  statement() {
    if(this.v==='begin') {this.i++; while(this.v!=='end'){invariant(this.v,'DEPENDENCY_UNRESOLVED');this.statement();}this.i++;return;}
    if(this.v==='if'){this.i++;this.group('(',')');this.statement();if(this.v==='else'){this.i++;this.statement();}return;}
    if(['case','casez','casex'].includes(this.v)) {
      this.i++;this.group('(',')');
      while(this.v!=='endcase'){
        invariant(this.v,'DEPENDENCY_UNRESOLVED');
        let nesting=0;
        while(!(this.v===':'&&nesting===0)){
          invariant(this.v&&!['endcase',';','begin','end'].includes(this.v),'DEPENDENCY_UNRESOLVED','Invalid case item');
          if(['(','[','{'].includes(this.v))nesting++;if([')',']','}'].includes(this.v))nesting--;this.i++;
        }
        this.i++;this.statement();
      }this.i++;return;
    }
    if(this.v===';'){this.i++;return;}
    // Support assignments only; loops, calls, local scopes and timing controls
    // intentionally fall back. Dynamic LHS/RHS selects are rejected below.
    const a=this.throughSemicolon();
    invariant(a.some(t=>['=','<='].includes(t.value)),'DEPENDENCY_UNRESOLVED','Unsupported procedural statement');
    this.assignment(a);
  }
  assignment(a) {
    const k=a.findIndex(t=>['=','<='].includes(t.value));
    invariant(k>0,'DEPENDENCY_UNRESOLVED','Missing assignment');
    const lhs=a.slice(0,k).map(t=>t.value);
    invariant(ID.test(lhs[0])&&!WORDS.has(lhs[0])&&(lhs.length===1||/^\w+\[\d+(?::\d+)?\]$/.test(lhs.join(''))),'DEPENDENCY_UNRESOLVED','Only a single static LHS is supported');
    invariant(a.length>k+1,'DEPENDENCY_UNRESOLVED','Empty RHS');
  }
  unit(kind,parse) {
    const start=this.i;const metadata=parse();const a=this.t.slice(start,this.i);
    invariant(a.length,'DEPENDENCY_UNRESOLVED');
    this.units.push({kind,metadata,char_start:a[0].start,char_end:a.at(-1).end,tokens:a});
  }
  declaration() {
    const type=this.v;this.i++;
    if(['signed','unsigned'].includes(this.v))this.i++;
    if(this.v==='['){const range=this.group('[',']').map(t=>t.value).join('');invariant(/^\d+:\d+$/.test(range),'DEPENDENCY_UNRESOLVED','Only numeric packed widths are supported');}
    const names=[];
    do {
      if(this.v===',')this.i++;
      names.push(this.name());
      if(type==='localparam') {
        this.take('=');
        const start=this.i;while(![',',';'].includes(this.v)&&this.v)this.i++;
        invariant(this.i>start&&this.t.slice(start,this.i).every(t=>!ID.test(t.value)),'DEPENDENCY_UNRESOLVED','Complex localparam requires full context parser');
      }
    }while(this.v===',');
    this.take(';'); return names;
  }
  parse() {
    this.take('module');this.top=this.name();
    const ports=this.group('(',')');
    invariant(ports.some(t=>t.value==='input')&&ports.some(t=>t.value==='output'),'DEPENDENCY_UNRESOLVED','Local repair requires explicit ANSI ports');
    invariant(!ports.some(t=>['=','{','}'].includes(t.value)),'DEPENDENCY_UNRESOLVED','Complex port interface');
    this.take(';');this.headerEnd=this.t[this.i-1].end;
    while(this.v&&this.v!=='endmodule') {
      if(DECL.has(this.v))this.unit('declarations',()=>this.declaration());
      else if(this.v==='assign')this.unit('assign',()=>{this.i++;const a=this.throughSemicolon();this.assignment(a);});
      else if(['always','always_ff','always_comb','always_latch'].includes(this.v))this.unit('always',()=>{
        const kind=this.v;this.i++;
        if(['always','always_ff'].includes(kind)) {
          this.take('@');if(this.v==='*')this.i++;else this.group('(',')');
        }
        this.statement();
      });
      else if(this.v==='function')this.unit('function',()=>{
        this.i++;if(this.v==='automatic')this.i++;
        if(['integer','reg','logic'].includes(this.v))this.i++;
        if(this.v==='[')this.group('[',']');
        const name=this.name(), inputs=[];this.take(';');
        while(this.v==='input') {this.i++;if(['reg','logic'].includes(this.v))this.i++;if(this.v==='[')this.group('[',']');inputs.push(this.name());while(this.v===','){this.i++;inputs.push(this.name());}this.take(';');}
        this.statement();this.take('endfunction');return {name,inputs};
      });
      else invariant(false,'DEPENDENCY_UNRESOLVED',`Unsupported module item ${this.v}`);
    }
    this.footerStart=this.take('endmodule').start;
    invariant(this.i===this.t.length,'DEPENDENCY_UNRESOLVED','Multiple modules or trailing tokens');
    return this;
  }
}

export function indexUnits(rtl,{resolve=true}={}) {
  try {
    const p=new Parser(rtl).parse();
    // Numeric bit selects only. Dynamic indexing and hierarchy require a richer
    // dependency resolver and therefore take the full-module path in v1.
    for(let i=0;i<p.t.length;i++) {
      if(p.t[i].value==='['){const j=p.t.findIndex((t,k)=>k>i&&t.value===']');invariant(j>i&&p.t.slice(i+1,j).every(t=>/^\d+$/.test(t.value)||t.value===':'),'DEPENDENCY_UNRESOLVED','Dynamic/complex select');}
      invariant(p.t[i].value!=='.','DEPENDENCY_UNRESOLVED','Hierarchy or instance dependency');
    }
    const symbols=new Set(p.t.filter(t=>t.end<=p.headerEnd&&ID.test(t.value)&&!WORDS.has(t.value)).map(t=>t.value));
    for(const u of p.units) {
      if(u.kind==='declarations')for(const name of u.metadata)symbols.add(name);
      if(u.kind==='function')symbols.add(u.metadata.name);
    }
    if(resolve)for(const u of p.units)for(const t of u.tokens)if(ID.test(t.value)&&!WORDS.has(t.value))
      invariant(symbols.has(t.value)||(u.kind==='function'&&u.metadata.inputs.includes(t.value)),'DEPENDENCY_UNRESOLVED',`Unresolved identifier ${t.value}`);
    const units=p.units.map((u,i)=>{
      const start_byte=Buffer.byteLength(rtl.slice(0,u.char_start));const end_byte=Buffer.byteLength(rtl.slice(0,u.char_end));
      const old_text=sliceBytes(rtl,start_byte,end_byte);
      const writes=[];
      for(let j=0;j<u.tokens.length;j++) {
        if(['=','<='].includes(u.tokens[j].value)) {
          let k=j-1;if(u.tokens[k]?.value===']'){while(k>=0&&u.tokens[k].value!=='[')k--;k--;}
          if(ID.test(u.tokens[k]?.value??''))writes.push(u.tokens[k].value);
        }
      }
      const identifiers=[...new Set(u.tokens.filter(t=>ID.test(t.value)&&!WORDS.has(t.value)).map(t=>t.value))];
      return {unit_id:`u${i+1}`,kind:u.kind,start_byte,end_byte,old_sha256:sha256(old_text),old_text,identifiers,writes:[...new Set(writes)]};
    });
    const drivers=new Map();
    for(const u of units.filter(u=>u.kind!=='declarations'&&u.kind!=='function')) for(const w of u.writes) {
      invariant(!drivers.has(w),'DEPENDENCY_UNRESOLVED',`Multiple drivers for ${w}`);drivers.set(w,u.unit_id);
    }
    return {ok:true,version:INDEX_VERSION,sha256:sha256(rtl),top:p.top,units,
      interface_signature:p.t.filter(t=>t.end<=p.headerEnd&&!['wire','reg','logic'].includes(t.value)).map(t=>t.value).join(' '),
      header:rtl.slice(0,p.headerEnd),footer:rtl.slice(p.footerStart),
      // Full complementary source stays read-only. No unproven transitive
      // pruning: all declarations, other writers/readers, states and timing are
      // retained, or the entire package is rejected for context overflow.
      dependencies:'full_complement',error:null};
  } catch(error) {return {ok:false,version:INDEX_VERSION,sha256:sha256(rtl),units:[],error:{code:error.code??'DEPENDENCY_UNRESOLVED',message:error.message}};}
}
export function directory(index) {
  return index.units.map(({unit_id,kind,start_byte,end_byte,old_sha256})=>({unit_id,kind,start_byte,end_byte,old_sha256}));
}
