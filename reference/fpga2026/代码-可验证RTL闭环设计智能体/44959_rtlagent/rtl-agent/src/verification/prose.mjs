import {prose} from '../dual/contracts.mjs';

// Only verification explanation fields use this gate. Equations are data in
// those fields, never instructions to execute; the saved explanation is intact.
// The general auxiliary/diagnostic role gates are deliberately unchanged.
export function verificationProse(text){
  const equation=/^[A-Za-z_]\w*(?:\[\d+(?::\d+)?\])?\s*=(?!=)\s*[\w\s'()[\]~!&|^+*%?:<>/-]+;?$/;
  const view=text
    .replace(/`([^`\n]+)`/g,(token,inside)=>equation.test(inside)&&!/[{}@]|\b(?:assign|module|endmodule|always|initial|begin|end)\b/.test(inside)?'[source equation]':token)
    .replace(/\b(equation|relation|expression)\s+([^;\n]+);/gi,(token,noun,inside)=>equation.test(inside)?noun+' [source equation];':token)
    .replace(/\b(the|this|that)\s+module\s+(behavior|outputs)\b/gi,'$1 circuit $2')
    .replace(/\bmodule(?=\s+(?:is|has|uses|implements|requires|provides|contains|produces|behavior|outputs)\s+[A-Za-z])/gi,'circuit');
  prose(view);
}
