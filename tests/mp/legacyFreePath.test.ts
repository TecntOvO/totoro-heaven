/**
 * 「老版本路径识别」的纯逻辑测试（2026-09-29，用户口径"老版本路径文件提示需要更新"）
 *
 * 这条判据要钉住三件事（它对应用户明确选的那条路：**提示 + 一键重画，不自动迁移**）：
 *   ① 没有 `freeShape` 的旧记录（1.2.5 之前）⇒ 判定为老版本，并且**给出可读依据**；
 *   ② 有 `freeShape` 但内外圈是**逐点相同**的占位几何 ⇒ 也判为老版本（那是 `freeShapePlaceholderRing()` 的产物）；
 *   ③ **真的画过**的形状（内外圈不同 / 形状可用且不是占位）⇒ **不许误报**（否则用户每次进页都被骚扰）。
 *
 * ⚠️ 判定必须是**纯读**：本测试同时钉住"不修改入参对象"（绝不能顺手迁移/清洗数据）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { legacyFreePathUpdate, type TrackRouteEntry } from '../../utils/mp/trackLibrary.ts'
import { freeShapePlaceholderRing } from '../../utils/mp/pathShape.ts'

const pt = (latitude: number, longitude: number) => ({ latitude, longitude })
const curve = (n = 4) => ({
  kind: 'curve' as const,
  points: Array.from({ length: n }, (_, i) => pt(31.37 + i * 0.0004, 119.48 + i * 0.0004)),
})
/** 一个"真的画过"的双圈：内圈往外缩一点，与外圈不同 */
const ring = (shift: number) => [pt(31.37, 119.48), pt(31.372, 119.48), pt(31.372, 119.482), pt(31.37 + shift, 119.482)]

const entryOf = (over: Partial<TrackRouteEntry>): TrackRouteEntry =>
  ({
    lineId: 'local:free',
    lineName: '本机跑道',
    outer: ring(0.0005),
    inner: ring(0.0002),
    createdAt: '2026-09-24T19:58:00.000Z',
    appVersion: '1.2.5',
    ...over,
  }) as TrackRouteEntry

test('① 没有 freeShape 的旧记录 ⇒ 判为老版本，且给出一句可读依据', () => {
  const r = legacyFreePathUpdate(entryOf({}))
  assert.equal(r.legacy, true)
  assert.ok(r.detail.length > 0, '必须给依据（界面直接渲染这句话）')
  assert.equal(r.detail.includes('**'), false, '用户可见文案不许出现成对星号')
})

test('② 有 freeShape 但内外圈逐点相同（占位几何）⇒ 也判为老版本', () => {
  const shape = curve()
  const placeholder = freeShapePlaceholderRing(shape)
  assert.ok(placeholder.length >= 3, '占位几何至少 3 点（审计 B3 的前置条件）')
  const r = legacyFreePathUpdate(entryOf({ freeShape: shape, outer: placeholder, inner: placeholder.map((p) => ({ ...p })) }))
  assert.equal(r.legacy, true)
  assert.ok(r.detail.includes('占位'), `依据应说明是占位几何，实际：${r.detail}`)
})

test('③ 真的画过的形状（内外圈不同）⇒ **不许误报**', () => {
  const r = legacyFreePathUpdate(entryOf({ freeShape: curve(), outer: ring(0.0009), inner: ring(0.0001) }))
  assert.equal(r.legacy, false)
  assert.equal(r.detail, '')
})

test('没有记录 / 空值 ⇒ 不是老版本（那种情况该说"还没画过"，不是"该更新"）', () => {
  for (const v of [null, undefined]) {
    const r = legacyFreePathUpdate(v)
    assert.equal(r.legacy, false)
    assert.equal(r.detail, '')
  }
})

test('判定是**纯读**：不改入参（绝不顺手迁移/清洗用户数据）', () => {
  const shape = curve()
  const placeholder = freeShapePlaceholderRing(shape)
  const entry = entryOf({ freeShape: shape, outer: placeholder, inner: placeholder.map((p) => ({ ...p })) })
  const snapshot = JSON.stringify(entry)
  legacyFreePathUpdate(entry)
  assert.equal(JSON.stringify(entry), snapshot, '判定不许改动任何字段')
})
