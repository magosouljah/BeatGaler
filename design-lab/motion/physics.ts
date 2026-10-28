/* Pure motion mathematics: reusable in the isolated Design Lab, no DOM or services. */
export type Vec2 = { x: number; y: number };
export type SpringAxis = { value: number; velocity: number };
export type SpringOptions = { stiffness: number; damping: number; mass: number };
export const DEFAULT_SPRING: SpringOptions = { stiffness: 180, damping: 23, mass: 1 };
export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export function springStep(axis: SpringAxis, target: number, dt: number, options: SpringOptions = DEFAULT_SPRING): SpringAxis {
  const t = clamp(dt, 0, 1 / 30);
  // Semi-implicit Euler with substeps for stable interrupted motion.
  const count = Math.max(1, Math.ceil(t / (1 / 120)));
  const h = t / count;
  let { value, velocity } = axis;
  for (let i = 0; i < count; i++) {
    const acceleration = (options.stiffness * (target - value) - options.damping * velocity) / Math.max(0.1, options.mass);
    velocity += acceleration * h;
    value += velocity * h;
  }
  return { value, velocity };
}
export function springSettled(axis: SpringAxis, target: number, epsilon = 0.3) {
  return Math.abs(axis.value - target) < epsilon && Math.abs(axis.velocity) < epsilon * 6;
}
export function vectorForce(position: Vec2, center: Vec2, radius: number, strength: number, mode: "attract" | "repel"): Vec2 {
  const dx = position.x - center.x, dy = position.y - center.y;
  const distance = Math.hypot(dx, dy);
  if (!distance || distance >= radius) return { x: 0, y: 0 };
  const magnitude = strength * Math.pow(1 - distance / radius, 2) * (mode === "attract" ? -1 : 1);
  return { x: dx / distance * magnitude, y: dy / distance * magnitude };
}
export function inertialProjection(position: number, velocity: number, friction = 5): number {
  return position + velocity / Math.max(.01, friction);
}
export function integrateGravity(position: Vec2, velocity: Vec2, dt: number, gravity = 800, floor = 250, bounce = .55) {
  const step = clamp(dt, 0, 1 / 30);
  let vy = velocity.y + gravity * step;
  const x = position.x + velocity.x * step;
  let y = position.y + vy * step;
  if (y > floor) { y = floor; vy = -Math.abs(vy) * clamp(bounce, 0, 1); }
  return { position: { x, y }, velocity: { x: velocity.x * Math.exp(-step * 0.4), y: vy } };
}
