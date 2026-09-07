import { Effect } from "effect"

export const version = "0.0.1"

export const add = (a: number, b: number): number => a + b

export const addEffect = (a: number, b: number): Effect.Effect<number> => Effect.sync(() => a + b)
