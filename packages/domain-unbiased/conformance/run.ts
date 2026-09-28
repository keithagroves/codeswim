/**
 * Partner device-flow conformance runner (plan §Phase 3; the discipline it
 * asserts is docs/partner-device-flow.md).
 *
 *   npx tsx scripts/partner-conformance/run.ts               # unbiased-app (UNBIASED_APP_DIR, default ../unbiased-app)
 *   npx tsx scripts/partner-conformance/run.ts --adapter <module-path>   # any adapter default-exporting ConformanceAdapter
 *   npx tsx scripts/partner-conformance/run.ts --self-test   # the kit proves it passes a compliant client and fails a violating one
 *
 * Exit 0 = conformant. No platform code, database or provider is touched —
 * the "platform" is a local scripted mock on an ephemeral port.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ConformanceAdapter } from "./adapter";
import { runScenarios, ScenarioResult } from "./scenarios";

function print(adapterName: string, results: ScenarioResult[]): boolean {
  console.log(`\nConformance: ${adapterName}`);
  for (const r of results) {
    console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.scenario}`);
    for (const d of r.details) console.log(`        ${d}`);
  }
  const failed = results.filter((r) => !r.pass).length;
  console.log(failed === 0 ? `\nAll ${results.length} scenarios passed.` : `\n${failed}/${results.length} scenarios FAILED.`);
  return failed === 0;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--self-test") {
    const { compliant, violatingRepoll, violatingImpatient } = await import("./adapters/reference");
    const ok = print(compliant.name, await runScenarios(compliant));
    let allCaught = true;
    for (const violator of [violatingRepoll, violatingImpatient]) {
      const results = await runScenarios(violator);
      const caught = results.some((r) => !r.pass);
      allCaught = allCaught && caught;
      console.log(`\n${violator.name}: ${caught ? "caught (kit FAILS it, as it must)" : "NOT CAUGHT — kit bug"}`);
      for (const r of results.filter((x) => !x.pass)) console.log(`  caught by: ${r.scenario}`);
    }
    process.exit(ok && allCaught ? 0 : 1);
  }
  const modulePath = args[0] === "--adapter" && args[1] ? args[1] : path.join(__dirname, "adapters", "unbiased-app.ts");
  const imported = await import(pathToFileURL(path.resolve(modulePath)).href);
  const adapter = (imported.default ?? imported.adapter) as ConformanceAdapter | undefined;
  if (!adapter?.start || !adapter?.poll) {
    console.error(`${modulePath} does not default-export a ConformanceAdapter`);
    process.exit(2);
  }
  process.exit(print(adapter.name, await runScenarios(adapter)) ? 0 : 1);
}

void main();
