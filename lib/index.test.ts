import { describe, it, expect, vi, expectTypeOf } from 'vitest'
import { all } from './index'

describe('all', () => {
  describe('Basic parallel execution', () => {
    it('should execute independent tasks in parallel', async () => {
      const executionOrder: string[] = []

      const result = await all({
        async a() {
          executionOrder.push('a-start')
          await new Promise((resolve) => setTimeout(resolve, 20))
          executionOrder.push('a-end')
          return 1
        },
        async b() {
          executionOrder.push('b-start')
          await new Promise((resolve) => setTimeout(resolve, 10))
          executionOrder.push('b-end')
          return 2
        },
        async c() {
          executionOrder.push('c-start')
          await new Promise((resolve) => setTimeout(resolve, 5))
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
          await new Promise((resolve) => setTimeout(resolve, 10))
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
          await new Promise((resolve) => setTimeout(resolve, 10))
          return 1
        },
        async b() {
          await new Promise((resolve) => setTimeout(resolve, 10))
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
          await new Promise((resolve) => setTimeout(resolve, 10))
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
          await new Promise((resolve) => setTimeout(resolve, 10))
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
        })
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
        })
      ).rejects.toThrow('Task b failed')
    })

    it('should propagate errors to tasks waiting for dependency', async () => {
      await expect(
        all({
          async a() {
            await new Promise((resolve) => setTimeout(resolve, 10))
            throw new Error('Task a failed')
          },
          async b() {
            const aValue = await this.$.a
            return aValue + 10
          },
        })
      ).rejects.toThrow('Task a failed')
    })

    it('should throw error for unknown dependency', async () => {
      await expect(
        all({
          async a() {
            await (this.$ as any).unknownTask
            return 1
          },
        })
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
        })
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
          await new Promise((resolve) => setTimeout(resolve, 50))
          return 1
        },
        async b() {
          await new Promise((resolve) => setTimeout(resolve, 50))
          return 2
        },
        async c() {
          await new Promise((resolve) => setTimeout(resolve, 50))
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
          await new Promise((resolve) => setTimeout(resolve, 30))
          executionOrder.push('a')
          return 1
        },
        async b() {
          await new Promise((resolve) => setTimeout(resolve, 10))
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
      await all({
        // @ts-expect-error
        invalidTask: 1,
      })

      await all({
        // @ts-expect-error
        invalidTask: {
          a: 1,
        },
      })
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
          await new Promise((resolve) => setTimeout(resolve, 10))
          return { apiUrl: 'https://api.example.com' }
        },
        async staticData() {
          await new Promise((resolve) => setTimeout(resolve, 10))
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
          await new Promise((resolve) => setTimeout(resolve, 10))
          return 1
        },
        async b() {
          const aValue = await this.$.a
          await new Promise((resolve) => setTimeout(resolve, 10))
          return aValue + 10
        },
      })

      expect(result).toEqual({ a: 1, b: 11 })
    })
  })
})
