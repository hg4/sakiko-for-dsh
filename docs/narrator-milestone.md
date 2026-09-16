# 里程碑播报（周期制）

> 适用：`host.mjs` 的 `maybeMilestone(st)`。**本页行号取自本页所在的那次提交**。
> 一句话语义：`narratorMilestoneMs` / `narratorMilestoneSteps` 是**周期**，不是「本回合只播一次」的阈值 ——
> 长回合里每满一个周期就再播一条，直到回合结束。

## 1. 配置

| 键 | 默认 | sanitize 范围 | 含义 |
| --- | --- | --- | --- |
| `narratorMilestoneMs` | 240000 | 60000 ~ 1800000 | 距上次里程碑满这么多毫秒 ⇒ 再播一条 |
| `narratorMilestoneSteps` | 10 | 3 ~ 50 | 距上次里程碑满这么多**步**（工具调用）⇒ 再播一条 |

两个键各自独立到点即可触发（或的关系）；没有新增旋钮，也没有「每回合最多 N 次」的上限。

## 2. 判定（per-session）

状态在 `st = stateFor(sid)` 上（`makeTurnState`，2510），用两个字段承载基准：

- `st.lastMilestoneAt`（2519）—— 上次里程碑（含**未被受理**的尝试）的时刻；
- `st.lastMilestoneStep`（2520）—— 上次里程碑时的 `stepCount`。

```
overTime  = Date.now() - prevAt   >= narratorMilestoneMs
overSteps = st.stepCount - prevStep >= narratorMilestoneSteps
到点 ⇔ overTime || overSteps        // prevAt  缺省回落 st.turnStartAt；prevStep 缺省 0
```

到点即**同时**把两个基准推进到「此刻 / 当前步数」（3619~3620）⇒ 时间型与步数型共享同一个「上次里程碑」基准，
同一 tick 内再进来不会二次触发。

既有门（顺序与改动前一致）：`config.narratorOn !== true` / `st` 为空 / `st.turnActive !== true` /
`st.blocking` / `st.stepCount < 1` ⇒ 直接返回。多会话下 `st` 是 per-session 的，一个会话的里程碑不影响另一个。

## 3. 回合边界

| 时机 | 位置 | 基准 |
| --- | --- | --- |
| 新回合开始 | `resetTurn`（3179 / 写于 3185） | `lastMilestoneAt = now`（= 回合起点）、`lastMilestoneStep = 0` |
| 回合正常收尾 | `handleTurnEnd`（3648 / 写于 3671） | 两者清零 |
| 抹掉回合态（`multiSession` 回切、淘汰） | `clearTurnState`（2849 / 写于 2855） | 两者清零 |
| 非正常收尾（blocked / error / aborted / interrupted / max-tokens） | `handleTurnEnd` 早退分支 | 不写 —— 与既有的 `milestoneSpoken` 同一处置；`turnActive = false` 已足以拦住，下个回合 `resetTurn` 会重设 |

⇒ 回合刚起不算「距上次已过」；新回合从自己的起点重新计时。

## 4. 交付确认（同 tick 被更高优先级吞掉的那次不永久丢失）

链路：

```
maybeMilestone → narrate()（3430）   入批前先过它自己的同意图 8s 预筛（3436~3440，命中则连批都不进）；
                                     通过则 narrPendingBatch.push（3442）+ queueMicrotask(flush)（3446）
               → flushNarrBatch()（3452） 按 sid 分组，**只取最高优先级一条**
                                     BLOCK40 > FAIL30 > DONE/GOAL20 > SPECIAL15 > MILESTONE10 > START5
               → deliverNarration()（3504） 首个 await 之前的同步门 + 同意图 8s 合并占位登记（3519~3521）
```

⇒ 同 tick 里该 sid 若还有更高优先级事件，这次里程碑**根本走不到** `deliverNarration`；
被同意图 8s 门挡掉时同理 —— **该门有两处**：`narrate()` 在**入批之前**的预筛（3436~3440，命中则连批都不进），
与 `deliverNarration` 的占位门（3519~3521）；两处都让该槽不变，确认回调都会回滚。
这两种情况都会让「这条已经播过了」的账被记错。

观测点取 `st.lastSpokeByIntent.get('milestone')`：**非 force** 的 `narrate('milestone')` 全文件只有
`maybeMilestone`（3633）一处（`testNarrator`（4722）用 `force: true` 也能发 milestone，但 force 路径整段
跳过 `if (!force) { … }` 的门与占位登记（3511）⇒ **不写**该槽），所以该槽只由里程碑的**正常交付**改写。
`narrate` 里 `narrPendingBatch.push`（3442）与 `queueMicrotask(flush)`（3446）都在 `return` 之前、
确认回调后入队（3643）⇒ 确认回调必然在 `flushNarrBatch`（3452）**之后**执行，届时同步门已判完。

- 槽变了 ⇒ 已受理，基准留在交付时刻；
- 槽没变 ⇒ **回滚**到本次尝试之前的基准（3639）⇒ 下一次巡检（≤30 s）就重试，
  而不是等满一个周期，更不是永远不播；
- 回滚前先核对「基准还是本次推进的那个」（3637）：期间若回合已结束或已开新回合，就不回滚，
  否则「回合结束后基准清零」会出现例外。
- 三条回滚路径**各有守卫**（测试 §7b / §7d / §7e）：批次优先级吞掉、同 tick 回合边界、`narrate()` 的 8s 预筛。

残余窗口（已知、未修）：交付已过同步门、却在 LLM 返回后的重核（3554~3558 的
`sameReplaced` / `familyReplaced` / `doneTookOver`）里被放弃时，基准已经留在交付时刻 ⇒ 这一周期不补播。
这三种放弃分别意味着「同意图已被更新的播报接管」或「回合已结束」，语义上本就不该补播。

## 5. 计数与相邻语义（本次未改）

- `recordProgress(sid, { milestoneBump: true })` 仍在**触发时**调用（不是受理时）⇒ `milestoneCount`
  是「**触发次数**」，**不是**「播出条数」。⚠️ 回滚会把 `narrate()` 的同意图 8s 合并窗变成 bump 放大器：
  步数型 steps=10、工具调用 **0.5 s/次跑 40 步**时，**bump 13 次而只播 2 条**（6.5×）；
  同节奏在「去掉回滚」的对照版上是 4 次/2 条；**1 s/次**的慢节奏两者都是 4/4。
  （数字由独立验证实测给出（被测版本 = rebase 前的 `a773dc3`，host.mjs blob `0f90856…`）；
  本次修复者用本仓库测试台 §7g 逐值复现：`13/2`、`4/2`、`4/4`，
  并打印 `at=[5000,13000]` / `[10000,20000,30000,40000]`。）
  最朴素的「触发→被吞→重试成功」是 +2 而播 1 条（改动前是 +1 播 0 条）。
  该字段只进 `narratorStatus`（4668）与 `narrator.json` 的分片摘要（`narrPersistSnapshot` 3085），**不参与任何判定、也不进 LLM prompt**，
  `client.js` / `client.mjs` 零引用。
  要让口径贴近「播出一条 +1」：把 3623 的 `recordProgress(st.sid, { milestoneBump: true })`
  挪进确认回调的「已受理」分支即可（本次未改，改了要重跑红绿并重新验证）。
- `st.milestoneSpoken` 保留（`narratorStatus`（4691）的调试回显；`client.js` / `client.mjs` **零引用**，
  不是「面板契约」—— 代码注释写的是「供 narratorStatus」，那个才准确），语义收窄为
  「本回合播报过里程碑」，**不再是闸门**。
- 30 s 巡检 tick（5047 起）与 `narrateSubagents` 过滤逻辑未改；`tool/call` 分支改为直接调用
  `maybeMilestone(st)`（4943；不再用「本回合一次性」标志预筛），时间型因此最迟 30 s 到点。
- 优先级系统、`pickNarrLine`、`narrateSummary` 的 prompt 均未改。

**边角行为变化（去掉 `tool/call` 预筛带来的，测试 §7f）**：静默长回合（回合已跑满一个周期、期间
**没有任何工具调用**）的**第一个**工具调用会让 `narrate('start')`(5) 与里程碑(10) 在**同一 tick** 入批，
`flushNarrBatch` 按 sid 只取最高优先级 ⇒ **里程碑赢、START 被吞**（`spoken=["milestone"]`）。
改动前这条路径只播 START（旧预筛 `st.stepCount >= steps` 在 `stepCount===1` 时不成立，
所以那个 Milestone 压根不会入批）。用户仍能听到一条，且那种场景下 START（「开工了」）本就陈旧
—— 记为可接受的新行为，不是缺陷。

## 6. 怎么验

```powershell
node --test test/narr-milestone-periodic.test.mjs
```

该测试把 `maybeMilestone` / `narrate` / `flushNarrBatch` / `deliverNarration` 的同步门
按函数名与行锚**原样切片**求值（沿用 `test/narrator-multisession.test.mjs` 的手法，不复制、不改写生产代码），
用受控时钟与步数驱动，断言落在「某个 sid 实际播了几条、在什么时刻播」这种可观测后果上；
§8 另做元自检：把「退回本回合一次性」「忽略间隔」「去掉回滚」三处变异注入内存切片，判据必须报红。
