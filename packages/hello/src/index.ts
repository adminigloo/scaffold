/**
 * Throwaway package. Exists only to prove the publish pipeline works:
 * workspace resolution -> build -> changeset -> version -> publish ->
 * install from the registry. Delete the whole package afterwards so
 * @adminigloo/env can start clean at 0.1.0.
 */
export function hello(name = "world"): string {
  return `hello, ${name}`;
}

export const PIPELINE_PROOF = "adminigloo-scaffold" as const;
