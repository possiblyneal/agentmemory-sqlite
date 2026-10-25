import { getAllTools } from "./tools-registry.js";

let projectTools: Set<string> | undefined;

function takesProject(toolName: string): boolean {
  projectTools ??= new Set(
    getAllTools()
      .filter((t) => "project" in (t.inputSchema.properties ?? {}))
      .map((t) => t.name),
  );
  return projectTools.has(toolName);
}

export function withDefaultProject(
  toolName: string,
  args: Record<string, unknown>,
  project: string,
): Record<string, unknown> {
  if (!takesProject(toolName)) return args;
  if (args["global"] === true || args["scope"] === "global") return args;
  const given = args["project"];
  if (typeof given === "string" && given.trim()) return args;
  return { ...args, project };
}
