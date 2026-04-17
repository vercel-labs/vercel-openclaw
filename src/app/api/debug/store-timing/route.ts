import { requireDebugEnabled } from "@/server/auth/debug-guard";
import { requireJsonRouteAuth } from "@/server/auth/route-auth";
import { getInitializedMeta, mutateMeta } from "@/server/store/store";
import { getStore } from "@/server/store/store";
import { jsonOk } from "@/shared/http";

export async function GET(request: Request): Promise<Response> {
  const blocked = requireDebugEnabled();
  if (blocked) return blocked;

  const auth = await requireJsonRouteAuth(request);
  if (auth instanceof Response) return auth;

  const timings: Record<string, number> = {};
  const results: Record<string, unknown> = {};

  let t0 = performance.now();
  await getInitializedMeta();
  timings.getInitializedMetaMs = Math.round((performance.now() - t0) * 100) / 100;

  t0 = performance.now();
  await mutateMeta((m) => m);
  timings.mutateMetaNoOpMs = Math.round((performance.now() - t0) * 100) / 100;

  const store = getStore();
  results.storeBackend = store.name;

  const seqTimings: number[] = [];
  for (let i = 0; i < 5; i++) {
    const s = performance.now();
    await store.getMeta();
    seqTimings.push(Math.round((performance.now() - s) * 100) / 100);
  }
  timings.sequentialGetMetaTotalMs = seqTimings.reduce((a, b) => a + b, 0);
  results.sequentialGetMetaEachMs = seqTimings;

  t0 = performance.now();
  const parallelTimings: number[] = [];
  await Promise.all(
    Array.from({ length: 5 }, async () => {
      const s = performance.now();
      await store.getMeta();
      parallelTimings.push(Math.round((performance.now() - s) * 100) / 100);
    }),
  );
  timings.parallelGetMetaTotalMs = Math.round((performance.now() - t0) * 100) / 100;
  results.parallelGetMetaEachMs = parallelTimings;

  return jsonOk({ timings, results });
}
