import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

describe("onboarding background handoff", () => {
  test("awaits initial keywords before declaring primary onboarding complete", () => {
    const source = readFileSync(
      resolve(import.meta.dir, "../inngest/client.ts"),
      "utf8",
    );
    const completeTask = source.slice(
      source.indexOf("export const completeOnboardingTask"),
      source.indexOf("export const secondaryOnboardingV2InitializeTask"),
    );

    const keywordInvoke = completeTask.indexOf(
      'step.invoke("generate-initial-keywords"',
    );
    const terminalMarker = completeTask.indexOf(
      'step.run("set-user-onboarding-complete"',
    );
    expect(keywordInvoke).toBeGreaterThan(-1);
    expect(terminalMarker).toBeGreaterThan(keywordInvoke);
    expect(completeTask).toContain('"verify-initial-keywords-completed"');
    expect(completeTask).toContain('"reconcile-primary-workspace"');
  });
});
