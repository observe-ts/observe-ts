import {
  Array,
  Console,
  Context,
  Effect,
  LogLevel,
  Option,
  Ref,
  Pipeable,
  pipe,
  Logger,
} from "effect";

export type FmtLogData = Omit<LogData, "level"> & {
  level: string;
};

const fmtLogData = (data: LogData): FmtLogData => ({
  ...data,
  level: data.level.label,
});

const toLogData = <A>(logged: Logged<A>): LogData => ({
  ...logged.logData,
  aux: {
    arg: logged.value.toLogSafeString(),
    ...logged.logData.aux,
  },
});

export class LoggingConfig {
  private type: "LoggingConfig" = "LoggingConfig";

  constructor(
    public autoFlush: (logs: LogStateData) => boolean,
    public flush: (logs: LogStateData) => Effect.Effect<void, never, never>,
    public filter: (config: LoggingConfig, logs: LogStateData) => LogStateData,
    public minLevel: LogLevel.LogLevel,
    public configureEffect: <A, E, R>(
      effect: Effect.Effect<A, E, R>
    ) => Effect.Effect<A, E, R>
  ) {}

  withAutoFlush = (autoFlush: (logs: LogStateData) => boolean): LoggingConfig =>
    new LoggingConfig(
      autoFlush,
      this.flush,
      this.filter,
      this.minLevel,
      this.configureEffect
    );

  withFlush = (
    flush: (logs: LogStateData) => Effect.Effect<void, never, never>
  ): LoggingConfig =>
    new LoggingConfig(
      this.autoFlush,
      flush,
      this.filter,
      this.minLevel,
      this.configureEffect
    );

  withFilter = (
    filter: (config: LoggingConfig, logs: LogStateData) => LogStateData
  ): LoggingConfig =>
    new LoggingConfig(
      this.autoFlush,
      this.flush,
      filter,
      this.minLevel,
      this.configureEffect
    );

  withMinLevel = (minLevel: LogLevel.LogLevel): LoggingConfig =>
    new LoggingConfig(
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
  ): LoggingConfig =>
    new LoggingConfig(
      this.autoFlush,
      this.flush,
      this.filter,
      this.minLevel,
      configureEffect
    );

  static flushAllOnError = (
    config: LoggingConfig,
    logState: LogStateData
  ): LogStateData =>
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

  static default = (): LoggingConfig =>
    new LoggingConfig(
      logState => logState.logs.length >= 100,
      logState =>
        Effect.forEach(logState.logs, ({ level, ...logData }) =>
          Effect.logWithLevel(level, logData)
        ),
      LoggingConfig.flushAllOnError,
      LogLevel.Info,
      Logger.withMinimumLogLevel(LogLevel.Debug)
    );

  static make = (
    flush: (logs: LogStateData) => Effect.Effect<void, never, never>
  ): LoggingConfig => LoggingConfig.default().withFlush(flush);
}

export type LogStateData = {
  logs: LogData[];
  context: LogData;
};

const maxLevel = (a: LogLevel.LogLevel, b: LogLevel.LogLevel) =>
  a.ordinal >= b.ordinal ? (a === LogLevel.None ? b : a) : b;

class LogState extends Context.Tag("LogState")<
  LogState,
  { logState: Ref.Ref<LogStateData>; loggingConfig: LoggingConfig }
>() {
  public static appendLog = (
    logged: Logged<any>
  ): Effect.Effect<{}, never, LogState> =>
    LogState.pipe(
      Effect.tap(ls =>
        Ref.update(ls.logState, data => ({
          context: {
            ...data.context,
            level: maxLevel(logged.logData.level, data.context.level),
          },
          logs: [...data.logs, toLogData(logged)],
        }))
      ),
      Effect.bindTo("ls"),
      Effect.bind("logs", ({ ls }) => Ref.get(ls.logState)),
      Effect.flatMap(({ ls, logs }) =>
        ls.loggingConfig.autoFlush(logs)
          ? LogState.flushLogs()
          : Effect.succeed({})
      )
    );

  public static flushLogs = (): Effect.Effect<{}, never, LogState> =>
    Effect.Do.pipe(
      Effect.bind("ls", () => LogState),
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
    LogStateData,
    never,
    LogState
  > => LogState.pipe(Effect.flatMap(ls => Ref.get(ls.logState)));

  public static getLogs = (): Effect.Effect<FmtLogData[], never, LogState> =>
    LogState.getLogState().pipe(Effect.map(x => x.logs.map(fmtLogData)));
}

export interface SafeToLogError {
  toLogSafeString: () => string;
}

export interface SafeToLog<A> {
  value: A;
  toLogSafeString: () => string;
}

export const SafeToLog = {
  make:
    <A>(f: (value: A) => string) =>
    (a: A) =>
      new SafeToLogOf(a, f),

  map: <A, B>(a: SafeToLog<A>, f: (x: A) => B): SafeToLog<B> =>
    new SafeToLogOf(f(a.value), a.toLogSafeString),
};

export class SafeToLogOf<A> extends Pipeable.Class() implements SafeToLog<A> {
  private type: "SafeToLogOf" = "SafeToLogOf";
  constructor(public value: A, public toLogSafeString_: (value: A) => string) {
    super();
  }

  toLogSafeString = (): string => this.toLogSafeString_(this.value);
}

type LogData = {
  message: string;
  level: LogLevel.LogLevel;
  aux: Record<string, unknown>;
  span: string;
};

export class Unit implements SafeToLog<{}> {
  private type: "Unit" = "Unit";

  value: {} = {};
  toLogSafeString = (): string => "()";
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

export interface Logged<A> {
  logData: LogData;
  value: SafeToLog<A>;
}

export class Obs<A> extends Pipeable.Class() {
  private type: "Obs" = "Obs";

  private constructor(public logData: LogData, public value: SafeToLog<A>) {
    super();
  }

  static fromLogData = (logData: LogData): Obs<{}> =>
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
  ): ObsErr<A, E> => ObsErr.make(this.logData, this.value, handleErr);

  runEffect = <B, E extends SafeToLogError | never, R>(
    f: (a: A) => Effect.Effect<B, E, R>
  ): Observe<B, E, R> =>
    new Observe(() =>
      pipe(
        f(this.value.value),
        Effect.tap(_ => LogState.appendLog(this)),
        Effect.tapError(error =>
          LogState.appendLog(
            this.withLevel(LogLevel.Error).withAux({
              error: error.toLogSafeString(),
            })
          )
        ),
        Effect.tap(_ =>
          Effect.forEach(Object.entries(toLogData(this).aux ?? {}), ([k, v]) =>
            Effect.annotateCurrentSpan(k, v)
          )
        ),
        Effect.annotateLogs(toLogData(this).aux ?? {}),
        Effect.withSpan(this.logData.span)
      )
    );

  static Do = () => new Observe(() => Effect.Do);

  static toEffect = <A, E extends SafeToLogError | never, R>(
    self: Observe<A, E, R>
  ): Effect.Effect<A, E, R | LogState> => self.run();

  static map =
    <A, B, E extends SafeToLogError | never, R>(f: (x: A) => B) =>
    (self: Observe<A, E, R>): Observe<B, E, R> =>
      self.mapEffect(x => x.pipe(Effect.map(f)));

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
      new Observe(() => eff.run().pipe(Effect.bind(name, x => f(x).run())));

  static fromEffect = <R, E extends SafeToLogError | never, A>(
    effect: Effect.Effect<A, E, R | LogState>
  ): Observe<A, E, R> => new Observe(() => effect);

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
        x: Effect.Effect<A, E, R | LogState>
      ) => Effect.Effect<B, E2, R2 | LogState>
    ) =>
    (self: Observe<A, E, R>): Observe<B, E2, R2> =>
      self.mapEffect(map);

  static toPromise =
    <E extends SafeToLogError | never, A>(
      logged: Logged<{}>,
      loggingConfig: LoggingConfig = LoggingConfig.default()
    ) =>
    (trk: Observe<A, E, LogState>): Promise<A> =>
      trk.run().pipe(
        Effect.either,
        Effect.tap(_ => LogState.flushLogs()),
        Effect.provideServiceEffect(
          LogState,
          Ref.make<LogStateData>({
            context: logged.logData,
            logs: [],
          }).pipe(Effect.map(ls => ({ logState: ls, loggingConfig })))
        ),
        Effect.provide(Logger.json),
        loggingConfig.configureEffect,
        Effect.flatMap(x => x),
        Effect.runPromise
      );
}

class ObsErr<A, E extends SafeToLogError | never> extends Pipeable.Class() {
  private type: "ObsErr" = "ObsErr";
  private constructor(
    public logData: LogData,
    public value: SafeToLog<A>,
    public handleErr: (e: unknown) => E
  ) {
    super();
  }

  static make = <A, E extends SafeToLogError | never>(
    logData: LogData,
    value: SafeToLog<A>,
    handleErr: (e: unknown) => E
  ) => new ObsErr(logData, value, handleErr);

  toObs = (): Obs<A> => Obs.fromLogData(this.logData).withInput(this.value);

  runPromise = <B>(f: (a: A) => Promise<B>): Observe<B, E, never> =>
    this.toObs().runEffect(a =>
      Effect.tryPromise({
        try: () => f(this.value.value),
        catch: e => this.handleErr(e),
      })
    );

  runTry = <B>(f: (a: A) => B): Observe<B, E, never> =>
    this.toObs().runEffect(a =>
      Effect.try({
        try: () => f(this.value.value),
        catch: e => this.handleErr(e),
      })
    );
}

class Observe<A, E extends SafeToLogError | never, R> extends Pipeable.Class() {
  private type: "Observe" = "Observe";
  constructor(public run: () => Effect.Effect<A, E, R | LogState>) {
    super();
  }

  mapEffect = <B, E2 extends SafeToLogError | never, R2>(
    map: (
      x: Effect.Effect<A, E, R | LogState>
    ) => Effect.Effect<B, E2, R2 | LogState>
  ): Observe<B, E2, R2> => new Observe(() => map(this.run()));
}
