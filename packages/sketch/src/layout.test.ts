import { describe, expect, it } from 'vitest'
import { fitCamera, toPage, wrap, zoomAt } from './layout'
import { cloudPath, resample, seeded, sketchy } from './wobble'

const mono = (t: string): number => t.length * 10

describe('wrap', () => {
  it('fills lines up to the width, word by word', () => {
    expect(wrap('the quick brown fox jumps', 110, mono)).toEqual([
      'the quick',
      'brown fox',
      'jumps'
    ])
  })

  it('keeps line breaks and cuts a word too long for a line', () => {
    expect(wrap('ab\nabcdefghijkl', 50, mono)).toEqual(['ab', 'abcde', 'fghij', 'kl'])
  })
})

describe('camera', () => {
  const view = { w: 1000, h: 800 }
  const cover = { left: 0, top: 0, right: 0, bottom: 0 }

  it('leaves the camera alone when everything is in view', () => {
    const cam = { x: 0, y: 0, z: 1 }
    expect(fitCamera({ x: 100, y: 100, w: 200, h: 100 }, view, cover, cam)).toBeNull()
  })

  it('centres content that is out of view, without zooming in past 100%', () => {
    const cam = fitCamera({ x: 2000, y: 0, w: 200, h: 100 }, view, cover, { x: 0, y: 0, z: 1 })!
    expect(cam.z).toBe(1)
    expect(toPage(cam, [500, 400])).toEqual([2100, 50])
  })

  it('zooms out to fit something big', () => {
    const cam = fitCamera({ x: 0, y: 0, w: 4000, h: 400 }, view, cover, { x: 0, y: 0, z: 1 })!
    expect(cam.z).toBeCloseTo(920 / 4000, 5)
  })

  it('zooms around the pointer', () => {
    const cam = zoomAt({ x: 10, y: 20, z: 1 }, [300, 200], 2)
    expect(toPage(cam, [300, 200])).toEqual(toPage({ x: 10, y: 20, z: 1 }, [300, 200]))
  })
})

describe('wobble', () => {
  it('is the same for the same seed and different for another', () => {
    const square: [number, number][] = [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100]
    ]
    expect(sketchy(square, 'a')).toBe(sketchy(square, 'a'))
    expect(sketchy(square, 'a')).not.toBe(sketchy(square, 'b'))
    expect(cloudPath(200, 90, 'c')).toBe(cloudPath(200, 90, 'c'))
  })

  it('stays within the roughness of the outline', () => {
    const rand = seeded('x')
    for (let i = 0; i < 100; i++) {
      const v = rand()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
    const pts = resample(
      [
        [0, 0],
        [100, 0]
      ],
      false,
      25
    )
    expect(pts).toHaveLength(5)
    const nums = sketchy(
      [
        [0, 0],
        [100, 0]
      ],
      's',
      { closed: false, roughness: 2 }
    )
      .match(/-?\d+(\.\d+)?/g)!
      .map(Number)
    // Every y coordinate (odd positions) stays near the line.
    expect(nums.filter((_, i) => i % 2 === 1).every((y) => Math.abs(y) <= 3)).toBe(true)
  })
})
