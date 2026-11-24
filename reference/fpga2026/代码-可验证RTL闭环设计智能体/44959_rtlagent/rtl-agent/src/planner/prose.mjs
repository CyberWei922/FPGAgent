import { prose } from '../dual/contracts.mjs';
import { invariant } from '../dual/snapshot.mjs';

// Classify only parser-local content failures, not transport/client errors.
// A fresh bounded planning attempt may correct this; rejected code is never
// carried into the next request. Keep the diagnostic static and non-executable.
export function planProse(text) {
  // A noun phrase describing an existing process is not a replacement HDL
  // statement. Mask only this narrow phrase for validation; preserve the saved
  // text, and leave any following assignments/fences/processes visible.
  const view=text.replace(/\b(the|an?|this|that)\s+`?always\s*@\s*\(\s*\*\s*\)`?\s+block\b/gi,'$1 combinational process')
    // A descriptive heading such as "Purely combinational always @(*); no
    // clock" is another process reference, not a procedural body. Require the
    // natural-language modifier and punctuation immediately after the header.
    // Never mask a bare header, edge-sensitive process, body or its suffix.
    .replace(/\bcombinational\s+`?always\s*@\s*\(\s*\*\s*\)`?(?=\s*[;,.])/gi,'combinational process');
  try { prose(view); }
  catch(error) {
    if(error.code!=='OUTPUT_INVALID')throw error;
    invariant(false,'PLAN_CONTENT_INVALID','Use prose only: no HDL statements, executable tests or code fences. Describe signal conditions in words or inline expressions without statement terminators.');
  }
}
