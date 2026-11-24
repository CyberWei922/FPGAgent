import {indexUnits} from './unit-index.mjs';
import {invariant,sha256} from './snapshot.mjs';
const check=(ok,message)=>invariant(ok,'LOCAL_REPAIR_INVALID',message);

// One replacement block, not model-generated offsets/hashes or an entire
// module. Authorization always addresses the CURRENT immutable snapshot.
export function applyLocalRepair(base,unitIds,text){
 check(base.sha256===sha256(base.rtl),'Local base snapshot changed');
 const index=indexUnits(base.rtl);
 check(index.ok&&unitIds.length===1,'One proven indexed unit required');
 const unit=index.units.find(u=>u.unit_id===unitIds[0]);
 check(unit&&['assign','always'].includes(unit.kind),'Unsupported local replacement kind');
 const match=/^\s*<answer>\s*```(?:systemverilog|verilog|sv)\s*\n([\s\S]*?)\n```\s*<\/answer>\s*$/.exec(text);
 check(match&&!match[1].includes('```'),'Submit exactly one fenced replacement unit in <answer>; no complete module or extra draft');
 const replacement=match[1],isolated=indexUnits(index.header+'\n'+replacement+'\nendmodule',{resolve:false});
 check(isolated.ok&&isolated.units.length===1&&isolated.units[0].kind===unit.kind,'Replacement must contain exactly one unit of the original kind; no duplicate driver or module escape');
 const same=(a,b)=>JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
 check(same(isolated.units[0].writes,unit.writes),'Replacement may only drive the original signals');
 const bytes=Buffer.from(base.rtl),rtl=Buffer.concat([bytes.subarray(0,unit.start_byte),Buffer.from(replacement),bytes.subarray(unit.end_byte)]).toString('utf8');
 const after=indexUnits(rtl);
 check(after.ok&&after.header===index.header&&after.units.length===index.units.length,'Reassembled design has unresolved identifiers, changed interface or multiple drivers');
 return {rtl,authorization:{base_sha256:base.sha256,unit_id:unit.unit_id,old_sha256:unit.old_sha256,new_sha256:sha256(replacement),immutable_complement_copied:true}};
}
