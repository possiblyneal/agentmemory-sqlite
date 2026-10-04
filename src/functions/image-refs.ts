import { TriggerAction, type ISdk } from "../engine/types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { deleteImage, touchImage } from "../utils/image-store.js";
import { withKeyedLock } from "../state/keyed-mutex.js";

export async function getImageRefCount(kv: StateKV, filePath: string): Promise<number> {
  const count = await kv.get<number>(KV.imageRefs, filePath);
  return count ? Number(count) : 0;
}

export async function incrementImageRef(kv: StateKV, filePath: string): Promise<void> {
  return withKeyedLock(`imgRef:${filePath}`, async () => {
    const current = await getImageRefCount(kv, filePath);
    await kv.set(KV.imageRefs, filePath, current + 1);
    await touchImage(filePath);
  });
}

export async function decrementImageRef(kv: StateKV, sdk: ISdk, filePath: string): Promise<void> {
  return withKeyedLock(`imgRef:${filePath}`, async () => {
    const current = await getImageRefCount(kv, filePath);
    if (current <= 1) {
      await kv.delete(KV.imageEmbeddings, filePath);
      await kv.delete(KV.imageRefs, filePath);
      await deleteImageFile(sdk, filePath);
    } else {
      await kv.set(KV.imageRefs, filePath, current - 1);
    }
  });
}

// Writes nothing to KV, so it still cleans up an image when the disk is full.
export async function deleteUnreferencedImage(kv: StateKV, sdk: ISdk, filePath: string): Promise<void> {
  return withKeyedLock(`imgRef:${filePath}`, async () => {
    if ((await getImageRefCount(kv, filePath)) === 0) await deleteImageFile(sdk, filePath);
  });
}

async function deleteImageFile(sdk: ISdk, filePath: string): Promise<void> {
  const { deletedBytes } = await deleteImage(filePath);
  if (deletedBytes > 0) {
    sdk.trigger({
      function_id: "mem::disk-size-delta",
      payload: { deltaBytes: -deletedBytes },
      action: TriggerAction.Void(),
    });
  }
}
