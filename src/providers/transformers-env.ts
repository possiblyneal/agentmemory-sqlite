import { getEnvVar, getModelCacheDir } from "../config.js";

type TransformersModule = typeof import("@huggingface/transformers");

const configured = new WeakSet<object>();

export function configureTransformers(t: TransformersModule): TransformersModule {
  if (!t.env || configured.has(t.env)) return t;
  t.env.cacheDir = getModelCacheDir();
  const mirror = getEnvVar("HF_ENDPOINT");
  if (mirror) t.env.remoteHost = mirror.endsWith("/") ? mirror : `${mirror}/`;
  configured.add(t.env);
  return t;
}
