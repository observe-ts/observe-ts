import { NodeSDK } from "@opentelemetry/sdk-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ConsoleSpanExporter } from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { Effect, LogLevel, pipe } from "effect";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { Obs, SafeToLog, SafeToLogError } from "../index";
import { trace } from "@opentelemetry/api";
import { NodeSdk } from "@effect/opentelemetry";

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    "service.name": "observable-ts",
    "service.version": "0.0.1",
  }),
  traceExporter: new ConsoleSpanExporter(),
});

beforeAll(async () => {
  console.log("starting sdk");
  await sdk.start();
});

afterAll(async () => {
  await sdk.shutdown();
});

class MyArg implements SafeToLog<string> {
  constructor(public readonly value: () => string) {}

  safeToLog = () => ({ argType: "MyArg", argValue: this.value() });
}

class MyError extends Error implements SafeToLogError {
  constructor(public readonly value: unknown) {
    super(`MyError(${value})`);
  }

  safeToLog = () => ({
    errorType: "MyError",
    errorValue: `${this.value}`,
    errorMessage: this.message,
  });
}

describe("Obs", () => {
  it("debug OTEL", () => {
    const tracer = trace.getTracer("debug");
    const span = tracer.startSpan("manual-span");
    span.end();
  });
  it("Builds an observed effect carrier", async () => {
    const result = await Obs.Do().pipe(
      Obs.bind("step1", () =>
        Obs.log("test")
          .withSpan("test")
          .withAux({ argz: { arg: "hi" } })
          .withInput(
            pipe(
              ["hi", "there"],
              SafeToLog.make(s => ({
                inputType: "OnTheFly",
                inputValue: s,
              }))
            )
          )
          .runEffect(strs =>
            Effect.all(
              strs.map(s =>
                pipe(
                  Obs.Do().pipe(
                    Obs.bind("s1", () =>
                      Obs.log("traversing step 1")
                        .withSpan("traversing.step1")
                        .withInput(new MyArg(() => s))
                        .runEffect(Effect.succeed)
                    ),
                    Obs.bind("s2", ({ s1 }) =>
                      Obs.log("traversing step 2")
                        .withSpan("traversing.step2")
                        .withInput(new MyArg(() => `${s1} again`))
                        .runEffect(Effect.succeed)
                    ),
                    Obs.map(({ s2 }) => s2)
                  ),
                  Obs.toEffect
                )
              )
            )
          )
      ),
      Obs.bind("step2", ({ step1 }) =>
        Obs.log("test")
          .withSpan("test")
          .withLevel(LogLevel.Warning)
          .withInput(new MyArg(() => step1.join(",")))
          .handleError(e => new MyError(e))
          .runTry(x => {
            throw new Error(x);
          })
      ),
      Obs.map(({ step2 }) => step2),
      Obs.toEffect,
      Effect.catchAll(x => Effect.succeed(`${x.value}`)),
      Obs.fromEffect,
      Obs.toPromise(Obs.log("run the test").withSpan("run_the_test"))
    );
    expect(result).toBe("Error: hi again,there again");
  });
});
