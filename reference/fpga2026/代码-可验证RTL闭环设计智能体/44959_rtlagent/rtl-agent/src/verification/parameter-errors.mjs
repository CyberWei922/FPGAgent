// Presentation only: schemas and validation decisions are unchanged.
const display=value=>value===undefined?'missing':JSON.stringify(value,(_,v)=>typeof v==='bigint'?String(v):v)?.slice(0,160);
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
function branch(schema,value){
 const choices=schema?.anyOf??schema?.oneOf;
 if(!choices)return schema??{};
 const tagged=choices.filter(s=>object(value)&&Object.entries(s.properties??{}).some(([k,v])=>v.const!==undefined&&value[k]===v.const||v.enum?.includes(value[k])));
 if(tagged.length===1)return branch(tagged[0],value);
 const typed=choices.filter(s=>s.type===(Array.isArray(value)?'array':value===null?'null':typeof value));
 return typed.length===1?branch(typed[0],value):schema;
}
function at(schema,value,path){
 for(const key of path){
  schema=branch(schema,value);
  const child=s=>typeof key==='number'?(Array.isArray(s.items)?s.items[key]:s.items):s.properties?.[key]??s.additionalProperties;
  const choices=schema?.anyOf??schema?.oneOf;
  const children=choices?.map(child).filter(s=>s&&typeof s==='object');
  schema=children?.length?{anyOf:children}:child(schema??{});
  value=value?.[key];
 }
 return branch(schema,value);
}
function expected(schema){
 if(schema.const!==undefined)return JSON.stringify(schema.const);
 if(schema.enum)return schema.enum.map(v=>JSON.stringify(v)).join(' | ');
 if(schema.anyOf||schema.oneOf)return (schema.anyOf??schema.oneOf).map(expected).join(' | ');
 let s=Array.isArray(schema.type)?schema.type.join(' | '):schema.type??'schema-valid value';
 if(schema.minimum!==undefined||schema.maximum!==undefined)s+=` [${schema.minimum??'-infinity'}..${schema.maximum??'infinity'}]`;
 if(schema.pattern)s+=' matching '+schema.pattern;
 if(schema.minLength!==undefined||schema.maxLength!==undefined)s+=` length ${schema.minLength??0}..${schema.maxLength??'unbounded'}`;
 return s;
}
export function methodValidationMessage(error,raw,schema){
 const method=typeof raw?.method==='string'?raw.method:'unavailable';
 const flatten=(issues,prefix=[])=>issues.flatMap(e=>e.code==='invalid_union'&&e.errors?.some(es=>es.some(x=>x.path.length))?
   e.errors.flatMap(es=>flatten(es,[...prefix,...e.path])):[{...e,path:[...prefix,...e.path]}]);
 const issues=[...new Map(flatten(error.issues).map(e=>[JSON.stringify([e.path,e.code,e.keys]),e])).values()];
 // Unknown-field guidance must survive a long list of missing required fields.
 const selected=[...issues.filter(e=>e.code==='unrecognized_keys'),...issues.filter(e=>e.code!=='unrecognized_keys').slice(0,3)];
 const fields=s=>[...new Set(Object.keys(s.properties??{}).concat((s.anyOf??s.oneOf??[]).flatMap(fields)))];
 return selected.flatMap(issue=>{
  const definition=at(schema,raw,issue.path);
  const paths=issue.code==='unrecognized_keys'?issue.keys.map(k=>[...issue.path,k]):[issue.path];
  return paths.map(path=>{
   const actual=path.reduce((v,k)=>v?.[k],raw);
   const node=path[0]==='params'&&path[1]==='nodes'&&typeof path[2]==='number'?` node ${path[2]} (${raw.params.nodes[path[2]]?.id??'unknown'}) ${path.slice(3).join('.')}`:'';
   const want=issue.code==='unrecognized_keys'?'no unknown field; allowed fields: '+fields(definition).join(', '):expected(definition);
   return `method ${method}; field ${path.join('.')||'response'}${node}: expected ${want}; actual ${display(actual)}${issue.code==='unrecognized_keys'?'':'; constraint: '+issue.message}`;
  });
 }).join('\n');
}
export function methodSemanticMessage(error,raw){
 if(error.message.startsWith('method '))return error.message;
 const node=/node (\d+|-) \(([^)]+)\) ([^:]+): expected (.*); actual (.*)/.exec(error.message);
 if(node)return `method ${raw?.method??'unknown'}; field params.${node[1]==='-'?'':`nodes.${node[1]}.`}${node[3]}: expected ${node[4]}; actual ${node[5]}; constraint: ${error.message}`;
 if(/source (?:address|range)|source addresses/i.test(error.message))return `method ${raw?.method??'unknown'}; field sources: expected ${error.message}; actual ${display(raw?.sources)}`;
 const role=/^(?:Invalid (input|output) role|A port cannot have multiple roles): (.+)$/.exec(error.message);
 if(role){
  const paths=(value,path)=>Object.entries(value??{}).flatMap(([k,v])=>v===role[2]?[path+'.'+k]:object(v)||Array.isArray(v)?paths(v,path+'.'+k):[]);
  const fields=paths(raw?.params,'params');
  if(fields.length)return `method ${raw?.method??'unknown'}; field ${fields.join(', ')}: expected ${role[1]?`declared ${role[1]} port with matching width`:'unique port role'}; actual ${display(role[2])}; constraint: ${error.message}`;
 }
 return `method ${raw?.method??'unknown'}; field params: expected ${error.message}; actual ${display(raw?.params)}`;
}
