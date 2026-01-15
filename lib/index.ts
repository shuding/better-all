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

/**
 * Internal core implementation for executing tasks with automatic dependency resolution.
 * This is shared between `all` and `allSettled`.
 */
function executeTasksInternal<T extends Record<string, any>>(
  tasks: T,
  handleSettled: boolean
): Promise<any> {
  const taskNames = Object.keys(tasks) as (keyof T)[]
  const results = new Map<keyof T, any>()
  const errors = new Map<keyof T, any>()
  const resolvers = new Map<
    keyof T,
    [(value: any) => void, (reason?: any) => void][]
  >()
  const returnValue: Record<string, any> = {}

  // Track which task is waiting for which (for cycle detection)
  const waitingFor = new Map<keyof T, Set<keyof T>>()

  // Check if there's a path from 'from' to 'to' in the waiting graph
  const hasCyclePath = (from: keyof T, to: keyof T): boolean => {
    const visited = new Set<keyof T>()
    const stack: (keyof T)[] = [from]
    while (stack.length > 0) {
      const current = stack.pop()!
      if (current === to) return true
      if (visited.has(current)) continue
      visited.add(current)
      const deps = waitingFor.get(current)
      if (deps) {
        for (const dep of deps) {
          stack.push(dep)
        }
      }
    }
    return false
  }

  // Build cycle path for error message
  const buildCyclePath = (from: keyof T, to: keyof T): string => {
    const path: (keyof T)[] = [from]
    const visited = new Set<keyof T>()
    const findPath = (current: keyof T): boolean => {
      if (current === to) return true
      if (visited.has(current)) return false
      visited.add(current)
      const deps = waitingFor.get(current)
      if (deps) {
        for (const dep of deps) {
          path.push(dep)
          if (findPath(dep)) return true
          path.pop()
        }
      }
      return false
    }
    findPath(from)
    return path.map(String).join(' → ')
  }

  const waitForDep = (callerTask: keyof T, depName: keyof T): Promise<any> => {
    if (!(depName in tasks)) {
      return Promise.reject(new Error(`Unknown task "${String(depName)}"`))
    }

    // Self-reference check
    if (callerTask === depName) {
      return Promise.reject(
        new Error(`Circular dependency detected: ${String(callerTask)} → ${String(depName)}`)
      )
    }

    // Check if adding this dependency would create a cycle
    // (i.e., if depName is already waiting for callerTask, directly or indirectly)
    if (hasCyclePath(depName, callerTask)) {
      const cyclePath = buildCyclePath(depName, callerTask)
      return Promise.reject(
        new Error(`Circular dependency detected: ${String(callerTask)} → ${cyclePath} → ${String(callerTask)}`)
      )
    }

    // Record that callerTask is waiting for depName
    if (!waitingFor.has(callerTask)) {
      waitingFor.set(callerTask, new Set())
    }
    waitingFor.get(callerTask)!.add(depName)

    if (results.has(depName)) {
      return Promise.resolve(results.get(depName))
    }
    if (errors.has(depName)) {
      return Promise.reject(errors.get(depName))
    }
    return new Promise((resolve, reject) => {
      if (!resolvers.has(depName)) {
        resolvers.set(depName, [])
      }
      resolvers.get(depName)!.push([resolve, reject])
    })
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

      // Create task-specific proxy that knows which task is calling
      const taskDepProxy = new Proxy({} as DepProxy<T>, {
        get(_, depName: string) {
          return waitForDep(name, depName as keyof T)
        },
      })
      const taskContext: TaskContext<T> = { $: taskDepProxy }

      const result = await taskFn.call(taskContext)
      handleResult(name, result)
    } catch (err) {
      handleError(name, err)
      if (!handleSettled) {
        throw err
      }
    }
  })

  if (handleSettled) {
    // For allSettled, wait for all promises to settle (never rejects)
    return Promise.allSettled(promises).then(() => returnValue)
  } else {
    // For all, reject on first error (like Promise.all)
    return Promise.all(promises).then(() => returnValue)
  }
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
 */
export function all<T extends Record<string, any>>(
  tasks: T &
    ThisType<{
      $: {
        [K in keyof T]: ReturnType<T[K]> extends Promise<infer R>
          ? Promise<R>
          : Promise<ReturnType<T[K]>>
      }
    }> & {
      [P in keyof T]: T[P] extends (...args: any[]) => any ? T[P] : never
    }
): Promise<AllResult<T>> {
  return executeTasksInternal(tasks, false) as Promise<AllResult<T>>
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
 */
export function allSettled<T extends Record<string, any>>(
  tasks: T &
    ThisType<{
      $: {
        [K in keyof T]: ReturnType<T[K]> extends Promise<infer R>
          ? Promise<R>
          : Promise<ReturnType<T[K]>>
      }
    }> & {
      [P in keyof T]: T[P] extends (...args: any[]) => any ? T[P] : never
    }
): Promise<AllSettledResult<T>> {
  return executeTasksInternal(tasks, true) as Promise<AllSettledResult<T>>
}
