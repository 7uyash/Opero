/** Transaction options for anything that takes the round-robin lock: waits patiently under bursts. */
export const ASSIGNMENT_TX = { maxWait: 15_000, timeout: 20_000 } as const;
