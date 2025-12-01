import {
  Array,
  Context,
  Effect,
  LogLevel,
  Option,
  Ref,
  Pipeable,
  pipe,
  Logger,
  Tracer as EffectTracer,
  HashMap,
} from "effect";
import { Tracer, Resource } from "@effect/opentelemetry";

export const NoopTracer = EffectTracer.make({
  span: () => ({
    _tag: "Span",
    name: "",
    spanId: "",
    traceId: "",
    parent: Option.none(),
    context: Context.empty(),
    status: { code: "UNSET" } as any,
    attributes: new Map<string, unknown>(),
    links: [],
    sampled: false,
    kind: "internal" as const,
    end(): void {},
    attribute(): void {},
    event(): void {},
    addLinks(): void {},
  }),
  context: f => f(),
});

export type FmtLogData = Omit<ObserveLogData, "level"> & {
  level: string;
};

const fmtLogData = (data: ObserveLogData): FmtLogData => ({
  ...data,
  level: data.level.label,
});

const toLogData = <A>(
  logged: Observed<A>,
  annotations?: HashMap.HashMap<string, unknown>
): ObserveLogData => ({
  ...logged.logData,
  aux: {
    arg: logged.value.safeToLog(),
    ...logged.logData.aux,
    ...(annotations
      ? { annotations: Object.fromEntries(HashMap.toEntries(annotations)) }
      : {}),
  },
});

const flattenNameSpaceObj = (
  ns: string,
  obj: Record<string, unknown> | string
): Record<string, unknown> =>
  typeof obj === "string"
    ? { [ns]: obj }
    : Object.fromEntries(
        Object.entries(obj).map(([k, v]) => [`${ns}.${k}`, v])
      );

const toSpanAttributes = <A>(logged: Observed<A>, error?: SafeToLogError) => ({
  ...flattenNameSpaceObj("aux", logged.logData.aux),
  ...flattenNameSpaceObj("arg", logged.value.safeToLog()),
  msg: logged.logData.message,
  ...(error && flattenNameSpaceObj("errorData", error.safeToLog())),
});

export class ObserveLoggingConfig {
  private type: "LoggingConfig" = "LoggingConfig";

  constructor(
    public autoFlush: (logs: ObserveLogStateData) => boolean,
    public flush: (
      logs: ObserveLogStateData
    ) => Effect.Effect<void, never, never>,
    public filter: (
      config: ObserveLoggingConfig,
      logs: ObserveLogStateData
    ) => ObserveLogStateData,
    public minLevel: LogLevel.LogLevel,
    public configureEffect: <A, E, R>(
      effect: Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E, R>
  ) {}

  withAutoFlush = (
    autoFlush: (logs: ObserveLogStateData) => boolean
  ): ObserveLoggingConfig =>
    new ObserveLoggingConfig(
      autoFlush,
      this.flush,
      this.filter,
      this.minLevel,
      this.configureEffect
    );

  withFlush = (
    flush: (logs: ObserveLogStateData) => Effect.Effect<void, never, never>
  ): ObserveLoggingConfig =>
    new ObserveLoggingConfig(
      this.autoFlush,
      flush,
      this.filter,
      this.minLevel,
      this.configureEffect
    );

  withFilter = (
    filter: (
      config: ObserveLoggingConfig,
      logs: ObserveLogStateData
    ) => ObserveLogStateData
  ): ObserveLoggingConfig =>
    new ObserveLoggingConfig(
      this.autoFlush,
      this.flush,
      filter,
      this.minLevel,
      this.configureEffect
    );

  withMinLevel = (minLevel: LogLevel.LogLevel): ObserveLoggingConfig =>
    new ObserveLoggingConfig(
      this.autoFlush,
      this.flush,
      this.filter,
      minLevel,
      this.configureEffect
    );

  withConfigureEffect = (
    configureEffect: <A, E, R>(
      effect: Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E, R>
  ): ObserveLoggingConfig =>
    new ObserveLoggingConfig(
      this.autoFlush,
      this.flush,
      this.filter,
      this.minLevel,
      configureEffect
    );

  static flushAllOnError = (
    config: ObserveLoggingConfig,
    logState: ObserveLogStateData
  ): ObserveLogStateData =>
    Array.findFirst(logState.logs, log => log.level === LogLevel.Error).pipe(
      Option.match({
        onNone: () =>
          Array.filter(
            logState.logs,
            log => log.level.ordinal >= config.minLevel.ordinal
          ),
        onSome: _ => logState.logs,
      }),
      logs => ({ ...logState, logs })
    );

  // TODO - timestamps on logdata
  static default = (): ObserveLoggingConfig =>
    new ObserveLoggingConfig(
      logState => logState.logs.length >= 100,
      logState =>
        Effect.forEach(
          [...logState.logs, logState.context],
          ({ level, ...logData }) => Effect.logWithLevel(level, logData)
        ),
      ObserveLoggingConfig.flushAllOnError,
      LogLevel.Info,
      x =>
        x.pipe(
          Effect.provide(Logger.json),
          Logger.withMinimumLogLevel(LogLevel.Debug),
          Effect.provide(Tracer.layerGlobal),
          Effect.provide(Resource.layerFromEnv())
        )
    );

  static make = (
    flush: (logs: ObserveLogStateData) => Effect.Effect<void, never, never>
  ): ObserveLoggingConfig => ObserveLoggingConfig.default().withFlush(flush);
}

export type ObserveLogStateData = {
  logs: ObserveLogData[];
  context: ObserveLogData;
};

const maxLevel = (a: LogLevel.LogLevel, b: LogLevel.LogLevel) =>
  a.ordinal >= b.ordinal ? (a === LogLevel.None ? b : a) : b;

// TODO - consider restructure to demote context from
// implying a fiber safe top level state
export class ObserveLogState extends Context.Tag("LogState")<
  ObserveLogState,
  {
    logState: Ref.Ref<ObserveLogStateData>;
    loggingConfig: ObserveLoggingConfig;
  }
>() {
  public static appendLog = (
    logged: Observed<any>
  ): Effect.Effect<{}, never, ObserveLogState> =>
    Effect.Do.pipe(
      Effect.bind("ls", () => ObserveLogState),
      Effect.bind("annotations", () => Effect.logAnnotations),
      Effect.tap(({ ls, annotations }) =>
        Ref.update(ls.logState, data => ({
          context: {
            ...data.context,
            level: maxLevel(logged.logData.level, data.context.level),
          },
          logs: [...data.logs, toLogData(logged, annotations)],
        }))
      ),
      Effect.bind("logs", ({ ls }) => Ref.get(ls.logState)),
      Effect.flatMap(({ ls, logs }) =>
        ls.loggingConfig.autoFlush(logs)
          ? ObserveLogState.flushLogs()
          : Effect.succeed({})
      )
    );

  public static flushLogs = (): Effect.Effect<{}, never, ObserveLogState> =>
    Effect.Do.pipe(
      Effect.bind("ls", () => ObserveLogState),
      Effect.bind("logs", ({ ls }) => Ref.get(ls.logState)),
      Effect.bind("_flushed", ({ ls, logs }) =>
        ls.loggingConfig
          .flush(ls.loggingConfig.filter(ls.loggingConfig, logs))
          .pipe(x => x)
      ),
      Effect.bind("_updated", ({ ls }) =>
        Ref.update(ls.logState, data => ({ ...data, logs: [] }))
      ),
      Effect.map(_ => ({}))
    );

  public static getLogState = (): Effect.Effect<
    ObserveLogStateData,
    never,
    ObserveLogState
  > => ObserveLogState.pipe(Effect.flatMap(ls => Ref.get(ls.logState)));

  public static getLogs = (): Effect.Effect<
    FmtLogData[],
    never,
    ObserveLogState
  > =>
    ObserveLogState.getLogState().pipe(Effect.map(x => x.logs.map(fmtLogData)));
}

export interface SafeToLogError {
  message: string;
  safeToLog: () => string | Record<string, unknown>;
}

export interface SafeToLog<A> {
  value: () => A;
  safeToLog: () => string | Record<string, unknown>;
}

export const SafeToLog = {
  make:
    <A>(f: (value: A) => string | Record<string, unknown>) =>
    (a: A) =>
      new SafeToLogOf(() => a, f),

  tag:
    (key: string) =>
    <A>(a: SafeToLogOf<A>) =>
      a.tag(key),

  tagged:
    <A>(key: string, f: (value: A) => string | Record<string, unknown>) =>
    (a: A) =>
      pipe(a, SafeToLog.make(f), SafeToLog.tag(key)),

  map: <A, B>(a: SafeToLog<A>, f: (x: A) => B): SafeToLog<B> =>
    new SafeToLogOf(() => f(a.value()), a.safeToLog),
};

export class SafeToLogOf<A> extends Pipeable.Class() implements SafeToLog<A> {
  private type: "SafeToLogOf" = "SafeToLogOf";
  constructor(
    public value: () => A,
    public safeToLog_: (value: A) => string | Record<string, unknown>
  ) {
    super();
  }

  safeToLog = (): string | Record<string, unknown> =>
    this.safeToLog_(this.value());

  tag = (key: string): SafeToLogOf<A> =>
    new SafeToLogOf(
      () => this.value(),
      value => ({ [key]: this.safeToLog_(value) })
    );
}

export type ObserveLogData = {
  message: string;
  level: LogLevel.LogLevel;
  aux: Record<string, unknown>;
  span: string;
};

export class Unit implements SafeToLog<{}> {
  private type: "Unit" = "Unit";

  value = (): {} => ({});
  safeToLog = (): string => "()";
}

export class LogMsg {
  private type: "LogMsg" = "LogMsg";
  constructor(public msg: string) {}

  withSpan = (span: string): Obs<{}> =>
    Obs.fromLogData({
      message: this.msg,
      level: LogLevel.Debug,
      span,
      aux: {},
    });
}

export interface Observed<A> {
  logData: ObserveLogData;
  value: SafeToLog<A>;
}

export class Obs<A> extends Pipeable.Class() {
  private type: "Obs" = "Obs";

  private constructor(
    public logData: ObserveLogData,
    public value: SafeToLog<A>
  ) {
    super();
  }

  static fromLogData = (logData: ObserveLogData): Obs<{}> =>
    new Obs(logData, new Unit());

  static log = (msg: string): LogMsg => new LogMsg(msg);

  withAux = (aux: Record<string, unknown>): Obs<A> =>
    new Obs(
      {
        ...this.logData,
        aux: {
          ...this.logData.aux,
          ...aux,
        },
      },
      this.value
    );

  withLevel = (level: LogLevel.LogLevel): Obs<A> =>
    new Obs({ ...this.logData, level }, this.value);

  map = <B>(f: (x: A) => B): Obs<B> =>
    new Obs(this.logData, SafeToLog.map(this.value, f));

  withInput = <B>(input: SafeToLog<B>): Obs<B> => new Obs(this.logData, input);

  handleError = <E extends SafeToLogError | never>(
    handleErr: (e: unknown) => E
  ): ObsWithErrHandler<A, E> =>
    ObsWithErrHandler.make(this.logData, this.value, handleErr);

  runEffect = <B, E extends SafeToLogError | never, R>(
    f: (a: A) => Effect.Effect<B, E, R | ObserveLogState>
  ): Observe<B, E, R> => Observe.runEffect(this, f);

  runObserve = <B, E extends SafeToLogError | never, R>(
    f: (a: A) => Observe<B, E, R>
  ): Observe<B, E, R> => this.runEffect(x => f(x).pipe(Obs.toEffect));

  static Do = () => Observe.fromEffect(Effect.Do);

  static toEffect = <A, E extends SafeToLogError | never, R>(
    self: Observe<A, E, R>
  ): Effect.Effect<A, E, R | ObserveLogState> => self.run();

  static map =
    <A, B, E extends SafeToLogError | never, R>(f: (x: A) => B) =>
    (self: Observe<A, E, R>): Observe<B, E, R> =>
      self.mapEffect(x => x.pipe(Effect.map(f)));

  static flatMap =
    <
      A,
      B,
      E extends SafeToLogError | never,
      E2 extends SafeToLogError | never,
      R,
      R2
    >(
      f: (x: A) => Observe<B, E2, R2>
    ) =>
    (self: Observe<A, E, R>): Observe<B, E | E2, R | R2> =>
      Observe.fromEffect(self.run().pipe(Effect.flatMap(x => f(x).run())));

  static override bind =
    <
      K extends string,
      A extends object,
      R2,
      E2 extends SafeToLogError | never,
      B
    >(
      name: Exclude<K, keyof A>,
      f: (ctx: A) => Observe<B, E2, R2>
    ) =>
    <R, E extends SafeToLogError | never>(
      eff: Observe<A, E, R>
    ): Observe<
      { [K1 in K | keyof A]: K1 extends keyof A ? A[K1] : B },
      E2 | E,
      R2 | R
    > =>
      Observe.fromEffect(eff.run().pipe(Effect.bind(name, x => f(x).run())));

  static silenceSpans = <A, E extends SafeToLogError | never, R>(
    self: Observe<A, E, R>
  ): Observe<A, E, R> =>
    self.pipe(Obs.mapEffect(Effect.withTracer(NoopTracer)));

  static fromEffect = <R, E extends SafeToLogError | never, A>(
    effect: Effect.Effect<A, E, R | ObserveLogState>
  ): Observe<A, E, R> => Observe.fromEffect(effect);

  static mapEffect =
    <
      A,
      B,
      E extends SafeToLogError | never,
      E2 extends SafeToLogError | never,
      R,
      R2
    >(
      map: (
        x: Effect.Effect<A, E, R | ObserveLogState>
      ) => Effect.Effect<B, E2, R2 | ObserveLogState>
    ) =>
    (self: Observe<A, E, R>): Observe<B, E2, R2> =>
      self.mapEffect(map);

  static toPromise =
    <E extends SafeToLogError | never, A>(
      logged: Observed<{}>,
      loggingConfig: ObserveLoggingConfig = ObserveLoggingConfig.default()
    ) =>
    (trk: Observe<A, E, ObserveLogState>): Promise<A> =>
      trk.run().pipe(
        Effect.either,
        Effect.withSpan(logged.logData.span),
        Effect.tap(_ => ObserveLogState.flushLogs()),
        Effect.provideServiceEffect(
          ObserveLogState,
          Ref.make<ObserveLogStateData>({
            context: logged.logData,
            logs: [],
          }).pipe(Effect.map(ls => ({ logState: ls, loggingConfig })))
        ),
        loggingConfig.configureEffect,
        Effect.flatMap(x => x),
        Effect.runPromise
      );

  static annotate =
    (annotations: Record<string, string>) =>
    <A, E extends SafeToLogError | never, R>(
      obs: Observe<A, E, R>
    ): Observe<A, E, R> =>
      obs.mapEffect(Effect.annotateLogs(annotations));
}

export class ObsWithErrHandler<
  A,
  E extends SafeToLogError | never
> extends Pipeable.Class() {
  private type: "ObsWithErrHandler" = "ObsWithErrHandler";
  private constructor(
    public logData: ObserveLogData,
    public value: SafeToLog<A>,
    public handleErr: (e: unknown) => E
  ) {
    super();
  }

  static make = <A, E extends SafeToLogError | never>(
    logData: ObserveLogData,
    value: SafeToLog<A>,
    handleErr: (e: unknown) => E
  ) => new ObsWithErrHandler(logData, value, handleErr);

  toObs = (): Obs<A> => Obs.fromLogData(this.logData).withInput(this.value);

  runPromise = <B>(f: (a: A) => Promise<B>): Observe<B, E, never> =>
    this.toObs().runEffect(a =>
      Effect.tryPromise({
        try: () => f(this.value.value()),
        catch: e => this.handleErr(e),
      })
    );

  runTry = <B>(f: (a: A) => B): Observe<B, E, never> =>
    this.toObs().runEffect(a =>
      Effect.try({
        try: () => f(this.value.value()),
        catch: e => this.handleErr(e),
      })
    );
}

export class Observe<
  A,
  E extends SafeToLogError | never,
  R
> extends Pipeable.Class() {
  private type: "Observe" = "Observe";
  private constructor(
    public run: () => Effect.Effect<A, E, R | ObserveLogState>
  ) {
    super();
  }

  static runEffect = <A, B, E extends SafeToLogError | never, R>(
    obs: Obs<A>,
    f: (a: A) => Effect.Effect<B, E, R | ObserveLogState>
  ): Observe<B, E, R> =>
    new Observe(() =>
      pipe(
        ObserveLogState.appendLog(obs),
        Effect.flatMap(_ => f(obs.value.value())),
        Effect.tapError(error =>
          ObserveLogState.appendLog(
            obs.withLevel(LogLevel.Error).withAux({
              error: error.safeToLog(),
            })
          )
        ),
        Effect.tap(_ => Effect.annotateCurrentSpan(toSpanAttributes(obs))),
        Effect.tapError(_ =>
          Effect.annotateCurrentSpan(toSpanAttributes(obs, _))
        ),
        Effect.withSpan(obs.logData.span)
      )
    );

  static fromEffect = <R, E extends SafeToLogError | never, A>(
    effect: Effect.Effect<A, E, R | ObserveLogState>
  ): Observe<A, E, R> => new Observe(() => effect);

  mapEffect = <B, E2 extends SafeToLogError | never, R2>(
    map: (
      x: Effect.Effect<A, E, R | ObserveLogState>
    ) => Effect.Effect<B, E2, R2 | ObserveLogState>
  ): Observe<B, E2, R2> => new Observe(() => map(this.run()));
}
