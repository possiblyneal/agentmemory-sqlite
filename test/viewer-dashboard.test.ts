import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const viewer = readFileSync("src/viewer/index.html", "utf-8");

function sourceOf(name: string): string {
  const start = viewer.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = viewer.indexOf("{", start); i < viewer.length; i++) {
    if (viewer[i] === "{") depth++;
    if (viewer[i] === "}" && --depth === 0) return viewer.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function load(names: string[], globals: Record<string, unknown> = {}) {
  const context = vm.createContext({ ...globals });
  vm.runInContext(names.map(sourceOf).join("\n"), context);
  return context as Record<string, any>;
}

describe("viewer dashboard refresh coalescing", () => {
  afterEach(() => vi.useRealTimers());

  it("a burst of live events yields one refresh per interval", () => {
    vi.useFakeTimers();
    const loadDashboard = vi.fn();
    const ctx = load(["scheduleDashboardRefresh"], {
      state: { activeTab: "dashboard" },
      loadDashboard,
      setTimeout,
      Date,
      dashboardRefreshTimer: null,
      dashboardLastRefreshAt: 0,
      DASHBOARD_REFRESH_INTERVAL_MS: 5000,
    });
    for (let i = 0; i < 50; i++) ctx.scheduleDashboardRefresh();
    vi.advanceTimersByTime(1);
    expect(loadDashboard).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 50; i++) ctx.scheduleDashboardRefresh();
    vi.advanceTimersByTime(4000);
    expect(loadDashboard).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1500);
    expect(loadDashboard).toHaveBeenCalledTimes(2);
  });

  it("live events no longer call loadDashboard directly", () => {
    expect(sourceOf("routeWsMessage")).not.toMatch(/loadDashboard\(/);
  });
});

describe("viewer dashboard rendering helpers", () => {
  const ctx = load(["tagList", "summaryText"]);

  it("renders a legacy string tag field as a list", () => {
    expect(ctx.tagList("bug, auth")).toEqual(["bug", "auth"]);
    expect(ctx.tagList(["a"])).toEqual(["a"]);
    expect(ctx.tagList(undefined)).toEqual([]);
  });

  it("reads the text of an object session summary", () => {
    expect(ctx.summaryText({ title: "T", narrative: "Did the thing" })).toBe("Did the thing");
    expect(ctx.summaryText({ title: "T" })).toBe("T");
    expect(ctx.summaryText("plain")).toBe("plain");
    expect(ctx.summaryText(undefined)).toBe("");
  });

  it("the Memories tile reads the response total, not the page length", () => {
    expect(viewer).toMatch(/d\.memoriesTotal !== undefined \? d\.memoriesTotal : d\.memories\.length/);
    expect(viewer).toContain("state.dashboard.memoriesTotal = results[2] && results[2].total");
  });
});
