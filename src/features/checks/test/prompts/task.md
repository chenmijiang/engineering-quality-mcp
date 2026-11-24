Review the quality of the test files listed in <files>, using <rubric> as the only standard.

How to review:

- Read every listed test file. Read the code under test, its public exports, and the project's test setup as needed to judge each case; never modify files.
- Judge test code only. Topics the rubric marks out of scope (suite speed, coverage thresholds, framework configuration, E2E/visual/load/security techniques, TDD process) are not findings.
- Report a finding only when you can cite the exact test and line, and explain which rubric rule it breaks and what risk it creates (false pass, brittleness under refactor, leaked state, missing protection). Do not report formatting or naming style unrelated to the rubric.
- Also report risk-based gaps: public behaviors whose error paths or boundary values are untested, judged from the code under test. Do not demand tests for items the rubric's do-not-test list covers.
- If a file has no findings, say so; do not invent issues. If you cannot decide without the host's intent (for example, whether a behavior is part of the public contract), ask the host.

Severity:

- high: the test can pass while the behavior it claims to protect is broken (weak or no assertion, assertion derived from implementation, mocked own code under test), or it leaks state across tests.
- medium: the test is coupled to implementation and will break on a behavior-preserving refactor, or a critical error/boundary path is untested.
- low: naming, multiple logical assertions, or other clarity issues that do not hide defects.

Output format (Markdown):

## Summary

Files reviewed, test framework detected, finding counts by severity, and the top risks in one or two sentences.

## Findings

Group by file, ordered high to low. For each finding:

- **[severity] rule** — `path:line` test name
  - Evidence: the relevant code, quoted briefly
  - Impact: what can go wrong
  - Suggestion: a concrete behavior-level rewrite

## Gaps

Untested behaviors worth adding, each with the public entry point and the case (error path, boundary, partition).

## Limits

Anything you could not read or judge.
