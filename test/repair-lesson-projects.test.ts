import { describe, it, expect } from "vitest";
import { planLessonRepair } from "../scripts/repair-lesson-projects.js";
import type { Lesson } from "../src/types.js";

function lesson(id: string, project: string | undefined, tags: string[] = []): Lesson {
  return {
    id,
    content: `lesson ${id}`,
    context: "",
    confidence: 0.5,
    reinforcements: 0,
    source: "manual",
    sourceIds: [],
    project,
    tags,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    decayRate: 0.05,
  };
}

const SESSION_PROJECTS = new Set(["nanokvm-boot-lab-0c7806", "homelab", "devex", "glydr"]);

describe("repair-lesson-projects plan (#377)", () => {
  it("moves a mapped project to the project its Sessions use", () => {
    const plan = planLessonRepair([lesson("a", "nanokvm-boot-lab"), lesson("b", "makara")], SESSION_PROJECTS);
    expect(plan.moves.map((m) => [m.lesson.id, m.from, m.to])).toEqual([
      ["a", "nanokvm-boot-lab", "nanokvm-boot-lab-0c7806"],
      ["b", "makara", "glydr"],
    ]);
    expect(plan.unplaced).toEqual([]);
  });

  it("leaves a Lesson whose project Sessions use alone", () => {
    expect(planLessonRepair([lesson("a", "homelab")], SESSION_PROJECTS)).toEqual({ moves: [], unplaced: [] });
  });

  it("moves a global Lesson to the one Session project its tags name", () => {
    const plan = planLessonRepair([lesson("g", undefined, ["homelab", "commitlint"])], SESSION_PROJECTS);
    expect(plan.moves.map((m) => [m.from, m.to])).toEqual([[null, "homelab"]]);
  });

  it("lists, without moving, a global Lesson whose tags name no project or two", () => {
    const plan = planLessonRepair(
      [lesson("none", undefined, ["git"]), lesson("two", undefined, ["homelab", "devex"])],
      SESSION_PROJECTS,
    );
    expect(plan.moves).toEqual([]);
    expect(plan.unplaced.map((l) => l.id)).toEqual(["none", "two"]);
  });

  it("lists, without moving, an unmapped project no Session uses, and skips deleted Lessons", () => {
    const gone = { ...lesson("d", "compass"), deleted: true };
    const plan = planLessonRepair([lesson("u", "urchin"), gone], SESSION_PROJECTS);
    expect(plan.moves).toEqual([]);
    expect(plan.unplaced.map((l) => l.id)).toEqual(["u"]);
  });

  it("lists a mapped Lesson whose target project has no Session", () => {
    const plan = planLessonRepair([lesson("c", "compass")], SESSION_PROJECTS);
    expect(plan.unplaced.map((l) => l.id)).toEqual(["c"]);
  });
});
