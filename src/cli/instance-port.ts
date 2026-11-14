const BASE_REST_PORT = 3111;
const BLOCK_SIZE = 100;
const BLOCK_PORTS = 3;
const MAX_PORT = 65535;

export const MAX_INSTANCE = Math.floor(
  (MAX_PORT - BASE_REST_PORT - (BLOCK_PORTS - 1)) / BLOCK_SIZE,
);

export type InstanceResolution =
  | { ok: true; restPort: number }
  | { ok: false; message: string };

export function resolveInstancePort(value: string | undefined): InstanceResolution {
  if (value === undefined || !/^\d+$/.test(value) || Number(value) > MAX_INSTANCE) {
    return {
      ok: false,
      message: `Invalid --instance value ${JSON.stringify(value ?? "")}: expected an integer from 0 to ${MAX_INSTANCE}.`,
    };
  }
  return { ok: true, restPort: BASE_REST_PORT + Number(value) * BLOCK_SIZE };
}
