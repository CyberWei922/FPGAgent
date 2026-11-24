// Rank only observed tool evidence. Self-generated checks remain fallible and
// these ranks never represent official functional grades.
export function candidateEvidenceRank(validation) {
  const stages = validation?.stages ?? [];
  const passed = name => stages.some(s => s.name === name && ['pass', 'passed'].includes(s.status));
  if (passed('simulate')) return 3 + (passed('synthesize') ? .5 : 0);
  if (passed('synthesize')) return 2;
  if (!passed('compile')) return 0;
  const simulation = stages.find(s => s.name === 'simulate');
  if (simulation?.completed && Number.isSafeInteger(simulation.checks) && simulation.checks > 0 && Number.isSafeInteger(simulation.failures)
      && simulation.failures > 0 && simulation.failures <= simulation.checks) return 1 + .49 * (1 - simulation.failures / simulation.checks);
  return 1;
}
