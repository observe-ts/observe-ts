# observe-ts

Structured, effectful observability for TypeScript programs built on top of `effect`.

```sh
npm install observe-ts effect
```

---

## Observe

`Observe` is an effect type built on top of `Effect` that enforces consistent observability end-to-end.

By accumulating log data and buffering in memory,
it provides increased control and intelligence around
how logs and traces are written.

For example, default behavior is to emit info and
up for a given program evaluation (Obs.toPromise)
_unless_ any error level logs are present, in
which case debug logs are also included.

This kind of behavior is impossible with standard
approaches to logging where side effects occur at the
point a log line is declared.

When you write your program in terms of `Obs`:

- Each step describes _what_ it’s doing (message, span, aux, safe input / error).
- Internally it runs an `Effect`, a `Promise`, or sync code, but always comes back as `Observe`.
- Because the whole pipeline stays in `Obs`, your logs and traces are exhaustive, intelligent, efficient, and map directly to your code.

Only at the boundary (e.g. HTTP handler, worker entrypoint) do you turn the observed program into a plain `Effect` or `Promise` (typically via `Obs.toPromise`) and actually run it, flushing structured logs once.

---

## End-to-end example

An observed program is just your domain logic written in terms of `Obs`:

- Each step declares the span and message for what it’s doing.
- Inputs and errors are wrapped in types that know how to render themselves safely.
- The underlying work still happens in `Effect`, promises, or sync code.

The example below shows a small pipeline that loads some data, transforms it, and then runs it once at the boundary:

```ts
import { Effect, LogLevel, pipe } from "effect";
import { Obs, SafeToLog, SafeToLogError } from "observe-ts";

class RenderError extends Error implements SafeToLogError {
  constructor(public readonly value: unknown) {
    super(`RenderError(${value})`);
  }

  // here's where you would omit sensitive data
  toLogSafeString = () => `RenderError(${this.value})`;
}

class ApiUrl implements SafeToLog<string> {
  constructor(public readonly value: string) {}

  // domain types can control exactly how they appear in logs
  toLogSafeString = () => `ApiUrl(${this.value})`;
}

const program = Obs.Do().pipe(
  // read configuration from disk (Effect)
  Obs.bind("config", () =>
    Obs.log("read config")
      .withSpan("config.read")
      .withInput(
        pipe(
          "./config.json",
          SafeToLog.make(path => `ConfigPath(${path})`)
        )
      )
      .runEffect(input =>
        Effect.tryPromise({
          try: async () => {
            const text = await import("node:fs/promises").then(fs =>
              fs.readFile(input.value, "utf8")
            );
            return JSON.parse(text) as { apiBaseUrl: string };
          },
          catch: e => new Error(String(e)),
        })
      )
  ),

  // fetch a user from an API (Promise)
  Obs.bind("user", ({ config }) =>
    Obs.log("fetch user")
      .withSpan("user.fetch")
      .withInput(
        // using a domain type that implements SafeToLog directly
        new ApiUrl(`${config.apiBaseUrl}/users/123`)
      )
      .handleError(e => new RenderError(e))
      .runPromise(url => fetch(url.value).then(r => r.json()))
  ),

  // render an email body (unsafe sync)
  Obs.bind("email", ({ user }) =>
    Obs.log("render email")
      .withSpan("email.render")
      .withLevel(LogLevel.Info)
      .withInput(
        pipe(
          user,
          SafeToLog.make(u => `User(${u.id})`)
        )
      )
      .handleError(e => new RenderError(e))
      .runTry(u => {
        if (!u.email) throw new Error("missing email");
        return `Hi ${u.name}, welcome back!`;
      })
  ),

  // final projection
  Obs.map(({ email }) => email),

  // collapse to / from Effect for normal Effect composition
  Obs.toEffect,
  Effect.catchAll(err => Effect.succeed(err.toLogSafeString())),
  Obs.fromEffect
);

// At the very edge, run everything and flush JSON logs
const result: string = await program.pipe(
  Obs.toPromise(Obs.log("handle request").withSpan("run_example"))
);
```

This is the shape of an observed program:

- The program you care about is expressed in `Obs`, not in raw logging calls.
- Calls into `Effect` / promises are implementation details inside each step.
- A single boundary (e.g. `Obs.toPromise` in an HTTP handler) is responsible for running the whole thing and flushing logs.

### Default JSON logs

With the default logging config (`LoggingConfig.default()`), logs are emitted via `effect`’s `Logger.json`, based on the log data buffered during the run. A typical entry looks like:

```json
{
  "level": "Info",
  "message": "handle request",
  "span": "run_example",
  "aux": {
    "tag": "example"
  }
}
```

Additional fields from `withAux`, the safe input (`SafeToLog`), and your `SafeToLogError` are merged into `aux`, so you can attach IDs, correlation keys, and safe error strings without leaking sensitive data.
