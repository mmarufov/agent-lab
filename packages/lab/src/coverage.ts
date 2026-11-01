// A small coverage evaluator, independent of any recording format. A profile
// turns one full recording into facts and the recorded records that could
// establish each; this checks which of those records an investigator
// retrieved. It reads no files, database, or answer, so it says nothing about
// what the answer concluded.

export const COVERAGE_EVALUATOR_VERSION = "coverage-v1";

/** Part of a fact's evidence: retrieving any one of these recorded records meets it. */
export interface EvidenceRequirement {
  id: string;
  description: string;
  anyOf: string[];
}

interface FactIdentity {
  id: string;
  /** How the terminal names it, such as "Recovery evidence". */
  label: string;
  /** What the evidence establishes, such as "Requests subsequently recovered". */
  statement: string;
}

/**
 * One fact a profile looked for in the full recording. A fact the recording
 * contains is established by meeting every requirement, each with any one of
 * its records; a fact the recording does not contain says why.
 */
export type CoverageFact =
  | (FactIdentity & { applicable: true; requirements: EvidenceRequirement[] })
  | (FactIdentity & { applicable: false; reason: string });

export type CoverageStatus = "covered" | "missed" | "not_assessed";

export interface FactCoverage extends FactIdentity {
  status: CoverageStatus;
  reason: string;
  /**
   * Each requirement with the retrieved records that meet it; empty for a fact
   * the recording does not contain. A requirement with no matchedIds is the
   * missing evidence, and its anyOf lists every acceptable alternative.
   */
  requirements: (EvidenceRequirement & { matchedIds: string[] })[];
}

export interface CoverageResult {
  evaluatorVersion: typeof COVERAGE_EVALUATOR_VERSION;
  result: CoverageStatus;
  reason: string;
  facts: FactCoverage[];
}

function validate(facts: readonly CoverageFact[]) {
  const ids = new Set<string>();
  for (const fact of facts) {
    if (ids.has(fact.id)) throw new Error(`Coverage fact ${fact.id} is defined twice.`);
    ids.add(fact.id);
    if (fact.applicable && (!fact.requirements.length || fact.requirements.some((requirement) => !requirement.anyOf.length)))
      throw new Error(`Coverage fact ${fact.id} needs at least one requirement, each with at least one acceptable record.`);
  }
}

const unmatched = (fact: Extract<CoverageFact, { applicable: true }>) =>
  fact.requirements.map((requirement) => ({ ...requirement, matchedIds: [] as string[] }));

/**
 * covered: every requirement of every fact the recording contains has a
 * retrieved record. missed: some fact lacks one. not_assessed: the recording
 * contains none of the facts, so there is nothing to pass.
 */
export function evaluateCoverage(facts: readonly CoverageFact[], retrievedIds: Iterable<string>): CoverageResult {
  validate(facts);
  const retrieved = new Set(retrievedIds);
  const results = facts.map((fact): FactCoverage => {
    const { id, label, statement } = fact;
    if (!fact.applicable) return { id, label, statement, status: "not_assessed", reason: fact.reason, requirements: [] };
    const requirements = fact.requirements.map((requirement) => ({ ...requirement, matchedIds: requirement.anyOf.filter((record) => retrieved.has(record)) }));
    const missing = requirements.filter((requirement) => !requirement.matchedIds.length);
    return {
      id, label, statement, requirements,
      status: missing.length ? "missed" : "covered",
      reason: missing.length
        ? `No retrieved record meets: ${missing.map((requirement) => requirement.description).join("; ")}.`
        : "Retrieved records meet every requirement.",
    };
  });
  const applicable = results.filter((fact) => fact.status !== "not_assessed");
  const missed = applicable.filter((fact) => fact.status === "missed");
  return {
    evaluatorVersion: COVERAGE_EVALUATOR_VERSION,
    facts: results,
    ...(!applicable.length
      ? { result: "not_assessed", reason: "The recording contains none of this profile's facts, so there is no coverage to pass." }
      : missed.length
        ? { result: "missed", reason: `Retrieved records do not meet the evidence requirements of: ${missed.map((fact) => fact.label).join(", ")}.` }
        : { result: "covered", reason: `Retrieved records meet the evidence requirements of every fact this profile found in the recording (${applicable.length}).` }),
  };
}

/** The same facts and requirements, none assessed, when the investigation's retrieved records cannot be counted. */
export function unassessedCoverage(facts: readonly CoverageFact[], reason: string): CoverageResult {
  validate(facts);
  return {
    evaluatorVersion: COVERAGE_EVALUATOR_VERSION,
    result: "not_assessed",
    reason,
    facts: facts.map(({ id, label, statement, ...fact }) => ({
      id, label, statement, status: "not_assessed",
      reason: fact.applicable ? reason : fact.reason,
      requirements: fact.applicable ? unmatched({ id, label, statement, ...fact }) : [],
    })),
  };
}
