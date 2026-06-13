#!/usr/bin/env bun
import { Harness } from "@ouroboros/harness";
import { fail, flag, parseArgs, required } from "./args";
import { parseArray, parseObject, printJson } from "./json";

const parsed = parseArgs(Bun.argv.slice(2));
const harness = new Harness(parsed.db);

switch (parsed.command) {
  case "init": {
    harness.init();
    printJson({ db: parsed.db, status: "initialized" });
    break;
  }
  case "create-run": {
    const goal = required(parsed, "goal");
    const context = parseObject(flag(parsed, "context-json") ?? "{}");
    const id = harness.createRun({ goal, context });
    printJson({ id, goal, status: "todo" });
    break;
  }
  case "create-task": {
    const runId = required(parsed, "run-id");
    const role = required(parsed, "role");
    const goal = required(parsed, "goal");
    const prompt = required(parsed, "prompt");
    const dependsOn = parseArray(flag(parsed, "depends-on-json") ?? "[]");
    const doneWhen = parseArray(flag(parsed, "done-when-json") ?? "[]");
    const parentId = flag(parsed, "parent-id") ?? null;
    const id = harness.createTask({
      runId,
      role,
      goal,
      prompt,
      dependsOn,
      doneWhen,
      parentId,
    });
    printJson({ id, runId, role, goal, status: "todo" });
    break;
  }
  case "next-task": {
    printJson(harness.nextReadyTask(required(parsed, "run-id")));
    break;
  }
  case "link-external": {
    const localType = required(parsed, "local-type");
    const localId = required(parsed, "local-id");
    const provider = required(parsed, "provider");
    const externalType = required(parsed, "external-type");
    const externalId = required(parsed, "external-id");
    const externalUrl = flag(parsed, "external-url") ?? null;
    const id = harness.createExternalRef({
      localType,
      localId,
      provider,
      externalType,
      externalId,
      externalUrl,
    });
    printJson({
      id,
      localType,
      localId,
      provider,
      externalType,
      externalId,
      externalUrl,
    });
    break;
  }
  default:
    fail(`unknown command: ${parsed.command}`);
}
