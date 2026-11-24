// One lexical scan is shared by the incremental guard and final comment removal.
// Strings and escaped identifiers can legally contain comment delimiters.
function scan(text, final = true) {
  let state = 'code', escaped = false, comments = 0, result = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (state === 'string') {
      result += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') state = 'code';
    } else if (state === 'identifier') {
      result += c; if (/\s/.test(c)) state = 'code';
    } else if (state === 'line') {
      if (c === '\n') { result += c; state = 'code'; }
      else { comments++; result += c === '\r' ? c : ' '; }
    } else if (state === 'block') {
      comments++; result += /[\r\n]/.test(c) ? c : ' ';
      if (c === '*' && next === '/') { comments++; result += ' '; i++; state = 'code'; }
    } else if (c === '"') { state = 'string'; result += c; }
    else if (c === '\\') { state = 'identifier'; result += c; }
    else if (c === '/' && (next === '/' || next === '*')) {
      state = next === '/' ? 'line' : 'block'; comments += 2; result += '  '; i++;
    } else result += c;
  }
  if (final && state === 'block') throw new Error('Unterminated RTL block comment');
  return { text: result, commentChars: comments };
}

export function stripRtlComments(text) {
  return scan(text).text.trim() + '\n';
}

export function checkOutputPolicy(text, policy) {
  if (!policy) return null;
  if (!Number.isSafeInteger(policy.maxCommentChars) || policy.maxCommentChars < 0) throw new Error('Invalid output comment budget');
  return scan(text, false).commentChars > policy.maxCommentChars ? 'MODEL_OUTPUT_POLICY' : null;
}
