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

到点即**同时**把两个基准推进到「此刻 / 当前步数」（3615）⇒ 时间型与步数型共享同一个「上次里程碑」基准，
同一 tick 内再进来不会二次触发。

既有门（顺序与改动前一致）：`config.narratorOn !== true` / `st` 为空 / `st.turnActive !== true` /
`st.blocking` / `st.stepCount < 1` ⇒ 直接返回。多会话下 `st` 是 per-session 的，一个会话的里程碑不影响另一个。

## 3. 回合边界

| 时机 | 位置 | 基准 |
| --- | --- | --- |
| 新回合开始 | `resetTurn`（3179 / 写于 3185） | `lastMilestoneAt = now`（= 回合起点）、`lastMilestoneStep = 0` |
| 回合正常收尾 | `handleTurnEnd`（3644 / 写于 3667） | 两者清零 |
| 抹掉回合态（`multiSession` 回切、淘汰） | `clearTurnState`（2849 / 写于 2855） | 两者清零 |
| 非正常收尾（blocked / error / aborted / interrupted / max-tokens） | `handleTurnEnd` 早退分支 | 不写 —— 与既有的 `milestoneSpoken` 同一处置；`turnActive = false` 已足以拦住，下个回合 `resetTurn` 会重设 |

⇒ 回合刚起不算「距上次已过」；新回合从自己的起点重新计时。

## 4. 交付确认（同 tick 被更高优先级吞掉的那次不永久丢失）

链路：

```
maybeMilestone → narrate()           把条目推进 narrPendingBatch 并 queueMicrotask(flushNarrBatch)
               → flushNarrBatch()    按 sid 分组，**只取最高优先级一条**
                                     BLOCK40 > FAIL30 > DONE/GOAL20 > SPECIAL15 > MILESTONE10 > START5
               → deliverNarration()  首个 await 之前的同步门 + 同意图 8s 合并占位登记
```

⇒ 同 tick 里该 sid 若还有更高优先级事件，这次里程碑**根本走不到** `deliverNarration`；
被 `deliverNarration` 的同意图 8s 门挡掉时同理。两种情况都会让「这条已经播过了」的账被记错。

观测点取 `st.lastSpokeByIntent.get('milestone')`：全文件只有 `maybeMilestone`（3629）会发起 `milestone`，
所以该槽只由里程碑的交付改写。`narrate` 排的 flush 微任务先入队、确认回调后入队
⇒ 确认回调必然在 `flushNarrBatch` **之后**执行，届时同步门已判完。

- 槽变了 ⇒ 已受理，基准留在交付时刻；
- 槽没变 ⇒ **回滚**到本次尝试之前的基准（3635）⇒ 下一次巡检（≤30 s）就重试，
  而不是等满一个周期，更不是永远不播；
- 回滚前先核对「基准还是本次推进的那个」（3633）：期间若回合已结束或已开新回合，就不回滚，
  否则「回合结束后基准清零」会出现例外。

残余窗口（已知、未修）：交付已过同步门、却在 LLM 返回后的重核（3550~3554 的
`sameReplaced` / `familyReplaced` / `doneTookOver`）里被放弃时，基准已经留在交付时刻 ⇒ 这一周期不补播。
这三种放弃分别意味着「同意图已被更新的播报接管」或「回合已结束」，语义上本就不该补播。

## 5. 计数与相邻语义（本次未改）

- `recordProgress(sid, { milestoneBump: true })` 仍在**触发时**调用（不是受理时）⇒ `milestoneCount`
  口径与改动前一致。副作用：一次「触发后被吞掉、随后重试成功」的里程碑会让计数 +2 而只播 1 条
  （改动前是 +1 而播 0 条）。
- `st.milestoneSpoken` 保留（`narratorStatus` 回显），语义收窄为「本回合播报过里程碑」，**不再是闸门**。
- 30 s 巡检 tick（5043 起）与 `narrateSubagents` 过滤逻辑未改；`tool/call` 分支改为直接调用
  `maybeMilestone(st)`（不再用「本回合一次性」标志预筛），时间型因此最迟 30 s 到点。
- 优先级系统、`pickNarrLine`、`narrateSummary` 的 prompt 均未改。

## 6. 怎么验

```powershell
node --test test/narr-milestone-periodic.test.mjs
```

该测试把 `maybeMilestone` / `narrate` / `flushNarrBatch` / `deliverNarration` 的同步门
按函数名与行锚**原样切片**求值（沿用 `test/narrator-multisession.test.mjs` 的手法，不复制、不改写生产代码），
用受控时钟与步数驱动，断言落在「某个 sid 实际播了几条、在什么时刻播」这种可观测后果上；
§8 另做元自检：把「退回本回合一次性」「忽略间隔」「去掉回滚」三处变异注入内存切片，判据必须报红。
