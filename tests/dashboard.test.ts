import { describe, expect, test } from "bun:test";
import { dashboardHtml } from "../packages/cli/src/dashboard";

describe("dashboard", () => {
  test("renders a dedicated active queue region for todo and running tasks", () => {
    const html = dashboardHtml({ runId: "run_123" });

    expect(html).toContain("Active Queue");
    expect(html).toContain('id="active-queue"');
    expect(html).toContain("todo");
    expect(html).toContain("running");
  });
});
