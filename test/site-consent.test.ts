import { expect, test } from "bun:test";

for (const scenario of ["required", "exempt", "unavailable"]) {
  test(`the deployed analytics entry respects ${scenario} regional consent`, async () => {
    const child = Bun.spawn([process.execPath, "scripts/site-consent-harness.ts", scenario], {
      cwd: new URL("../", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
    });
    const [exitCode, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exitCode, error }).toEqual({ exitCode: 0, error: "" });
    expect(JSON.parse(output)).toMatchObject({ scenario, analyticsRequests: 1, passed: true });
  }, 15_000);
}
