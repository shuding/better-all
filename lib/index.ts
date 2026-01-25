/**
 * Promise.all with automatic dependency optimization and full type inference
 *
 * Usage:
 * const { a, b, c } = await all({
 *   a() { return 1 },
 *   async b() { return 'hello' },
 *   async c() { return (await this.$.a) + 10 }
 * })
 */

// Extract the resolved return type from task functions
type TaskResult<T> = T extends (...args: any[]) => infer R ? Awaited<R> : never

// The $ proxy type - all task results as promises
type DepProxy<T extends Record<string, (...args: any[]) => any>> = {
  readonly [K in keyof T]: Promise<TaskResult<T[K]>>
}

// Context available to each task via `this`
type TaskContext<T extends Record<string, (...args: any[]) => any>> = {
  $: DepProxy<T>
  $signal: AbortSignal
}

// Result type - all tasks resolved to their return values
type AllResult<T extends Record<string, (...args: any[]) => any>> = {
  [K in keyof T]: TaskResult<T[K]>
}

// Settled result types for allSettled
type SettledFulfilled<T> = {
  status: 'fulfilled'
  value: T
}

type SettledRejected = {
  status: 'rejected'
  reason: any
}

type SettledResult<T> = SettledFulfilled<T> | SettledRejected

// Result type for allSettled - all tasks as settled results
type AllSettledResult<T extends Record<string, (...args: any[]) => any>> = {
  [K in keyof T]: SettledResult<TaskResult<T[K]>>
}

// Options for all() and allSettled()
type ExecutionOptions = {
  debug?: boolean
  signal?: AbortSignal
}

// Tracking info for debug mode
type TaskTiming = {
  name: string
  startTime: number
  endTime: number
  duration: number
  dependencies: string[]
  status: 'fulfilled' | 'rejected'
  waitPeriods: Array<{ start: number; end: number }>
}

/**
 * Generate ASCII waterfall chart for task execution
 */
function generateWaterfallChart(timings: TaskTiming[]): string {
  if (timings.length === 0) return ''

  const startTime = Math.min(...timings.map((t) => t.startTime))
  const endTime = Math.max(...timings.map((t) => t.endTime))
  const totalDuration = endTime - startTime

  // Find longest task name for padding
  const maxNameLength = Math.max(...timings.map((t) => t.name.length))
  const maxDepsLength = Math.max(
    ...timings.map((t) =>
      t.dependencies.length > 0 ? t.dependencies.join(', ').length : 0
    ),
    4 // minimum for "Deps" header
  )

  // Calculate scale (how many ms per character)
  const chartWidth = 60
  const scale = totalDuration / chartWidth
  const threshold = 0.5

  const totalDurationString = totalDuration.toFixed(2)

  let output = '\n'
  output +=
    '╔════════════════════════════════════════════════════════════════════════════════╗\n'
  output +=
    '║                           Task Execution Waterfall                             ║\n'
  output +=
    '╠════════════════════════════════════════════════════════════════════════════════╣\n'
  output += `║ Total Duration: ${totalDurationString}ms${' '.repeat(
    61 - totalDurationString.length
  )}║\n`
  output +=
    '╚════════════════════════════════════════════════════════════════════════════════╝\n\n'

  // Header
  output += `${'Task'.padEnd(maxNameLength)} │ ${'Deps'.padEnd(
    maxDepsLength
  )} │ Duration │ Timeline\n`
  output += `${'─'.repeat(maxNameLength)}─┼─${'─'.repeat(
    maxDepsLength
  )}─┼──────────┼─${'─'.repeat(chartWidth)}\n`

  // Sort by start time
  const sortedTimings = [...timings].sort((a, b) => a.startTime - b.startTime)

  for (const timing of sortedTimings) {
    const name = timing.name.padEnd(maxNameLength)
    const deps = (
      timing.dependencies.length > 0 ? timing.dependencies.join(', ') : '-'
    ).padEnd(maxDepsLength)
    const duration = `${timing.duration.toFixed(1)}ms`.padStart(8)

    // Build timeline character by character
    const timeline: string[] = []
    const relativeStart = timing.startTime - startTime
    const relativeEnd = timing.endTime - startTime

    for (let i = 0; i < chartWidth; i++) {
      // Add threshold to avoid execution delay (i.e. 0.1ms) while the task
      // starts at the same time.
      const timePos = i * scale + threshold

      if (timePos < relativeStart || timePos >= relativeEnd) {
        // Before task starts or after task ends
        timeline.push(' ')
      } else {
        // Task is executing in this time range
        // Check if this position is in a wait period
        const absoluteTime = startTime + timePos
        const isWaiting = timing.waitPeriods.some(
          (wait) => absoluteTime >= wait.start && absoluteTime < wait.end
        )

        if (isWaiting) {
          // Waiting on dependency
          timeline.push('░')
        } else {
          // Active execution
          timeline.push(timing.status === 'fulfilled' ? '█' : '▓')
        }
      }
    }

    output += `${name} │ ${deps} │ ${duration} │ ${timeline.join('')}\n`
  }

  output += '\n'
  output +=
    'Legend: █ = active (fulfilled), ▓ = active (rejected), ░ = waiting on dependency\n'
  output += '\n'

  return output
}

/**
 * Internal core implementation for executing tasks with automatic dependency resolution.
 * This is shared between `all` and `allSettled`.
 */
function executeTasksInternal<T extends Record<string, any>>(
  tasks: T,
  handleSettled: boolean,
  options: ExecutionOptions = {}
): Promise<any> {
  const taskNames = Object.keys(tasks) as (keyof T)[]
  const results = new Map<keyof T, any>()
  const errors = new Map<keyof T, any>()
  const resolvers = new Map<
    keyof T,
    [(value: any) => void, (reason?: any) => void][]
  >()
  const returnValue: Record<string, any> = {}

  // Create internal abort controller for auto-abort on failure and external signal propagation
  const internalController = new AbortController()

  // Controller to manage cleanup of the external signal listener
  const cleanupController = new AbortController()

  // If external signal is provided, propagate its abort to internal controller
  if (options.signal) {
    if (options.signal.aborted) {
      internalController.abort(options.signal.reason)
    } else {
      options.signal.addEventListener(
        'abort',
        () => internalController.abort(options.signal!.reason),
        { once: true, signal: cleanupController.signal }
      )
    }
  }

  // Debug tracking
  const timings: TaskTiming[] = []
  const taskStartTimes = new Map<keyof T, number>()
  const taskDependencies = new Map<keyof T, Set<string>>()
  const taskWaitPeriods = new Map<
    keyof T,
    Array<{ start: number; end: number }>
  >()

  const waitForDep = (taskName: keyof T, depName: keyof T): Promise<any> => {
    if (!(depName in tasks)) {
      return Promise.reject(new Error(`Unknown task "${String(depName)}"`))
    }

    // Track dependency for debug mode
    if (options.debug) {
      if (!taskDependencies.has(taskName)) {
        taskDependencies.set(taskName, new Set())
      }
      taskDependencies.get(taskName)!.add(String(depName))
    }

    let basePromise: Promise<any>

    if (results.has(depName)) {
      basePromise = Promise.resolve(results.get(depName))
    } else if (errors.has(depName)) {
      basePromise = Promise.reject(errors.get(depName))
    } else {
      basePromise = new Promise((resolve, reject) => {
        if (!resolvers.has(depName)) {
          resolvers.set(depName, [])
        }
        resolvers.get(depName)!.push([resolve, reject])
      })
    }

    // Wrap promise to track wait time in debug mode
    if (options.debug) {
      const waitStart = performance.now()
      return basePromise.then(
        (value) => {
          const waitEnd = performance.now()
          if (!taskWaitPeriods.has(taskName)) {
            taskWaitPeriods.set(taskName, [])
          }
          taskWaitPeriods
            .get(taskName)!
            .push({ start: waitStart, end: waitEnd })
          return value
        },
        (error) => {
          const waitEnd = performance.now()
          if (!taskWaitPeriods.has(taskName)) {
            taskWaitPeriods.set(taskName, [])
          }
          taskWaitPeriods
            .get(taskName)!
            .push({ start: waitStart, end: waitEnd })
          throw error
        }
      )
    }

    return basePromise
  }

  const handleResult = (name: keyof T, value: any) => {
    results.set(name, value)
    if (handleSettled) {
      returnValue[name as string] = { status: 'fulfilled', value }
    } else {
      returnValue[name as string] = value
    }
    if (resolvers.has(name)) {
      for (const [resolve] of resolvers.get(name)!) {
        resolve(value)
      }
    }
  }

  const handleError = (name: keyof T, err: any) => {
    errors.set(name, err)
    if (handleSettled) {
      returnValue[name as string] = { status: 'rejected', reason: err }
    }
    if (resolvers.has(name)) {
      for (const [, reject] of resolvers.get(name)!) {
        reject(err)
      }
    }
  }

  // Run all tasks in parallel
  const promises = taskNames.map(async (name) => {
    try {
      const taskFn = tasks[name]
      if (typeof taskFn !== 'function') {
        throw new Error(`Task "${String(name)}" is not a function`)
      }

      // Track start time for debug mode
      if (options.debug) {
        taskStartTimes.set(name, performance.now())
      }

      // Create a unique dep proxy for each task to track dependencies
      const depProxy = new Proxy({} as DepProxy<T>, {
        get(_, depName: string) {
          return waitForDep(name, depName as keyof T)
        },
      })

      const context: TaskContext<T> = {
        $: depProxy,
        $signal: internalController.signal,
      }
      const result = await taskFn.call(context)

      // Track end time and create timing record
      if (options.debug) {
        const endTime = performance.now()
        const startTime = taskStartTimes.get(name)!
        timings.push({
          name: String(name),
          startTime,
          endTime,
          duration: endTime - startTime,
          dependencies: Array.from(taskDependencies.get(name) || []),
          status: 'fulfilled',
          waitPeriods: taskWaitPeriods.get(name) || [],
        })
      }

      handleResult(name, result)
    } catch (err) {
      // Track end time for failed tasks too
      if (options.debug) {
        const endTime = performance.now()
        const startTime = taskStartTimes.get(name)!
        timings.push({
          name: String(name),
          startTime,
          endTime,
          duration: endTime - startTime,
          dependencies: Array.from(taskDependencies.get(name) || []),
          status: 'rejected',
          waitPeriods: taskWaitPeriods.get(name) || [],
        })
      }

      handleError(name, err)
      if (!handleSettled) {
        // Abort other tasks when one fails (only for all(), not allSettled())
        internalController.abort(err)
        throw err
      }
    }
  })

  const finalPromise = handleSettled
    ? // For allSettled, wait for all promises to settle (never rejects)
      Promise.allSettled(promises).then(() => returnValue)
    : // For all, reject on first error (like Promise.all)
      Promise.all(promises).then(() => returnValue)

  // Cleanup external signal listener when tasks complete
  const withCleanup = finalPromise.finally(() => {
    cleanupController.abort()
  })

  // Output waterfall chart in debug mode
  if (options.debug) {
    return withCleanup.then(
      (result) => {
        console.log(generateWaterfallChart(timings))
        return result
      },
      (error) => {
        console.log(generateWaterfallChart(timings))
        throw error
      }
    )
  }

  return withCleanup
}

/**
 * Execute tasks with automatic dependency resolution.
 *
 * @example
 * const { a, b, c } = await all({
 *   async a() { return 1 },
 *   async b() { return 'hello' },
 *   async c() { return (await this.$.a) + 10 }
 * })
 *
 * @example
 * // With debug mode
 * const result = await all({
 *   async a() { return 1 },
 *   async b() { return (await this.$.a) + 10 }
 * }, { debug: true })
 *
 * @example
 * // With auto-abort on failure - this.$signal is aborted when any sibling task fails
 * const result = await all({
 *   async a() { return fetchWithSignal(this.$signal) },
 *   async b() { throw new Error('fails') }, // This will abort tasks a and c
 *   async c() { return fetchWithSignal(this.$signal) }
 * })
 *
 * @example
 * // With external signal
 * const controller = new AbortController()
 * const result = await all({
 *   async a() { return fetchWithSignal(this.$signal) }
 * }, { signal: controller.signal })
 */
export function all<T extends Record<string, any>>(
  tasks: T &
    ThisType<{
      $: {
        [K in keyof T]: ReturnType<T[K]> extends Promise<infer R>
          ? Promise<R>
          : Promise<ReturnType<T[K]>>
      }
      $signal: AbortSignal
    }> & {
      [P in keyof T]: T[P] extends (...args: any[]) => any ? T[P] : never
    },
  options?: ExecutionOptions
): Promise<AllResult<T>> {
  return executeTasksInternal(tasks, false, options) as Promise<AllResult<T>>
}

/**
 * Execute tasks with automatic dependency resolution, returning settled results for all tasks.
 * Unlike `all`, this will never reject - failed tasks will be included in the result with their error.
 *
 * @example
 * const { a, b, c } = await allSettled({
 *   async a() { return 1 },
 *   async b() { throw new Error('failed') },
 *   async c() { return (await this.$.a) + 10 }
 * })
 * // a: { status: 'fulfilled', value: 1 }
 * // b: { status: 'rejected', reason: Error('failed') }
 * // c: { status: 'fulfilled', value: 11 }
 *
 * @example
 * // With debug mode
 * const result = await allSettled({
 *   async a() { return 1 },
 *   async b() { throw new Error('failed') }
 * }, { debug: true })
 */
export function allSettled<T extends Record<string, any>>(
  tasks: T &
    ThisType<{
      $: {
        [K in keyof T]: ReturnType<T[K]> extends Promise<infer R>
          ? Promise<R>
          : Promise<ReturnType<T[K]>>
      }
      $signal: AbortSignal
    }> & {
      [P in keyof T]: T[P] extends (...args: any[]) => any ? T[P] : never
    },
  options?: ExecutionOptions
): Promise<AllSettledResult<T>> {
  return executeTasksInternal(tasks, true, options) as Promise<
    AllSettledResult<T>
  >
}

/**
 * Custom error class for early exit via $end()
 * @internal
 */
class FlowEndError extends Error {
  constructor(public readonly value: any) {
    super('Flow ended early')
    this.name = 'FlowEndError'
  }
}

/**
 * Custom error class for aborted dependency access
 * @internal
 */
class FlowAbortedError extends Error {
  constructor() {
    super('Flow has been ended, cannot access dependencies')
    this.name = 'FlowAbortedError'
  }
}

// Context available to each task in experimental_flow via `this`
type FlowTaskContext<T extends Record<string, (...args: any[]) => any>> = {
  $: DepProxy<T>
  $signal: AbortSignal
  $end: (value: any) => never
}

// Union type of all possible return types from tasks
type FlowResult<T extends Record<string, (...args: any[]) => any>> = {
  [K in keyof T]: TaskResult<T[K]>
}[keyof T]

/**
 * Execute tasks with automatic dependency resolution and support for early exit.
 * The first task to call `this.$end(value)` determines the return value.
 *
 * @example
 * // Early exit from first task
 * const f = await experimental_flow({
 *   async task1() {
 *     this.$end(42)  // Immediately ends, f = 42
 *     return 1       // Never reached
 *   },
 *   async task2() {
 *     const r = await this.$.task1  // Throws (silently caught)
 *     return r + 10
 *   },
 * })
 * // f = 42
 *
 * @example
 * // Conditional early exit
 * const f = await experimental_flow({
 *   async task1() {
 *     const cached = await checkCache()
 *     if (cached) this.$end(cached)  // Early exit if cached
 *     return await fetchFromApi()
 *   },
 *   async task2() {
 *     const data = await this.$.task1
 *     this.$end(transform(data))
 *   },
 * })
 *
 * @example
 * // Race between tasks
 * const f = await experimental_flow({
 *   async fast() {
 *     await sleep(100)
 *     this.$end('fast won')
 *   },
 *   async slow() {
 *     await sleep(1000)
 *     this.$end('slow won')
 *   },
 * })
 * // f = 'fast won'
 */
export function experimental_flow<T extends Record<string, any>>(
  tasks: T &
    ThisType<{
      $: {
        [K in keyof T]: ReturnType<T[K]> extends Promise<infer R>
          ? Promise<R>
          : Promise<ReturnType<T[K]>>
      }
      $signal: AbortSignal
      $end: (value: any) => never
    }> & {
      [P in keyof T]: T[P] extends (...args: any[]) => any ? T[P] : never
    },
  options?: ExecutionOptions
): Promise<FlowResult<T>> {
  const taskNames = Object.keys(tasks) as (keyof T)[]
  const results = new Map<keyof T, any>()
  const errors = new Map<keyof T, any>()
  const resolvers = new Map<
    keyof T,
    [(value: any) => void, (reason?: any) => void][]
  >()

  // Track if flow has ended
  let flowEnded = false
  let flowEndValue: any = undefined

  // Create internal abort controller for auto-abort on failure and external signal propagation
  const internalController = new AbortController()

  // Controller to manage cleanup of the external signal listener
  const cleanupController = new AbortController()

  // If external signal is provided, propagate its abort to internal controller
  if (options?.signal) {
    if (options.signal.aborted) {
      internalController.abort(options.signal.reason)
    } else {
      options.signal.addEventListener(
        'abort',
        () => internalController.abort(options.signal!.reason),
        { once: true, signal: cleanupController.signal }
      )
    }
  }

  const waitForDep = (taskName: keyof T, depName: keyof T): Promise<any> => {
    if (!(depName in tasks)) {
      return Promise.reject(new Error(`Unknown task "${String(depName)}"`))
    }

    // If flow has ended, reject with FlowAbortedError
    if (flowEnded) {
      return Promise.reject(new FlowAbortedError())
    }

    if (results.has(depName)) {
      return Promise.resolve(results.get(depName))
    } else if (errors.has(depName)) {
      return Promise.reject(errors.get(depName))
    } else {
      return new Promise((resolve, reject) => {
        if (!resolvers.has(depName)) {
          resolvers.set(depName, [])
        }
        resolvers.get(depName)!.push([resolve, reject])
      })
    }
  }

  const handleResult = (name: keyof T, value: any) => {
    results.set(name, value)
    if (resolvers.has(name)) {
      for (const [resolve] of resolvers.get(name)!) {
        resolve(value)
      }
    }
  }

  const handleError = (name: keyof T, err: any) => {
    errors.set(name, err)
    if (resolvers.has(name)) {
      for (const [, reject] of resolvers.get(name)!) {
        reject(err)
      }
    }
  }

  // Run all tasks in parallel
  const promises = taskNames.map(async (name) => {
    try {
      const taskFn = tasks[name]
      if (typeof taskFn !== 'function') {
        throw new Error(`Task "${String(name)}" is not a function`)
      }

      // Create a unique dep proxy for each task
      const depProxy = new Proxy({} as DepProxy<T>, {
        get(_, depName: string) {
          return waitForDep(name, depName as keyof T)
        },
      })

      // Create $end function for this task
      const $end = (value: any): never => {
        if (!flowEnded) {
          flowEnded = true
          flowEndValue = value
        }
        throw new FlowEndError(value)
      }

      const context: FlowTaskContext<T> = {
        $: depProxy,
        $signal: internalController.signal,
        $end,
      }

      const result = await taskFn.call(context)
      handleResult(name, result)
    } catch (err) {
      // Check if this is a FlowEndError
      if (err instanceof FlowEndError) {
        // This is intentional early exit, don't propagate as error
        return
      }

      // Check if this is a FlowAbortedError
      if (err instanceof FlowAbortedError) {
        // Flow was ended by another task, silently ignore
        return
      }

      // Real error - handle normally and re-throw
      handleError(name, err)
      throw err
    }
  })

  return Promise.allSettled(promises).then((results) => {
    cleanupController.abort()

    // Check if external signal was aborted
    if (options?.signal?.aborted) {
      throw options.signal.reason || new Error('Aborted')
    }

    // Check if any task had a real error (not FlowEndError or FlowAbortedError)
    for (const result of results) {
      if (result.status === 'rejected') {
        // This is a real error, propagate it
        throw result.reason
      }
    }

    // If flow ended early, return that value
    if (flowEnded) {
      return flowEndValue
    }

    // No task called $end() - this is an error
    throw new Error(
      'experimental_flow completed without any task calling $end()'
    )
  })
}
