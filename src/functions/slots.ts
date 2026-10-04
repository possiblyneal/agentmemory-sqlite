import type { ISdk } from "../engine/types.js";
import type { MemorySlot, CompressedObservation, Session } from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { recordAudit } from "./audit.js";
import { getEnvVar } from "../config.js";
import { logger } from "../logger.js";
import { scrubFields } from "./privacy.js";

type SlotScope = "project" | "global";

const DEFAULT_SIZE_LIMIT = 2000;

export const DEFAULT_SLOTS: ReadonlyArray<
  Omit<MemorySlot, "createdAt" | "updatedAt">
> = [
  {
    label: "persona",
    content: "",
    sizeLimit: 1000,
    description:
      "How the agent should see itself: role, tone, behavioural guidelines.",
    pinned: true,
    readOnly: false,
    scope: "global",
  },
  {
    label: "user_preferences",
    content: "",
    sizeLimit: 2000,
    description:
      "Coding style, tool preferences, naming conventions, and other habits the user wants preserved across sessions.",
    pinned: true,
    readOnly: false,
    scope: "global",
  },
  {
    label: "tool_guidelines",
    content: "",
    sizeLimit: 1500,
    description:
      "Rules the agent should follow when picking or sequencing tools (e.g. prefer X over Y, never run Z without confirmation).",
    pinned: true,
    readOnly: false,
    scope: "global",
  },
  {
    label: "project_context",
    content: "",
    sizeLimit: 3000,
    description:
      "Architecture decisions, codebase conventions, build/test commands, and cross-cutting constraints for the current project.",
    pinned: true,
    readOnly: false,
    scope: "project",
  },
  {
    label: "guidance",
    content: "",
    sizeLimit: 1500,
    description:
      "Active advice for the next session: what to focus on, what to avoid, open risks.",
    pinned: true,
    readOnly: false,
    scope: "project",
  },
  {
    label: "pending_items",
    content: "",
    sizeLimit: 2000,
    description:
      "Unfinished work, explicit TODOs, and promises made but not yet delivered.",
    pinned: true,
    readOnly: false,
    scope: "project",
  },
  {
    label: "session_patterns",
    content: "",
    sizeLimit: 1500,
    description:
      "Recurring behaviours and common struggles observed across recent sessions.",
    pinned: false,
    readOnly: false,
    scope: "project",
  },
  {
    label: "self_notes",
    content: "",
    sizeLimit: 1500,
    description:
      "Free-form notes the agent keeps for itself: hypotheses, dead ends, things to revisit.",
    pinned: false,
    readOnly: false,
    scope: "project",
  },
];

// Read merged env so values loaded from ~/.agentmemory/.env are
// honoured. process.env alone misses .env-only exports (#678).
export function isSlotsEnabled(): boolean {
  return getEnvVar("AGENTMEMORY_SLOTS") === "true";
}

export function isReflectEnabled(): boolean {
  return getEnvVar("AGENTMEMORY_REFLECT") === "true";
}

// A project slot lives in its project's own scope (rohitg00/agentmemory#1108).
// Callers only ask for the project scope once they hold a project.
function scopeKv(scope: SlotScope, project?: string): string {
  return scope === "global" ? KV.globalSlots : KV.projectSlots(project as string);
}

function validateProject(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed || undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

function validateLabel(label: unknown): string | null {
  if (typeof label !== "string") return null;
  const trimmed = label.trim();
  if (!trimmed || trimmed.length > 64) return null;
  if (!/^[a-z][a-z0-9_]*$/.test(trimmed)) return null;
  return trimmed;
}

async function readSlot(
  kv: StateKV,
  label: string,
  project: string | undefined,
): Promise<{ slot: MemorySlot | null; scope: SlotScope }> {
  if (project) {
    const own = await kv.get<MemorySlot>(KV.projectSlots(project), label);
    if (own) return { slot: own, scope: "project" };
  }
  const global = await kv.get<MemorySlot>(KV.globalSlots, label);
  if (global) return { slot: global, scope: "global" };
  return { slot: null, scope: "project" };
}

function notFound(project: string | undefined, hint = ""): string {
  const missing = project ? "" : " (pass project to reach a project slot)";
  return `slot not found${missing}${hint}`;
}

function validateScope(raw: unknown): SlotScope | null {
  if (raw === undefined || raw === null) return "project";
  if (raw === "project" || raw === "global") return raw;
  return null;
}

function validateSizeLimit(raw: unknown): number | null {
  if (raw === undefined || raw === null) return DEFAULT_SIZE_LIMIT;
  if (typeof raw !== "number") return null;
  if (!Number.isInteger(raw) || raw < 1 || raw > 20000) return null;
  return raw;
}

async function seedDefaults(
  kv: StateKV,
  scope: SlotScope,
  project?: string,
): Promise<void> {
  const ts = nowIso();
  const target = scopeKv(scope, project);
  for (const tmpl of DEFAULT_SLOTS) {
    if (tmpl.scope !== scope) continue;
    const existing = await kv.get<MemorySlot>(target, tmpl.label);
    if (existing) continue;
    const slot: MemorySlot = {
      ...tmpl,
      ...(project ? { project } : {}),
      createdAt: ts,
      updatedAt: ts,
    };
    await kv.set(target, tmpl.label, slot);
  }
}

async function listVisibleSlots(
  kv: StateKV,
  project: string | undefined,
): Promise<MemorySlot[]> {
  const [own, global] = await Promise.all([
    project ? kv.list<MemorySlot>(KV.projectSlots(project)) : Promise.resolve([]),
    kv.list<MemorySlot>(KV.globalSlots),
  ]);
  const merged = new Map<string, MemorySlot>();
  for (const s of global) merged.set(s.label, s);
  for (const s of own) merged.set(s.label, s);
  return Array.from(merged.values()).sort((a, b) => a.label.localeCompare(b.label));
}

export async function listPinnedSlots(
  kv: StateKV,
  project: string | undefined,
): Promise<MemorySlot[]> {
  const slots = await listVisibleSlots(kv, project);
  return slots.filter((s) => s.pinned && s.content.trim().length > 0);
}

export function renderPinnedContext(slots: MemorySlot[]): string {
  if (slots.length === 0) return "";
  const lines: string[] = ["# agentmemory pinned slots", ""];
  for (const slot of slots) {
    lines.push(`## ${slot.label}`);
    lines.push(slot.content.trim());
    lines.push("");
  }
  return lines.join("\n");
}

export function registerSlotsFunctions(sdk: ISdk, kv: StateKV): void {
  void seedDefaults(kv, "global").catch((err) => {
    logger.warn("slot defaults seed failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // Project defaults are seeded on a project's first slot call in this
  // process, the same once-per-boot cadence the global defaults get.
  const seededProjects = new Set<string>();
  async function useProject(raw: unknown): Promise<string | undefined> {
    const project = validateProject(raw);
    if (project && !seededProjects.has(project)) {
      await seedDefaults(kv, "project", project);
      seededProjects.add(project);
    }
    return project;
  }

  sdk.registerFunction("mem::slot-list", async (data?: { project?: string }) => {
    const project = await useProject(data?.project);
    const [slots, flat] = await Promise.all([
      listVisibleSlots(kv, project),
      kv.list<MemorySlot>(KV.legacySlots),
    ]);
    const legacy = flat
      .filter((s) => s.content.trim().length > 0)
      .sort((a, b) => a.label.localeCompare(b.label));
    return { success: true, slots, legacy };
  });

  sdk.registerFunction(
    "mem::slot-get",
    async (data: { label?: string; project?: string }) => {
      const label = validateLabel(data?.label);
      if (!label) return { success: false, error: "label required (lowercase, starts with letter, [a-z0-9_])" };
      const project = await useProject(data?.project);
      const { slot, scope } = await readSlot(kv, label, project);
      if (!slot) return { success: false, error: notFound(project) };
      return { success: true, slot, scope };
    },
  );

  sdk.registerFunction(
    "mem::slot-create",
    async (data: {
      label?: string;
      content?: string;
      sizeLimit?: number;
      description?: string;
      pinned?: boolean;
      scope?: SlotScope;
      project?: string;
    }) => {
      data = scrubFields(data, "content", "description");
      const label = validateLabel(data?.label);
      if (!label) return { success: false, error: "label required (lowercase, starts with letter, [a-z0-9_])" };
      const scope = validateScope(data?.scope);
      if (!scope) return { success: false, error: "scope must be 'project' or 'global'" };
      const project = await useProject(data?.project);
      if (scope === "project" && !project) {
        return { success: false, error: "project required for a project-scoped slot" };
      }
      const sizeLimit = validateSizeLimit(data?.sizeLimit);
      if (sizeLimit === null) {
        return { success: false, error: "sizeLimit must be an integer between 1 and 20000" };
      }
      const content = typeof data?.content === "string" ? data.content : "";
      if (content.length > sizeLimit) {
        return { success: false, error: `content exceeds sizeLimit (${content.length} > ${sizeLimit})` };
      }
      const description = typeof data?.description === "string" ? data.description : "";
      const pinned = typeof data?.pinned === "boolean" ? data.pinned : true;
      return withKeyedLock(`slot:${label}`, async () => {
        // Duplicate check is scope-local so a project slot can shadow a
        // global slot with the same label — matches the read precedence.
        const target = scopeKv(scope, project);
        const existing = await kv.get<MemorySlot>(target, label);
        if (existing) return { success: false, error: `slot already exists in ${scope} scope` };
        const ts = nowIso();
        const slot: MemorySlot = {
          label,
          content,
          sizeLimit: sizeLimit as number,
          description,
          pinned,
          readOnly: false,
          scope,
          ...(scope === "project" ? { project } : {}),
          createdAt: ts,
          updatedAt: ts,
        };
        await kv.set(target, label, slot);
        await recordAudit(kv, "slot_create", "mem::slot-create", [label], {
          scope,
          project: slot.project,
          sizeLimit: slot.sizeLimit,
          pinned: slot.pinned,
        });
        return { success: true, slot };
      });
    },
  );

  sdk.registerFunction(
    "mem::slot-append",
    async (data: { label?: string; text?: string; project?: string }) => {
      data = scrubFields(data, "text");
      const label = validateLabel(data?.label);
      if (!label) return { success: false, error: "label required" };
      const text = typeof data?.text === "string" ? data.text : "";
      if (!text) return { success: false, error: "text required" };
      const project = await useProject(data?.project);
      return withKeyedLock(`slot:${label}`, async () => {
        const { slot, scope } = await readSlot(kv, label, project);
        if (!slot) return { success: false, error: notFound(project, " (use mem::slot-create first)") };
        if (slot.readOnly) return { success: false, error: "slot is read-only" };
        const sep = slot.content && !slot.content.endsWith("\n") ? "\n" : "";
        const next = `${slot.content}${sep}${text}`;
        if (next.length > slot.sizeLimit) {
          return {
            success: false,
            error: `append would exceed sizeLimit (${next.length} > ${slot.sizeLimit}). Use mem::slot-replace to compact first.`,
            currentSize: slot.content.length,
            sizeLimit: slot.sizeLimit,
          };
        }
        const updated: MemorySlot = { ...slot, content: next, updatedAt: nowIso() };
        await kv.set(scopeKv(scope, project), label, updated);
        await recordAudit(kv, "slot_append", "mem::slot-append", [label], {
          scope,
          project: slot.project,
          added: text.length,
          total: next.length,
        });
        return { success: true, slot: updated, size: next.length };
      });
    },
  );

  sdk.registerFunction(
    "mem::slot-replace",
    async (data: { label?: string; content?: string; project?: string }) => {
      data = scrubFields(data, "content");
      const label = validateLabel(data?.label);
      if (!label) return { success: false, error: "label required" };
      const content = data?.content;
      if (typeof content !== "string") return { success: false, error: "content required (string)" };
      const project = await useProject(data?.project);
      return withKeyedLock(`slot:${label}`, async () => {
        const { slot, scope } = await readSlot(kv, label, project);
        if (!slot) return { success: false, error: notFound(project, " (use mem::slot-create first)") };
        if (slot.readOnly) return { success: false, error: "slot is read-only" };
        if (content.length > slot.sizeLimit) {
          return {
            success: false,
            error: `content exceeds sizeLimit (${content.length} > ${slot.sizeLimit})`,
            sizeLimit: slot.sizeLimit,
          };
        }
        const updated: MemorySlot = { ...slot, content, updatedAt: nowIso() };
        await kv.set(scopeKv(scope, project), label, updated);
        await recordAudit(kv, "slot_replace", "mem::slot-replace", [label], {
          scope,
          project: slot.project,
          before: slot.content.length,
          after: content.length,
        });
        return { success: true, slot: updated, size: content.length };
      });
    },
  );

  sdk.registerFunction(
    "mem::slot-delete",
    async (data: { label?: string; project?: string }) => {
      const label = validateLabel(data?.label);
      if (!label) return { success: false, error: "label required" };
      const project = await useProject(data?.project);
      return withKeyedLock(`slot:${label}`, async () => {
        const { slot, scope } = await readSlot(kv, label, project);
        if (!slot) return { success: false, error: notFound(project) };
        if (slot.readOnly) return { success: false, error: "slot is read-only" };
        await kv.delete(scopeKv(scope, project), label);
        await recordAudit(kv, "slot_delete", "mem::slot-delete", [label], {
          scope,
          project: slot.project,
          size: slot.content.length,
        });
        return { success: true };
      });
    },
  );

  sdk.registerFunction(
    "mem::slot-reflect",
    async (data: { sessionId?: string; maxObservations?: number }) => {
      if (!data?.sessionId || typeof data.sessionId !== "string") {
        return { success: false, error: "sessionId required" };
      }
      const max =
        typeof data.maxObservations === "number" &&
        Number.isInteger(data.maxObservations) &&
        data.maxObservations > 0
          ? Math.min(200, data.maxObservations)
          : 50;
      const observations = await kv.list<CompressedObservation>(
        KV.observations(data.sessionId),
      );
      if (observations.length === 0) {
        return { success: true, applied: 0, reason: "no observations for session" };
      }
      const session = await kv.get<Session>(KV.sessions, data.sessionId);
      const project = await useProject(session?.project);
      if (!project) {
        return { success: true, applied: 0, reason: "session has no project" };
      }
      const recent = observations
        .slice()
        .sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""))
        .slice(0, max);

      const pendingLines: string[] = [];
      const patternCounts = new Map<string, number>();
      const files = new Set<string>();
      for (const obs of recent) {
        const title = (obs.title || "").toLowerCase();
        const narrative = (obs.narrative || "").toLowerCase();
        if (narrative.includes("todo") || title.includes("todo")) {
          pendingLines.push(`- ${obs.title || obs.id}`);
        }
        if (obs.type === "error") {
          patternCounts.set("errors", (patternCounts.get("errors") ?? 0) + 1);
        }
        if (obs.type === "command_run") {
          patternCounts.set("commands", (patternCounts.get("commands") ?? 0) + 1);
        }
        if (obs.files) for (const f of obs.files) files.add(f);
      }

      let applied = 0;

      if (pendingLines.length > 0) {
        const pendingApplied = await withKeyedLock(`slot:pending_items`, async () => {
          const { slot, scope } = await readSlot(kv, "pending_items", project);
          if (!slot) return false;
          const already = new Set(slot.content.split("\n"));
          const fresh = pendingLines.filter((line) => !already.has(line));
          if (fresh.length === 0) return false;
          const sep = slot.content && !slot.content.endsWith("\n") ? "\n" : "";
          const next = `${slot.content}${sep}${fresh.join("\n")}`;
          const truncated = next.length > slot.sizeLimit
            ? next.slice(next.length - slot.sizeLimit)
            : next;
          await kv.set(scopeKv(scope, project), "pending_items", {
            ...slot,
            content: truncated,
            updatedAt: nowIso(),
          });
          return true;
        });
        if (pendingApplied) applied++;
      }

      if (patternCounts.size > 0) {
        const patternsApplied = await withKeyedLock(`slot:session_patterns`, async () => {
          const { slot, scope } = await readSlot(kv, "session_patterns", project);
          if (!slot) return false;
          const summary = [
            `last reflection: ${nowIso()}`,
            ...Array.from(patternCounts.entries()).map(
              ([kind, count]) => `- ${kind}: ${count} in last ${recent.length} observations`,
            ),
          ].join("\n");
          const next =
            summary.length > slot.sizeLimit ? summary.slice(0, slot.sizeLimit) : summary;
          await kv.set(scopeKv(scope, project), "session_patterns", {
            ...slot,
            content: next,
            updatedAt: nowIso(),
          });
          return true;
        });
        if (patternsApplied) applied++;
      }

      if (files.size > 0) {
        const ctxApplied = await withKeyedLock(`slot:project_context`, async () => {
          const { slot, scope } = await readSlot(kv, "project_context", project);
          if (!slot) return false;
          const already = slot.content;
          const fresh = Array.from(files)
            .filter((f) => !already.includes(f))
            .slice(0, 20);
          if (fresh.length === 0) return false;
          const header =
            already.length === 0 ? "Files touched in recent sessions:" : "";
          const sep = already && !already.endsWith("\n") ? "\n" : "";
          const nextRaw = `${already}${sep}${header ? header + "\n" : ""}${fresh
            .map((f) => `- ${f}`)
            .join("\n")}`;
          const next =
            nextRaw.length > slot.sizeLimit
              ? nextRaw.slice(nextRaw.length - slot.sizeLimit)
              : nextRaw;
          await kv.set(scopeKv(scope, project), "project_context", {
            ...slot,
            content: next,
            updatedAt: nowIso(),
          });
          return true;
        });
        if (ctxApplied) applied++;
      }

      if (applied > 0) {
        await recordAudit(kv, "slot_reflect", "mem::slot-reflect", [data.sessionId], {
          observationCount: recent.length,
          slotsUpdated: applied,
        });
      }

      return { success: true, applied, observationsReviewed: recent.length };
    },
  );
}
