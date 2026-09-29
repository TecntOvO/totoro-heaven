/**
 * 「配速允许区间 + 区间内采样」的纯逻辑测试（2026-09-29，GitHub issue #13）
 *
 * ## 抓到的真 bug（用户原话）
 * > "实际配速**永远是按照官方下发配速的最低要求**去上传数据……配速在能修改的情况下需要引入随机性"
 *
 * 根因是**"夹紧一个越界的基线"**：旧实现 = `基线 ±3%` 然后 `clamp(交集 lo, hi)` ⇒
 * 基线在交集之外时必然被推到**边界**上，于是每一笔提交都是同一个值、且贴着窗口的一侧。
 * 实测那条任务（研究生院「研途健行」）：速度 4~7 km/h ⇒ 514~900 秒/公里，
 * 时长 20~35 分钟 / 2.4 km ⇒ 500~875 秒/公里，交集 = **514~875**；
 * 界面默认策略 6'00" = 360 秒/公里 远在快侧之外 ⇒ 每次都夹成 **514**（截图里那个裸数字 514 就是它）。
 *
 * ## 钉住的四件事
 *   ① `runPaceWindow` 真的取**交集**（速度窗 ∩ 时长窗），并且窗口缺失时不假装有；
 *   ② **基线在区间外** ⇒ 采样落在区间内、**不贴边界**、且多个种子**互不相同**（这才是"随机性"）；
 *   ③ **基线在区间内** ⇒ 尊重用户设置（只在它附近 ±3%，不被无谓地拉走）；
 *   ④ 两窗**矛盾**（任务参数本身有错）⇒ 如实标 `conflict`，并以速度窗为准（不静默）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRngFromSeed, runPaceWindow, sampleRunPace, planRealisticRun } from '../../utils/mp/realism.ts'

/** 2026-09-25 实测的「研途健行」任务参数（研究生院） */
const YANTU = {
  requiredKm: 2.4,
  minSpeedKmh: 4,
  maxSpeedKmh: 7,
  minMinutes: 20,
  maxMinutes: 35,
} as const

/** 2026-09-14 实测的天目湖阳光跑任务参数（南航） */
const NUAA = {
  requiredKm: 3.2,
  minSpeedKmh: 3,
  maxSpeedKmh: 15,
  minMinutes: 10,
  maxMinutes: 25,
} as const

const paceSeconds = (km: number, minutes: number) => (minutes * 60) / km

test('runPaceWindow：速度窗 ∩ 时长窗（研途健行实测参数 ⇒ 514~875 秒/公里）', () => {
  const w = runPaceWindow(YANTU, 2.44)
  // 速度 4~7 km/h ⇒ 3600/7 = 514.28（最快）、3600/4 = 900（最慢）
  assert.ok(Math.abs(w.speedLo - 3600 / 7) < 1e-9, `speedLo=${w.speedLo}`)
  assert.equal(w.speedHi, 900)
  // 时长 20~35 分钟 / 2.44 km ⇒ 491.8 ~ 860.7
  assert.ok(Math.abs(w.timeLo - paceSeconds(2.44, 20)) < 1e-9, `timeLo=${w.timeLo}`)
  assert.ok(Math.abs(w.timeHi - paceSeconds(2.44, 35)) < 1e-9, `timeHi=${w.timeHi}`)
  // 交集 = [max(514.28, 491.8), min(900, 860.7)] = [514.28, 860.7]
  assert.ok(Math.abs(w.lo - 3600 / 7) < 1e-9, `交集下限应是速度窗给的 ${3600 / 7}，实际 ${w.lo}`)
  assert.ok(Math.abs(w.hi - paceSeconds(2.44, 35)) < 1e-9, `交集上限应是时长窗给的，实际 ${w.hi}`)
  assert.equal(w.hasSpeedWindow, true)
  assert.equal(w.hasTimeWindow, true)
  assert.equal(w.conflict, false)
})

test('runPaceWindow：只给速度窗 / 只给时长窗 / 都不给，都不假装有', () => {
  const onlySpeed = runPaceWindow({ requiredKm: 3.2, minSpeedKmh: 8, maxSpeedKmh: 15 }, 3.27)
  assert.equal(onlySpeed.hasTimeWindow, false)
  assert.equal(onlySpeed.lo, 3600 / 15)
  assert.equal(onlySpeed.hi, 3600 / 8)

  const onlyTime = runPaceWindow({ requiredKm: 3.2, minMinutes: 15, maxMinutes: 30 }, 3.27)
  assert.equal(onlyTime.hasSpeedWindow, false)
  assert.ok(Math.abs(onlyTime.lo - paceSeconds(3.27, 15)) < 1e-9)
  assert.ok(Math.abs(onlyTime.hi - paceSeconds(3.27, 30)) < 1e-9)

  const none = runPaceWindow({ requiredKm: 3.2 }, 3.27)
  assert.equal(none.hasSpeedWindow, false)
  assert.equal(none.hasTimeWindow, false)
  assert.equal(none.lo, 0)
  assert.equal(none.hi, Number.POSITIVE_INFINITY)
  assert.equal(none.conflict, false)
})

test('runPaceWindow：两窗矛盾 ⇒ conflict=true、回落到速度窗，且说明里带上两侧窗口（不静默）', () => {
  const w = runPaceWindow({ requiredKm: 3.27, minSpeedKmh: 8, maxSpeedKmh: 15, minMinutes: 60, maxMinutes: 90 }, 3.27)
  assert.equal(w.conflict, true)
  assert.equal(w.lo, 3600 / 15)
  assert.equal(w.hi, 3600 / 8)
  const detail = String(w.conflictDetail ?? '')
  assert.ok(detail.includes('无交集'), detail)
  assert.ok(detail.includes('速度窗') && detail.includes('时长窗'), detail)
  assert.ok(detail.includes('发给开发者'), detail)
})

test('⭐ 基线在区间外（研途健行 + 默认 6\'00" 策略）：采样落在区间内、不贴边界、多种子互不相同', () => {
  const w = runPaceWindow(YANTU, 2.44)
  const mid = w.lo + 0.62 * (w.hi - w.lo) // ≈ 729 秒/公里 ≈ 12'09"/km
  const seen = new Set<number>()
  for (let seed = 0; seed < 40; seed++) {
    const p = sampleRunPace({ basePaceSecPerKm: 360, window: w, rng: createRngFromSeed(seed) }, 2.44)
    assert.ok(p >= w.lo && p <= w.hi, `seed=${seed} 配速 ${p} 越出交集 [${w.lo}, ${w.hi}]`)
    // **不贴边界**：离两侧都至少留 10% 的区间余量（旧实现恰恰是"每次都等于 lo"）
    const span = w.hi - w.lo
    assert.ok(p > w.lo + span * 0.1, `seed=${seed} 配速 ${p} 太靠快侧边界（旧 bug 的特征）`)
    assert.ok(p < w.hi - span * 0.1, `seed=${seed} 配速 ${p} 太靠慢侧边界`)
    // 只在锚点 ±3% 之内（"中段偏快 + ±3% 抖动"的口径）
    assert.ok(Math.abs(p - mid) <= mid * 0.03 + 1, `seed=${seed} 配速 ${p} 偏离锚点 ${mid} 超过 ±3%`)
    seen.add(Math.round(p))
  }
  assert.ok(seen.size >= 20, `40 个种子只产生 ${seen.size} 种配速，随机性不足`)
  assert.equal(seen.has(Math.round(w.lo)), false, '不许再出现"永远等于交集下限"的旧行为')
})

test('⭐ 基线在区间内（南航 6\'30" 策略）：尊重用户设置，只做 ±3% 浮动', () => {
  const w = runPaceWindow(NUAA, 3.27)
  assert.ok(390 >= w.lo && 390 <= w.hi, `390 应落在交集 [${w.lo}, ${w.hi}] 内`)
  for (let seed = 0; seed < 30; seed++) {
    const p = sampleRunPace({ basePaceSecPerKm: 390, window: w, rng: createRngFromSeed(seed) }, 3.27)
    assert.ok(Math.abs(p - 390) <= 390 * 0.03 + 1, `seed=${seed} 配速 ${p} 偏离用户基线 390 超过 ±3%`)
  }
})

test('采样：区间退化成一个点（极端任务）⇒ 如实返回那个点，不假装随机', () => {
  const w = runPaceWindow({ requiredKm: 3.2, minSpeedKmh: 12, maxSpeedKmh: 12, minMinutes: 5, maxMinutes: 60 }, 3.2)
  assert.equal(w.lo, 300)
  assert.equal(w.hi, 300)
  for (let seed = 0; seed < 5; seed++) {
    assert.equal(sampleRunPace({ basePaceSecPerKm: 360, window: w, rng: createRngFromSeed(seed) }, 3.2), 300)
  }
})

test('planRealisticRun：端点表现 —— 端到端口径未变（区间内、时长窗内、非整分钟）', () => {
  for (let seed = 0; seed < 30; seed++) {
    const plan = planRealisticRun({
      requiredKm: YANTU.requiredKm,
      minSpeedKmh: YANTU.minSpeedKmh,
      maxSpeedKmh: YANTU.maxSpeedKmh,
      minMinutes: YANTU.minMinutes,
      maxMinutes: YANTU.maxMinutes,
      basePaceSecPerKm: 360,
      seed,
    })
    const speedKmh = 3600 / plan.paceSecPerKm
    const minutes = (plan.targetKm * plan.paceSecPerKm) / 60
    assert.ok(speedKmh >= 4 && speedKmh <= 7, `seed=${seed} 速度 ${speedKmh.toFixed(2)} km/h 越出任务速度窗`)
    assert.ok(minutes >= 20 && minutes <= 35, `seed=${seed} 时长 ${minutes.toFixed(2)} 分钟越出任务时长窗`)
    assert.equal(plan.windowConflict, undefined)
    // 里程仍走"略超任务要求"的老口径（2.4 km → 2.41~2.50 km）
    assert.ok(plan.targetKm > 2.4 && plan.targetKm <= 2.5, `seed=${seed} 里程 ${plan.targetKm}`)
  }
})

test('planRealisticRun：基线越界时，多个种子产出的配速**互不相同**（issue #13 的直接判据）', () => {
  const paces = new Set<number>()
  for (let seed = 0; seed < 40; seed++) {
    const plan = planRealisticRun({
      requiredKm: YANTU.requiredKm,
      minSpeedKmh: YANTU.minSpeedKmh,
      maxSpeedKmh: YANTU.maxSpeedKmh,
      minMinutes: YANTU.minMinutes,
      maxMinutes: YANTU.maxMinutes,
      basePaceSecPerKm: 360,
      seed,
    })
    paces.add(plan.paceSecPerKm)
  }
  assert.ok(paces.size >= 20, `40 个种子只产生 ${paces.size} 种配速 —— 又变回"每次同一个值"了`)
  assert.equal(paces.has(514), false, '514 是旧实现里"永远夹到速度窗上限"的那个值，不该再出现')
})
