import { readFileSync } from 'node:fs';

// Explicit, versioned extension. The v1 artifact and its training fixtures stay
// immutable; both versions use the same strict validator and renderer entry.
const schema=JSON.parse(readFileSync(new URL('./v1.schema.json',import.meta.url),'utf8'));
schema.$id='urn:rtl2llm:protocol:v2';schema.title='RTL2LLM v2 knowledge and repair review';
schema.properties.protocol.const='rtl2llm.v2';
// Phase-2 planning can carry up to 32 grounded requirements plus template facts.
// v1's original 24-item contract remains unchanged.
schema.$defs.constraints.maxItems=64;
// Full program-produced observations are distinct from the bounded prose
// summary. v1's 4K summary limit is not weakened or silently bypassed.
schema.$defs.evidence.properties.observation={type:'string',minLength:1,maxLength:1048576};
schema.$defs.issue.properties.code_locations={type:'array',maxItems:12,items:{type:'object',additionalProperties:false,required:['start_line','end_line','text_sha256'],properties:{start_line:{type:'integer',minimum:1,maximum:32768},end_line:{type:'integer',minimum:1,maximum:32768},text_sha256:{$ref:'#/$defs/hash'}}}};
const ref=name=>({$ref:`#/$defs/${name}`});
const object=(required,properties)=>({type:'object',additionalProperties:false,required,properties});
schema.$defs.knowledge=object(['collection','index_sha256','documents'],{
  collection:{enum:['diagnosis','repair']},index_sha256:ref('hash'),
  documents:{type:'array',maxItems:8,items:object(['id','pattern_id','revision','source','applies_when','text','sha256'],{
    id:ref('id'),pattern_id:ref('id'),revision:ref('id'),source:ref('text'),applies_when:ref('text'),text:ref('rtl'),sha256:ref('hash'),
  })},
});
schema.$defs.repairContext=object(['previous_candidate','previous_issues','target_issue_ids','pending_issue_ids'],{
  previous_candidate:ref('candidate'),previous_issues:{type:'array',minItems:1,maxItems:8,items:ref('issue')},
  target_issue_ids:ref('ids'),pending_issue_ids:ref('ids'),
  location_updates:{type:'array',maxItems:8,items:object(['issue_id','status','locations','reason'],{
    issue_id:ref('id'),status:{enum:['needs_recheck','mapped_requires_review']},reason:ref('text'),locations:schema.$defs.issue.properties.code_locations,
  })},
});
schema.$defs.repairAssessment=object(['issue_id','status','reason','evidence_ids'],{
  issue_id:ref('id'),status:{enum:['resolved','still_present','uncertain','prior_diagnosis_invalid']},reason:ref('text'),evidence_ids:ref('ids'),
});
schema.$defs.reviewRequest.properties.knowledge=ref('knowledge');
schema.$defs.reviewRequest.properties.repair_context=ref('repairContext');
schema.$defs.reviewResponse.properties.repair_assessments={type:'array',maxItems:8,items:ref('repairAssessment')};
schema.$defs.repairRequest.properties.knowledge=ref('knowledge');
schema.$defs.repairRequest.properties.constraints=ref('constraints');
schema.$defs.repairRequest.properties.pending_issues={type:'array',maxItems:8,items:ref('issue')};
export default schema;
