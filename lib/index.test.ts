import { describe, it, expect, vi, expectTypeOf } from 'vitest'
import { all, allSettled } from './index'

/**
 * Utility function to sleep for a specified number of milliseconds
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('all', () => {
  describe('Basic parallel execution', () => {
    it('should execute independent tasks in parallel', async () => {
      const executionOrder: string[] = []

      const result = await all({
        async a() {
          executionOrder.push('a-start')
          await sleep(20)
          executionOrder.push('a-end')
          return 1
        },
        async b() {
          executionOrder.push('b-start')
          await sleep(10)
          executionOrder.push('b-end')
          return 2
        },
        async c() {
          executionOrder.push('c-start')
          await sleep(5)
          executionOrder.push('c-end')
          return 3
        },
      })

      expect(result).toEqual({ a: 1, b: 2, c: 3 })
      expect(executionOrder).toEqual([
        'a-start',
        'b-start',
        'c-start',
        'c-end',
        'b-end',
        'a-end',
      ])
    })

    it('should handle synchronous tasks', async () => {
      const result = await all({
        a() {
          return 1
        },
        b() {
          return 2
        },
        c() {
          return 3
        },
      })

      expect(result).toEqual({ a: 1, b: 2, c: 3 })
    })

    it('should handle mixed sync and async tasks', async () => {
      const result = await all({
        a() {
          return 1
        },
        async b() {
          await sleep(10)
          return 2
        },
        c() {
          return 3
        },
      })

      expect(result).toEqual({ a: 1, b: 2, c: 3 })
    })
  })

  describe('Dependency resolution', () => {
    it('should handle single dependency', async () => {
      const executionOrder: string[] = []

      const result = await all({
        async a() {
          executionOrder.push('a')
          return 1
        },
        async b() {
          const aValue = await this.$.a
          executionOrder.push('b')
          return aValue + 10
        },
      })

      expect(result).toEqual({ a: 1, b: 11 })
      expect(executionOrder).toEqual(['a', 'b'])
    })

    it('should handle multiple dependencies', async () => {
      const result = await all({
        async a() {
          await sleep(10)
          return 1
        },
        async b() {
          await sleep(10)
          return 2
        },
        async c() {
          const aValue = await this.$.a
          const bValue = await this.$.b
          return aValue + bValue
        },
      })

      expect(result).toEqual({ a: 1, b: 2, c: 3 })
    })

    it('should handle chained dependencies', async () => {
      const executionOrder: string[] = []

      const result = await all({
        async a() {
          executionOrder.push('a')
          return 1
        },
        async b() {
          const aValue = await this.$.a
          executionOrder.push('b')
          return aValue + 10
        },
        async c() {
          const bValue = await this.$.b
          executionOrder.push('c')
          return bValue + 100
        },
      })

      expect(result).toEqual({ a: 1, b: 11, c: 111 })
      expect(executionOrder).toEqual(['a', 'b', 'c'])
    })

    it('should handle multiple tasks depending on the same task', async () => {
      const executionOrder: string[] = []

      const result = await all({
        async a() {
          executionOrder.push('a')
          await sleep(10)
          return 1
        },
        async b() {
          const aValue = await this.$.a
          executionOrder.push('b')
          return aValue + 10
        },
        async c() {
          const aValue = await this.$.a
          executionOrder.push('c')
          return aValue + 100
        },
      })

      expect(result).toEqual({ a: 1, b: 11, c: 101 })
      expect(executionOrder[0]).toBe('a')
    })

    it('should execute each task only once even when used by multiple dependents', async () => {
      const callCounts = { a: 0, b: 0, c: 0 }

      const result = await all({
        async a() {
          callCounts.a++
          await sleep(10)
          return 1
        },
        async b() {
          callCounts.b++
          const aValue = await this.$.a
          return aValue + 10
        },
        async c() {
          callCounts.c++
          const aValue = await this.$.a
          return aValue + 100
        },
      })

      expect(result).toEqual({ a: 1, b: 11, c: 101 })
      expect(callCounts).toEqual({ a: 1, b: 1, c: 1 })
    })

    it('should execute task only once even when awaited multiple times in same task', async () => {
      const callCounts = { a: 0, b: 0 }

      const result = await all({
        async a() {
          callCounts.a++
          return 1
        },
        async b() {
          callCounts.b++
          const first = await this.$.a
          const second = await this.$.a
          const third = await this.$.a
          return first + second + third
        },
      })

      expect(result).toEqual({ a: 1, b: 3 })
      expect(callCounts).toEqual({ a: 1, b: 1 })
    })

    it('should handle complex dependency graph', async () => {
      const result = await all({
        async a() {
          return 1
        },
        async b() {
          return 2
        },
        async c() {
          return (await this.$.a) + 10
        },
        async d() {
          return (await this.$.b) + 20
        },
        async e() {
          return (await this.$.c) + (await this.$.d)
        },
      })

      expect(result).toEqual({ a: 1, b: 2, c: 11, d: 22, e: 33 })
    })
  })

  describe('Error handling', () => {
    it('should propagate errors from independent tasks', async () => {
      await expect(
        all({
          async a() {
            throw new Error('Task a failed')
          },
          async b() {
            return 2
          },
        }),
      ).rejects.toThrow('Task a failed')
    })

    it('should propagate errors from dependent tasks', async () => {
      await expect(
        all({
          async a() {
            return 1
          },
          async b() {
            await this.$.a
            throw new Error('Task b failed')
          },
        }),
      ).rejects.toThrow('Task b failed')
    })

    it('should propagate errors to tasks waiting for dependency', async () => {
      await expect(
        all({
          async a() {
            await sleep(10)
            throw new Error('Task a failed')
          },
          async b() {
            const aValue = await this.$.a
            return aValue + 10
          },
        }),
      ).rejects.toThrow('Task a failed')
    })

    it('should throw error for unknown dependency', async () => {
      await expect(
        all({
          async a() {
            await (this.$ as any).unknownTask
            return 1
          },
        }),
      ).rejects.toThrow('Unknown task "unknownTask"')
    })

    it('should handle errors in multiple tasks', async () => {
      await expect(
        all({
          async a() {
            throw new Error('Task a failed')
          },
          async b() {
            throw new Error('Task b failed')
          },
        }),
      ).rejects.toThrow()
    })
  })

  describe('Return values', () => {
    it('should return values of various types', async () => {
      const result = await all({
        num() {
          return 42
        },
        str() {
          return 'hello'
        },
        bool() {
          return true
        },
        arr() {
          return [1, 2, 3]
        },
        obj() {
          return { key: 'value' }
        },
        nil() {
          return null
        },
        undef() {
          return undefined
        },
      })

      expect(result).toEqual({
        num: 42,
        str: 'hello',
        bool: true,
        arr: [1, 2, 3],
        obj: { key: 'value' },
        nil: null,
        undef: undefined,
      })
    })

    it('should handle promises that resolve to various types', async () => {
      const result = await all({
        async num() {
          return Promise.resolve(42)
        },
        async str() {
          return Promise.resolve('hello')
        },
        async obj() {
          return Promise.resolve({ key: 'value' })
        },
      })

      expect(result).toEqual({
        num: 42,
        str: 'hello',
        obj: { key: 'value' },
      })
    })

    it('should preserve object references', async () => {
      const obj = { key: 'value' }
      const arr = [1, 2, 3]

      const result = await all({
        obj() {
          return obj
        },
        arr() {
          return arr
        },
      })

      expect(result.obj).toBe(obj)
      expect(result.arr).toBe(arr)
    })
  })

  describe('Edge cases', () => {
    it('should handle empty object', async () => {
      const result = await all({})
      expect(result).toEqual({})
    })

    it('should handle single task', async () => {
      const result = await all({
        a() {
          return 1
        },
      })
      expect(result).toEqual({ a: 1 })
    })

    it('should handle task names with special characters', async () => {
      const result = await all({
        'task-1'() {
          return 1
        },
        task_2() {
          return 2
        },
        task$3() {
          return 3
        },
      })

      expect(result).toEqual({
        'task-1': 1,
        task_2: 2,
        task$3: 3,
      })
    })
  })

  describe('Performance', () => {
    it('should execute independent tasks truly in parallel', async () => {
      const startTime = Date.now()

      await all({
        async a() {
          await sleep(50)
          return 1
        },
        async b() {
          await sleep(50)
          return 2
        },
        async c() {
          await sleep(50)
          return 3
        },
      })

      const duration = Date.now() - startTime

      expect(duration).toBeLessThan(100)
    })

    it('should not block independent tasks when one task has dependency', async () => {
      const executionOrder: string[] = []

      await all({
        async a() {
          await sleep(30)
          executionOrder.push('a')
          return 1
        },
        async b() {
          await sleep(10)
          executionOrder.push('b')
          return 2
        },
        async c() {
          const aValue = await this.$.a
          executionOrder.push('c')
          return aValue + 10
        },
      })

      expect(executionOrder).toEqual(['b', 'a', 'c'])
    })
  })

  describe('Type inference', () => {
    it('should infer correct types for simple tasks', async () => {
      const result = await all({
        num() {
          return 42
        },
        str() {
          return 'hello'
        },
        async asyncNum() {
          return 123
        },
      })

      expectTypeOf(result.num).toEqualTypeOf<42>()
      expectTypeOf(result.str).toEqualTypeOf<'hello'>()
      expectTypeOf(result.asyncNum).toEqualTypeOf<number>()

      expect(result.num).toBe(42)
      expect(result.str).toBe('hello')
      expect(result.asyncNum).toBe(123)
    })

    it('should infer types with dependency access', async () => {
      const result = await all({
        num() {
          return 42
        },
        str() {
          return 'hello'
        },
        async combined() {
          const n = await this.$.num
          const s = await this.$.str
          return `${s}: ${n}`
        },
      })

      expectTypeOf(result.num).toEqualTypeOf<42>()
      expectTypeOf(result.str).toEqualTypeOf<'hello'>()
      expectTypeOf(result.combined).toEqualTypeOf<string>()

      expect(result.combined).toBe('hello: 42')
    })

    it('should infer complex object types', async () => {
      const result = await all({
        user() {
          return { id: 1, name: 'Alice' }
        },
        async profile() {
          const user = await this.$.user
          return { userId: user.id, displayName: user.name.toUpperCase() }
        },
      })

      expectTypeOf(result.user).toEqualTypeOf<{ id: number; name: string }>()
      expectTypeOf(result.profile).toEqualTypeOf<{
        userId: number
        displayName: string
      }>()

      expect(result.profile).toEqual({ userId: 1, displayName: 'ALICE' })
    })

    it('should error on non-function task definitions', async () => {
      await expect(
        // @ts-expect-error
        all({
          invalidTask: 1,
        }),
      ).rejects.toThrow('Task "invalidTask" is not a function')

      await expect(
        // @ts-expect-error
        all({
          invalidTask: {
            a: 1,
          },
        }),
      ).rejects.toThrow('Task "invalidTask" is not a function')
    })

    it('should allow functions with optional arguments', async () => {
      async function a(options?: number) {
        return options ?? 1
      }

      const result = await all({
        a,
        async b() {
          return (await this.$.a) + 2
        },
      })
      expect(result.a).toBe(1)
      expect(result.b).toBe(3)
    })
  })

  describe('Real-world scenarios', () => {
    it('should handle API call pattern with dependent requests', async () => {
      const mockFetch = vi.fn()

      mockFetch
        .mockResolvedValueOnce({ id: 1, name: 'User' })
        .mockResolvedValueOnce([{ id: 1, title: 'Post 1' }])
        .mockResolvedValueOnce([{ id: 1, text: 'Comment 1' }])

      const result = await all({
        async user() {
          return mockFetch('/user/1')
        },
        async posts() {
          const user = await this.$.user
          return mockFetch(`/user/${user.id}/posts`)
        },
        async comments() {
          const posts = await this.$.posts
          return mockFetch(`/post/${posts[0].id}/comments`)
        },
      })

      expect(mockFetch).toHaveBeenCalledTimes(3)
      expect(result.user).toEqual({ id: 1, name: 'User' })
      expect(result.posts).toEqual([{ id: 1, title: 'Post 1' }])
      expect(result.comments).toEqual([{ id: 1, text: 'Comment 1' }])
    })

    it('should handle mixed parallel and dependent operations', async () => {
      const result = await all({
        async config() {
          await sleep(10)
          return { apiUrl: 'https://api.example.com' }
        },
        async staticData() {
          await sleep(10)
          return { locale: 'en' }
        },
        async userData() {
          const config = await this.$.config
          return { name: 'User', from: config.apiUrl }
        },
        async page() {
          const user = await this.$.userData
          const staticData = await this.$.staticData
          return {
            title: `Hello ${user.name}`,
            locale: staticData.locale,
          }
        },
      })

      expect(result.page).toEqual({
        title: 'Hello User',
        locale: 'en',
      })
    })

    it('should handle data transformation pipeline', async () => {
      const result = await all({
        async rawData() {
          return [1, 2, 3, 4, 5]
        },
        async filtered() {
          const data = await this.$.rawData
          return data.filter((n) => n % 2 === 0)
        },
        async mapped() {
          const data = await this.$.filtered
          return data.map((n) => n * 2)
        },
        async reduced() {
          const data = await this.$.mapped
          return data.reduce((sum, n) => sum + n, 0)
        },
      })

      expect(result).toEqual({
        rawData: [1, 2, 3, 4, 5],
        filtered: [2, 4],
        mapped: [4, 8],
        reduced: 12,
      })
    })
  })

  describe('Multiple dependencies', () => {
    it('should handle three dependencies', async () => {
      const result = await all({
        a() {
          return 1
        },
        b() {
          return 2
        },
        c() {
          return 3
        },
        async sum() {
          const a = await this.$.a
          const b = await this.$.b
          const c = await this.$.c
          return a + b + c
        },
      })

      expect(result.sum).toBe(6)
    })

    it('should handle computation between dependency values', async () => {
      const result = await all({
        a() {
          return 5
        },
        b() {
          return 3
        },
        async computed() {
          const a = await this.$.a
          const b = await this.$.b
          const squared = a * a
          const doubled = b * 2
          return squared + doubled
        },
      })

      expect(result.computed).toBe(31)
    })

    it('should handle async operations in dependent tasks', async () => {
      const result = await all({
        async a() {
          await sleep(10)
          return 1
        },
        async b() {
          const aValue = await this.$.a
          await sleep(10)
          return aValue + 10
        },
      })

      expect(result).toEqual({ a: 1, b: 11 })
    })
  })
})

describe('allSettled', () => {
  describe('Basic execution with mixed results', () => {
    it('should return fulfilled and rejected results without throwing', async () => {
      const result = await allSettled({
        async a() {
          return 1
        },
        async b() {
          throw new Error('Task b failed')
        },
        async c() {
          return 3
        },
      })

      expect(result.a).toEqual({ status: 'fulfilled', value: 1 })
      expect(result.b).toEqual({
        status: 'rejected',
        reason: expect.any(Error),
      })
      expect(result.b.status === 'rejected' && result.b.reason.message).toBe(
        'Task b failed',
      )
      expect(result.c).toEqual({ status: 'fulfilled', value: 3 })
    })

    it('should handle all tasks succeeding', async () => {
      const result = await allSettled({
        a() {
          return 1
        },
        async b() {
          return 'hello'
        },
        async c() {
          return true
        },
      })

      expect(result).toEqual({
        a: { status: 'fulfilled', value: 1 },
        b: { status: 'fulfilled', value: 'hello' },
        c: { status: 'fulfilled', value: true },
      })
    })

    it('should handle all tasks failing', async () => {
      const result = await allSettled({
        async a() {
          throw new Error('a failed')
        },
        async b() {
          throw new Error('b failed')
        },
      })

      expect(result.a).toEqual({
        status: 'rejected',
        reason: expect.any(Error),
      })
      expect(result.b).toEqual({
        status: 'rejected',
        reason: expect.any(Error),
      })
    })
  })

  describe('Dependency resolution with failures', () => {
    it('should handle successful task depending on another successful task', async () => {
      const result = await allSettled({
        async a() {
          return 1
        },
        async b() {
          const aValue = await this.$.a
          return aValue + 10
        },
      })

      expect(result).toEqual({
        a: { status: 'fulfilled', value: 1 },
        b: { status: 'fulfilled', value: 11 },
      })
    })

    it('should handle task depending on failed task', async () => {
      const result = await allSettled({
        async a() {
          throw new Error('Task a failed')
        },
        async b() {
          const aValue = await this.$.a
          return aValue + 10
        },
      })

      expect(result.a).toEqual({
        status: 'rejected',
        reason: expect.any(Error),
      })
      expect(result.b).toEqual({
        status: 'rejected',
        reason: expect.any(Error),
      })
    })

    it('should allow dependent task to catch and handle dependency failure', async () => {
      const result = await allSettled({
        async a() {
          throw new Error('Task a failed')
        },
        async b() {
          try {
            const aValue = await this.$.a
            return aValue + 10
          } catch (err) {
            return 'handled error'
          }
        },
      })

      expect(result.a).toEqual({
        status: 'rejected',
        reason: expect.any(Error),
      })
      expect(result.b).toEqual({
        status: 'fulfilled',
        value: 'handled error',
      })
    })

    it('should handle multiple tasks depending on one failed task', async () => {
      const result = await allSettled({
        async a() {
          throw new Error('Task a failed')
        },
        async b() {
          const aValue = await this.$.a
          return aValue + 10
        },
        async c() {
          const aValue = await this.$.a
          return aValue + 100
        },
      })

      expect(result.a.status).toBe('rejected')
      expect(result.b.status).toBe('rejected')
      expect(result.c.status).toBe('rejected')
    })

    it('should not block independent tasks when one fails', async () => {
      const executionOrder: string[] = []

      const result = await allSettled({
        async a() {
          await sleep(10)
          executionOrder.push('a')
          throw new Error('a failed')
        },
        async b() {
          await sleep(5)
          executionOrder.push('b')
          return 2
        },
        async c() {
          await sleep(15)
          executionOrder.push('c')
          return 3
        },
      })

      expect(executionOrder).toEqual(['b', 'a', 'c'])
      expect(result.a.status).toBe('rejected')
      expect(result.b).toEqual({ status: 'fulfilled', value: 2 })
      expect(result.c).toEqual({ status: 'fulfilled', value: 3 })
    })
  })

  describe('Complex scenarios', () => {
    it('should handle complex dependency graph with mixed results', async () => {
      const result = await allSettled({
        async a() {
          return 1
        },
        async b() {
          throw new Error('b failed')
        },
        async c() {
          const aValue = await this.$.a
          return aValue + 10
        },
        async d() {
          const bValue = await this.$.b
          return bValue + 20
        },
        async e() {
          const cValue = await this.$.c
          return cValue + 100
        },
      })

      expect(result.a).toEqual({ status: 'fulfilled', value: 1 })
      expect(result.b.status).toBe('rejected')
      expect(result.c).toEqual({ status: 'fulfilled', value: 11 })
      expect(result.d.status).toBe('rejected')
      expect(result.e).toEqual({ status: 'fulfilled', value: 111 })
    })

    it('should handle partial failure in API call pattern', async () => {
      const mockFetch = vi.fn()

      // user and settings run in parallel, posts depends on user
      // Order of execution: user (1st call), settings (2nd call), posts (3rd call)
      mockFetch
        .mockResolvedValueOnce({ id: 1, name: 'User' }) // user call
        .mockResolvedValueOnce({ theme: 'dark' }) // settings call (parallel)
        .mockRejectedValueOnce(new Error('Posts API failed')) // posts call (after user)

      const result = await allSettled({
        async user() {
          return mockFetch('/user/1')
        },
        async posts() {
          const user = await this.$.user
          return mockFetch(`/user/${user.id}/posts`)
        },
        async settings() {
          return mockFetch('/settings')
        },
      })

      expect(result.user).toEqual({
        status: 'fulfilled',
        value: { id: 1, name: 'User' },
      })
      expect(result.posts.status).toBe('rejected')
      expect(result.settings).toEqual({
        status: 'fulfilled',
        value: { theme: 'dark' },
      })
    })
  })

  describe('Edge cases', () => {
    it('should handle empty object', async () => {
      const result = await allSettled({})
      expect(result).toEqual({})
    })

    it('should handle single successful task', async () => {
      const result = await allSettled({
        a() {
          return 1
        },
      })
      expect(result).toEqual({
        a: { status: 'fulfilled', value: 1 },
      })
    })

    it('should handle single failed task', async () => {
      const result = await allSettled({
        async a() {
          throw new Error('failed')
        },
      })
      expect(result.a.status).toBe('rejected')
    })

    it('should preserve different error types', async () => {
      const customError = new TypeError('type error')
      const result = await allSettled({
        async a() {
          throw customError
        },
        async b() {
          throw 'string error'
        },
        async c() {
          throw { code: 'CUSTOM', message: 'object error' }
        },
      })

      expect(result.a).toEqual({
        status: 'rejected',
        reason: customError,
      })
      expect(result.b).toEqual({
        status: 'rejected',
        reason: 'string error',
      })
      expect(result.c).toEqual({
        status: 'rejected',
        reason: { code: 'CUSTOM', message: 'object error' },
      })
    })
  })

  describe('Type inference', () => {
    it('should infer correct types for settled results', async () => {
      const result = await allSettled({
        num() {
          return 42
        },
        str() {
          return 'hello'
        },
        async asyncNum() {
          return 123
        },
      })

      expectTypeOf(result.num).toEqualTypeOf<
        { status: 'fulfilled'; value: 42 } | { status: 'rejected'; reason: any }
      >()
      expectTypeOf(result.str).toEqualTypeOf<
        | { status: 'fulfilled'; value: 'hello' }
        | { status: 'rejected'; reason: any }
      >()

      if (result.num.status === 'fulfilled') {
        expect(result.num.value).toBe(42)
      }
      if (result.str.status === 'fulfilled') {
        expect(result.str.value).toBe('hello')
      }
      if (result.asyncNum.status === 'fulfilled') {
        expect(result.asyncNum.value).toBe(123)
      }
    })
  })

  describe('Return value types', () => {
    it('should handle various return types in fulfilled results', async () => {
      const result = await allSettled({
        num() {
          return 42
        },
        str() {
          return 'hello'
        },
        arr() {
          return [1, 2, 3]
        },
        obj() {
          return { key: 'value' }
        },
        nil() {
          return null
        },
        undef() {
          return undefined
        },
      })

      expect(result).toEqual({
        num: { status: 'fulfilled', value: 42 },
        str: { status: 'fulfilled', value: 'hello' },
        arr: { status: 'fulfilled', value: [1, 2, 3] },
        obj: { status: 'fulfilled', value: { key: 'value' } },
        nil: { status: 'fulfilled', value: null },
        undef: { status: 'fulfilled', value: undefined },
      })
    })
  })
})

describe('Debug mode', () => {
  describe('all() with debug', () => {
    it('should output waterfall chart with debug: true', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      const result = await all(
        {
          async a() {
            await sleep(50)
            return 1
          },
          async b() {
            await sleep(30)
            return 2
          },
          async c() {
            const aValue = await this.$.a
            await sleep(20)
            return aValue + 10
          },
        },
        { debug: true },
      )

      expect(result).toEqual({ a: 1, b: 2, c: 11 })
      expect(consoleSpy).toHaveBeenCalledTimes(1)

      const output = consoleSpy.mock.calls[0][0]
      expect(output).toContain('Task Execution Waterfall')
      expect(output).toContain('Total Duration')
      expect(output).toContain('Timeline')
      expect(output).toContain('a')
      expect(output).toContain('b')
      expect(output).toContain('c')

      consoleSpy.mockRestore()
    })

    it('should show multiple dependencies in deps column', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      await all(
        {
          async a() {
            return 1
          },
          async b() {
            return 2
          },
          async c() {
            const aValue = await this.$.a
            const bValue = await this.$.b
            return aValue + bValue
          },
        },
        { debug: true },
      )

      const output = consoleSpy.mock.calls[0][0]
      const lines = output.split('\n')
      const cLine = lines.find((line: string) => line.trim().startsWith('c'))

      expect(cLine).toBeDefined()
      // Should list both dependencies (order may vary)
      expect(cLine).toMatch(/a.*b|b.*a/)

      consoleSpy.mockRestore()
    })

    it('should show complex dependency graph with wait-active-wait pattern', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      await allSettled(
        {
          async fastTask() {
            await sleep(20)
          },
          async slowTask() {
            await sleep(100)
          },
          async multiWaitTask() {
            await this.$.fastTask
            await sleep(30)
            await this.$.slowTask
            await sleep(10)
          },
          async waitForMultiWaitTask() {
            await this.$.multiWaitTask
            await sleep(10)
          },
          async errorAfterFastTask() {
            await this.$.fastTask
            await sleep(15)
            throw new Error()
          },
        },
        { debug: true },
      )

      const output = consoleSpy.mock.calls[0][0]
      consoleSpy.mockRestore()

      console.log(output)

      // multiWaitTask should show: ░(wait for fast) █(30ms active) ░(wait for slow) █(10ms active)
      const lines = output.split('\n')
      const multiWaitLine = lines.find((line: string) =>
        line.includes('multiWaitTask'),
      )
      expect(multiWaitLine).toBeDefined()

      // Should contain both waiting (░) and active (█) characters
      expect(multiWaitLine).toContain('░')
      expect(multiWaitLine).toContain('█')
    })

    it('should show dependencies in waterfall chart', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      await all(
        {
          async a() {
            return 1
          },
          async b() {
            return 2
          },
          async c() {
            const aValue = await this.$.a
            const bValue = await this.$.b
            return aValue + bValue
          },
        },
        { debug: true },
      )

      const output = consoleSpy.mock.calls[0][0]
      // Check that task c shows dependencies on a and b
      expect(output).toContain('a')
      expect(output).toContain('b')
      expect(output).toContain('c')

      consoleSpy.mockRestore()
    })

    it('should work with no dependencies', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      const result = await all(
        {
          async a() {
            return 1
          },
          async b() {
            return 2
          },
        },
        { debug: true },
      )

      expect(result).toEqual({ a: 1, b: 2 })
      expect(consoleSpy).toHaveBeenCalledTimes(1)

      consoleSpy.mockRestore()
    })

    it('should still output waterfall on error', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      await expect(
        all(
          {
            async a() {
              throw new Error('a failed')
            },
            async b() {
              return 2
            },
          },
          { debug: true },
        ),
      ).rejects.toThrow('a failed')

      expect(consoleSpy).toHaveBeenCalledTimes(1)
      const output = consoleSpy.mock.calls[0][0]
      expect(output).toContain('Task Execution Waterfall')

      consoleSpy.mockRestore()
    })
  })

  describe('allSettled() with debug', () => {
    it('should output waterfall chart with debug: true', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      const result = await allSettled(
        {
          async a() {
            return 1
          },
          async b() {
            throw new Error('b failed')
          },
          async c() {
            return 3
          },
        },
        { debug: true },
      )

      expect(result.a).toEqual({ status: 'fulfilled', value: 1 })
      expect(result.b.status).toBe('rejected')
      expect(result.c).toEqual({ status: 'fulfilled', value: 3 })

      expect(consoleSpy).toHaveBeenCalledTimes(1)
      const output = consoleSpy.mock.calls[0][0]
      expect(output).toContain('Task Execution Waterfall')
      expect(output).toContain('Legend')

      consoleSpy.mockRestore()
    })

    it('should show rejected tasks with different visual (▓)', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      await allSettled(
        {
          async failed() {
            await sleep(30)
            throw new Error('failed')
          },
          async success() {
            await sleep(30)
            return 'ok'
          },
        },
        { debug: true },
      )

      const output = consoleSpy.mock.calls[0][0]
      const lines = output.split('\n')
      const failedLine = lines.find((line: string) => line.includes('failed'))
      const successLine = lines.find((line: string) => line.includes('success'))

      // Failed task should show ▓ (rejected bars)
      expect(failedLine).toContain('▓')
      // Success task should show █ (fulfilled bars)
      expect(successLine).toContain('█')

      // Legend should explain both
      expect(output).toContain('active (rejected)')
      expect(output).toContain('▓')

      consoleSpy.mockRestore()
    })

    it('should show tasks that depend on failed tasks as waiting', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      await allSettled(
        {
          async a() {
            await sleep(50)
            throw new Error('a failed')
          },
          async b() {
            const aValue = await this.$.a
            await sleep(20)
            return aValue + 10
          },
        },
        { debug: true },
      )

      const output = consoleSpy.mock.calls[0][0]
      const lines = output.split('\n')
      const bLine = lines.find((line: string) => line.trim().startsWith('b'))

      // Task b should show waiting (░) for dependency a
      // When a fails, b fails immediately at the await point
      // So it shows waiting time only (no active execution time)
      expect(bLine).toContain('░') // Waiting for a

      consoleSpy.mockRestore()
    })
  })

  describe('Edge cases', () => {
    it('should handle empty object with debug (inline snapshot)', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      const result = await all({}, { debug: true })
      expect(result).toEqual({})

      // Should still output chart (even if empty)
      expect(consoleSpy).toHaveBeenCalledTimes(1)
      const output = consoleSpy.mock.calls[0][0]

      expect(output).toMatchInlineSnapshot(`""`)

      consoleSpy.mockRestore()
    })

    it('should work without debug option (backwards compatibility)', async () => {
      const consoleSpy = vi.spyOn(console, 'log')

      const result = await all({
        async a() {
          return 1
        },
      })

      expect(result).toEqual({ a: 1 })
      // Should not output anything without debug flag
      expect(consoleSpy).not.toHaveBeenCalled()

      consoleSpy.mockRestore()
    })

    it('should handle single task with debug', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      await all(
        {
          async onlyTask() {
            await sleep(25)
            return 'done'
          },
        },
        { debug: true },
      )

      const output = consoleSpy.mock.calls[0][0]
      const lines = output.split('\n')
      const taskLine = lines.find((line: string) => line.includes('onlyTask'))

      expect(taskLine).toBeDefined()
      expect(taskLine).toContain('│ -') // No dependencies
      expect(taskLine).toContain('█') // Active bar

      consoleSpy.mockRestore()
    })

    it('should handle task names with special characters', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      await all(
        {
          async 'task-1'() {
            return 1
          },
          async task_2() {
            return 2
          },
          async task$3() {
            return 3
          },
        },
        { debug: true },
      )

      const output = consoleSpy.mock.calls[0][0]

      // All task names should appear in output
      expect(output).toContain('task-1')
      expect(output).toContain('task_2')
      expect(output).toContain('task$3')

      consoleSpy.mockRestore()
    })

    it('should handle long dependency chains in output', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      await all(
        {
          async a() {
            return 1
          },
          async b() {
            return await this.$.a
          },
          async c() {
            return await this.$.b
          },
          async d() {
            return await this.$.c
          },
        },
        { debug: true },
      )

      const output = consoleSpy.mock.calls[0][0]
      const lines = output.split('\n')

      // Each task should show its dependency
      const bLine = lines.find((line: string) => line.trim().startsWith('b'))
      const cLine = lines.find((line: string) => line.trim().startsWith('c'))
      const dLine = lines.find((line: string) => line.trim().startsWith('d'))

      expect(bLine).toContain('a')
      expect(cLine).toContain('b')
      expect(dLine).toContain('c')

      // Later tasks should show more waiting (░)
      const dTimelineMatch = dLine?.match(/Timeline[^│]*│\s*(.+)$/)
      if (dTimelineMatch) {
        const dTimeline = dTimelineMatch[1]
        expect(dTimeline).toContain('░')
      }

      consoleSpy.mockRestore()
    })

    it('should properly format table alignment', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      await all(
        {
          async shortName() {
            return 1
          },
          async veryLongTaskNameHere() {
            return 2
          },
        },
        { debug: true },
      )

      const output = consoleSpy.mock.calls[0][0]
      const lines = output.split('\n')

      // Find header separator line
      const separatorLine = lines.find((line: string) => line.includes('─┼─'))
      expect(separatorLine).toBeDefined()

      // All task lines should have the same number of │ separators
      const taskLines = lines.filter(
        (line: string) =>
          (line.includes('shortName') ||
            line.includes('veryLongTaskNameHere')) &&
          line.includes('│'),
      )

      taskLines.forEach((line: string) => {
        // Should have exactly 3 separators (4 columns)
        const separators = (line.match(/│/g) || []).length
        expect(separators).toBe(3)
      })

      consoleSpy.mockRestore()
    })

    it('should show correct timeline width', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      await all(
        {
          async task() {
            await sleep(50)
            return 1
          },
        },
        { debug: true },
      )

      const output = consoleSpy.mock.calls[0][0]
      const lines = output.split('\n')
      const taskLine = lines.find(
        (line: string) => line.includes('task') && line.includes('█'),
      )

      if (taskLine) {
        // Timeline should be at least 60 characters (the chart width)
        const parts = taskLine.split('│')
        const timeline = parts[parts.length - 1]
        // Timeline column should be consistently sized
        expect(timeline.length).toBeGreaterThanOrEqual(60)
      }

      consoleSpy.mockRestore()
    })

    it('should display durations in milliseconds with precision', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      await all(
        {
          async quickTask() {
            await sleep(15)
            return 1
          },
          async slowerTask() {
            await sleep(55)
            return 2
          },
        },
        { debug: true },
      )

      const output = consoleSpy.mock.calls[0][0]

      // Should show durations with decimal precision (e.g., "15.2ms", "55.7ms")
      expect(output).toMatch(/\d+\.\d+ms/)

      // Total duration should also be present
      expect(output).toMatch(/Total Duration: \d+\.\d+ms/)

      consoleSpy.mockRestore()
    })
  })
})

describe('Abort signal', () => {
  describe('all() with $signal', () => {
    it('should provide $signal as an AbortSignal', async () => {
      let receivedSignal: AbortSignal | undefined

      await all({
        async a() {
          receivedSignal = this.$signal
          return 1
        },
      })

      expect(receivedSignal).toBeInstanceOf(AbortSignal)
    })

    it('should abort $signal when a sibling task fails', async () => {
      const abortEvents: string[] = []

      await expect(
        all({
          async fast() {
            throw new Error('fast failed')
          },
          async slow() {
            this.$signal.addEventListener('abort', () => {
              abortEvents.push('slow-aborted')
            })
            await sleep(50)
            return 'slow done'
          },
        }),
      ).rejects.toThrow('fast failed')

      // Give time for abort event to fire
      await sleep(10)
      expect(abortEvents).toContain('slow-aborted')
    })

    it('should set abort reason to the error that caused the failure', async () => {
      let abortReason: any

      const errorToThrow = new Error('task failed')

      await expect(
        all({
          async failing() {
            throw errorToThrow
          },
          async waiting() {
            this.$signal.addEventListener('abort', () => {
              abortReason = this.$signal.reason
            })
            await sleep(50)
            return 'done'
          },
        }),
      ).rejects.toThrow('task failed')

      await sleep(10)
      expect(abortReason).toBe(errorToThrow)
    })

    it('should allow tasks to check signal.aborted', async () => {
      let wasAborted = false
      let checkCompleted = false

      await expect(
        all({
          async failing() {
            await sleep(10)
            throw new Error('failed')
          },
          async checking() {
            // Wait longer than failing task, then check abort status
            await sleep(30)
            wasAborted = this.$signal.aborted
            checkCompleted = true
            return 'done'
          },
        }),
      ).rejects.toThrow('failed')

      // Wait for checking task to complete its check
      await sleep(50)
      expect(checkCompleted).toBe(true)
      expect(wasAborted).toBe(true)
    })

    it('should propagate external signal abort to $signal', async () => {
      const controller = new AbortController()
      let internalAborted = false

      const promise = all(
        {
          async task() {
            this.$signal.addEventListener('abort', () => {
              internalAborted = true
            })
            // Check signal and throw if aborted
            await sleep(50)
            if (this.$signal.aborted) {
              throw this.$signal.reason
            }
            return 'done'
          },
        },
        { signal: controller.signal },
      )

      // Abort after a short delay
      await sleep(10)
      controller.abort(new Error('external abort'))

      await expect(promise).rejects.toThrow('external abort')
      expect(internalAborted).toBe(true)
    })

    it('should handle already aborted external signal', async () => {
      const controller = new AbortController()
      controller.abort(new Error('pre-aborted'))

      let signalAborted = false

      await expect(
        all(
          {
            async task() {
              signalAborted = this.$signal.aborted
              if (this.$signal.aborted) {
                throw this.$signal.reason
              }
              return 'done'
            },
          },
          { signal: controller.signal },
        ),
      ).rejects.toThrow('pre-aborted')

      expect(signalAborted).toBe(true)
    })

    it('should not abort other tasks until one actually fails', async () => {
      const states: string[] = []

      const result = await all({
        async a() {
          states.push('a-start')
          await sleep(20)
          states.push('a-end')
          return 1
        },
        async b() {
          states.push('b-start')
          expect(this.$signal.aborted).toBe(false)
          await sleep(10)
          expect(this.$signal.aborted).toBe(false)
          states.push('b-end')
          return 2
        },
      })

      expect(result).toEqual({ a: 1, b: 2 })
      expect(states).toContain('a-end')
      expect(states).toContain('b-end')
    })
  })

  describe('allSettled() with $signal', () => {
    it('should provide $signal as an AbortSignal', async () => {
      let receivedSignal: AbortSignal | undefined

      await allSettled({
        async a() {
          receivedSignal = this.$signal
          return 1
        },
      })

      expect(receivedSignal).toBeInstanceOf(AbortSignal)
    })

    it('should NOT abort $signal when a sibling task fails', async () => {
      const abortEvents: string[] = []

      const result = await allSettled({
        async fast() {
          throw new Error('fast failed')
        },
        async slow() {
          this.$signal.addEventListener('abort', () => {
            abortEvents.push('slow-aborted')
          })
          await sleep(30)
          return 'slow done'
        },
      })

      // Give time for any abort event to fire (it should NOT)
      await sleep(10)

      expect(result.fast.status).toBe('rejected')
      expect(result.slow).toEqual({ status: 'fulfilled', value: 'slow done' })
      expect(abortEvents).not.toContain('slow-aborted')
    })

    it('should NOT set signal.aborted when a sibling task fails', async () => {
      let wasAborted = false

      const result = await allSettled({
        async failing() {
          throw new Error('failed')
        },
        async checking() {
          await sleep(20)
          wasAborted = this.$signal.aborted
          return 'done'
        },
      })

      expect(result.failing.status).toBe('rejected')
      expect(result.checking).toEqual({ status: 'fulfilled', value: 'done' })
      expect(wasAborted).toBe(false)
    })

    it('should still propagate external signal abort to $signal', async () => {
      const controller = new AbortController()
      let internalAborted = false

      const promise = allSettled(
        {
          async task() {
            this.$signal.addEventListener('abort', () => {
              internalAborted = true
            })
            await sleep(100)
            return 'done'
          },
        },
        { signal: controller.signal },
      )

      // Abort after a short delay
      await sleep(10)
      controller.abort(new Error('external abort'))

      const result = await promise
      expect(internalAborted).toBe(true)
      // Task still completes since allSettled never rejects
      expect(result.task).toBeDefined()
    })
  })

  describe('External signal options', () => {
    it('should pass external signal reason when aborting', async () => {
      const controller = new AbortController()
      const customReason = { code: 'TIMEOUT', message: 'Request timed out' }
      let receivedReason: any

      const promise = all(
        {
          async task() {
            this.$signal.addEventListener('abort', () => {
              receivedReason = this.$signal.reason
            })
            await sleep(50)
            // Check signal and throw if aborted
            if (this.$signal.aborted) {
              throw new Error('Task aborted')
            }
            return 'done'
          },
        },
        { signal: controller.signal },
      )

      await sleep(10)
      controller.abort(customReason)

      await expect(promise).rejects.toThrow('Task aborted')
      expect(receivedReason).toBe(customReason)
    })

    it('should work without signal option (backwards compatibility)', async () => {
      const result = await all({
        async a() {
          return 1
        },
        async b() {
          return (await this.$.a) + 10
        },
      })

      expect(result).toEqual({ a: 1, b: 11 })
    })

    it('should work with signal option and dependencies', async () => {
      const controller = new AbortController()

      const result = await all(
        {
          async a() {
            return 1
          },
          async b() {
            return (await this.$.a) + 10
          },
        },
        { signal: controller.signal },
      )

      expect(result).toEqual({ a: 1, b: 11 })
    })
  })

  describe('Real-world abort scenarios', () => {
    it('should allow aborting fetch-like operations', async () => {
      // Simulate fetch with abort support
      const mockFetch = (signal: AbortSignal): Promise<string> => {
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => resolve('data'), 100)
          signal.addEventListener('abort', () => {
            clearTimeout(timeout)
            reject(new Error('Aborted'))
          })
        })
      }

      await expect(
        all({
          async failing() {
            await sleep(10)
            throw new Error('API error')
          },
          async fetching() {
            return mockFetch(this.$signal)
          },
        }),
      ).rejects.toThrow('API error')
    })

    it('should handle multiple concurrent abort-aware tasks', async () => {
      const completedTasks: string[] = []

      const mockOperation = (
        name: string,
        signal: AbortSignal,
      ): Promise<string> => {
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            completedTasks.push(name)
            resolve(name)
          }, 50)
          signal.addEventListener('abort', () => {
            clearTimeout(timeout)
            reject(new Error(`${name} aborted`))
          })
        })
      }

      await expect(
        all({
          async failing() {
            await sleep(10)
            throw new Error('First failure')
          },
          async task1() {
            return mockOperation('task1', this.$signal)
          },
          async task2() {
            return mockOperation('task2', this.$signal)
          },
          async task3() {
            return mockOperation('task3', this.$signal)
          },
        }),
      ).rejects.toThrow('First failure')

      // None of the mock operations should have completed
      expect(completedTasks).toEqual([])
    })
  })
})
