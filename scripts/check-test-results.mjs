import { readFileSync } from "node:fs";

const reportPath = process.argv[2] ?? "bundles/tests.json";

try {
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const suites = Object.entries(report);
  if (suites.length === 0) throw new Error("No Paperback test suites ran.");

  // The Paperback CLI logs failures without setting a failing exit code.
  for (const [name, suite] of suites) {
    if (
      suite.error !== undefined ||
      suite.summary?.failed !== 0 ||
      !suite.tests?.length ||
      suite.tests.some((test) => test.status !== "pass")
    ) {
      console.error(`${name}: test suite failed or did not complete.`);
      process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(`Unable to verify Paperback test results: ${error.message}`);
  process.exitCode = 1;
}
