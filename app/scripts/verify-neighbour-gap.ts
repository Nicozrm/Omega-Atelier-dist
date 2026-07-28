/** Wie weit ist das nächste Nachbarhaus, je nach Plangröße? */
import { generateNeighbourhood, seedForPlan } from '../src/lib/world'
for (const [w, d] of [[12, 10], [20, 16], [40, 34], [60, 50]] as [number, number][]) {
  const world = generateNeighbourhood({
    style: 'de', centre: { x: w / 2, z: d / 2 }, widthM: w, depthM: d,
    detail: 'high', seed: seedForPlan('t', 'de'),
  })
  const c = { x: w / 2, z: d / 2 }
  const dists = world.houses
    .map((h) => Math.hypot(h.centre.x - c.x, h.centre.z - c.z))
    .sort((a, b) => a - b)
  const own = Math.hypot(w, d) / 2
  console.log(`  Plan ${String(w).padStart(2)}×${String(d).padStart(2)} m (Halbdiagonale ${own.toFixed(0)} m)  ` +
    `→ ${world.houses.length} Häuser, nächstes bei ${dists[0]?.toFixed(0) ?? '—'} m, ` +
    `die nächsten fünf: ${dists.slice(0, 5).map((x) => x.toFixed(0)).join(', ')} m`)
}
