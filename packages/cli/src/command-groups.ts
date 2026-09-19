/**
 * Contributed-command rendering: turns a registration's plain-data command
 * declarations into framework commands under a group named after the
 * registration. Each handler is satisfied from its OWN registration's
 * capability implementations plus the engine host and project root, never from
 * another registration's capabilities.
 */
import { Effect, Layer, type Scope } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { attributeFailure } from "./dispatch.ts"
import type { Engine } from "./engine.ts"
import type {
  AnyPluginRegistration,
  CommandDeclaration,
  CommandInput,
  FlagDeclaration,
  PluginError,
} from "./plugin.ts"

const toFlag = (declaration: FlagDeclaration): Flag.Flag<any> => {
  const base: Flag.Flag<any> =
    declaration.kind === "boolean"
      ? Flag.boolean(declaration.name)
      : declaration.kind === "integer"
        ? Flag.integer(declaration.name)
        : Flag.string(declaration.name)
  const described = base.pipe(Flag.withDescription(declaration.description))
  const aliased =
    declaration.alias === undefined ? described : described.pipe(Flag.withAlias(declaration.alias))
  return declaration.optional
    ? aliased.pipe(Flag.optional)
    : declaration.default === undefined
      ? aliased
      : aliased.pipe(Flag.withDefault(declaration.default as never))
}

/** The framework's flag record is built from plain data; the widening cast is the boundary. */
const flagsOf = (declaration: CommandDeclaration): Record<string, Flag.Flag<never>> =>
  Object.fromEntries(
    declaration.flags.map((flag) => [flag.name, toFlag(flag)]),
  ) as Record<string, Flag.Flag<never>>

/** One command group per registration, in registration order. */
export const commandGroups = (engine: Engine) => {
  const runContributed = Effect.fn("runContributed")(function* (
    registration: AnyPluginRegistration,
    declaration: CommandDeclaration,
    input: CommandInput,
  ): Effect.fn.Return<void, PluginError, Scope.Scope> {
    // The handler is provided with its OWN registration's capabilities only:
    // the engine does not merge capability implementations across
    // registrations for the command path.
    const own = yield* Layer.build(registration.capabilities(engine.host))
    return yield* declaration.handler(input).pipe(
      Effect.provide(own),
      attributeFailure(registration.name),
    )
  })

  return engine.registrations.map((registration) =>
    Command.make(registration.name).pipe(
      Command.withDescription(`Commands contributed by the ${registration.name} plugin`),
      Command.withSubcommands(
        registration.commands.map((declaration) =>
          Command.make(declaration.name, flagsOf(declaration), (input: CommandInput) =>
            runContributed(registration, declaration, input),
          ).pipe(Command.withDescription(declaration.description)),
        ),
      ),
    ),
  )
}
