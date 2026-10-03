export type ConnectOptions = {
  dryRun: boolean;
  force: boolean;
};

export type ConnectAdapter = {
  name: string;
  displayName: string;
  docs?: string;
  /**
   * One-line explanation of which protocol this adapter wires (REST hooks vs
   * MCP) and why. Printed above the install summary so users see — before
   * any config mutation — that REST is the primary surface and MCP is the
   * opt-in bridge for MCP-only clients.
   */
  protocolNote?: string;
  /**
   * Integration style, used by onboarding to group agents. "native" =
   * ships a first-party plugin / lifecycle hooks; "mcp" = wires the MCP
   * server only. Declared on the adapter so the picker never needs a
   * separate hardcoded list (#872). Defaults to "mcp" when omitted.
   */
  category?: "native" | "mcp";
  detect(): boolean;
  install(opts: ConnectOptions): Promise<ConnectResult>;
};

export type ConnectResult =
  | { kind: "installed"; mutatedPath?: string; backupPath?: string }
  | { kind: "already-wired"; mutatedPath?: string }
  | { kind: "skipped"; reason: string };
