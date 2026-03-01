/**
 * Fire-and-forget HTTP POST for a beacon batch.
 * `keepalive: true` ensures final beacons survive page unload.
 */
export async function postBeacons(
  endpoint: string,
  projectKey: string,
  batchJson: string,
): Promise<void> {
  await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Project-Key": projectKey,
    },
    body: batchJson,
    keepalive: true,
  });
}
