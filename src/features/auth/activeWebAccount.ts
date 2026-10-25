// A browser cache has no owner until Cloud has confirmed the current user.id.
// This is deliberately in memory: a persisted identity hint is not authority.
let activeUserId: string | null = null;
let generation = 0;

export function getActiveWebAccountId(): string | null {
  return activeUserId;
}

export function getWebAccountGeneration(): number {
  return generation;
}

export function setActiveWebAccountId(userId: string | null): void {
  const next = typeof userId === "string" && userId.trim() ? userId.trim() : null;
  if (next === activeUserId) return;
  activeUserId = next;
  generation += 1;
}
