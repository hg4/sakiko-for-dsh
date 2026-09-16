# 哼唱彩蛋音频池（assets/audio/hum-*.wav）来源与重做方法

插件按 `hum-1.wav … hum-16.wav` 顺序探测，**只把存在的文件放进候选表**，然后等概率随机挑一个
（`host.mjs` 的 `scanHumFiles()` / `playHum()`）。所以池子里有几个文件就是几分之一的概率，
不需要改代码；每次出声都会重新扫目录，**换文件不用重启 DSH**。

## 当前池子（v3，5 个资源，2026-09-14）

| 文件 | 内容 | 时长 | 来源与切点 |
| --- | --- | --- | --- |
| `hum-1.wav` | 白祥清唱（三句乐句整段） | 12.55s | 全曲清唱 `sakiko-ref.wav` 的 **70s 段**内 `2.717–15.267s`（= 全曲 `122.72–137.99s`） |
| `hum-2.wav` | 白祥清唱（整段） | 12.64s | 同源 `25.896–38.539s`（= 全曲 `145.90–158.54s`） |
| `hum-3.wav` | 白祥清唱（整段） | 22.59s | 同源 `45.424–68.017s`（= 全曲 `165.42–188.02s`） |
| `hum-4.wav` | **RVC 转换版「哼唱春日影」**（PICK-04） | 7.76s | `rvc/out/listen/FINAL-pick04-final.wav` |
| `hum-5.wav` | Ave Mujica 钢琴前奏（前 12s） | 12.00s | `rvc/out/listen/ID-5-song-AveMujica-40s.wav` 前 12s |

「70s 段」指全曲清唱 `G:\workspace\.acceptance\audio\sakiko-ref.wav` 的 `120.0–190.0s`
（用户确认「全都是祥子清唱」的那 70 秒），基准与全曲时间的换算是 **全曲 = 70s 基准 + 120**。
所有切点都落在**真实停顿（换气/句间静音）**上，由 `librosa.pyin` 的有声判定 + 帧 RMS 低谷自动定位，
不靠等分硬切。

## 统一规范（与她的 TTS 输出电平对齐，避免彩蛋忽大忽小）

24 kHz 单声道 PCM16、首尾 30 ms 淡入淡出、响度对齐 `first-sakiko-tts.wav`（**−36 dBFS RMS**）、
峰值封顶 0.95。实测五个文件均为 −36.0 dBFS、峰值 0.064–0.117，无削波。

## 重做 / 换段

> ⚠️ 下列路径属于**另一台机器的本地工具链**（RVC 环境与脚本），**不在本仓库内**，保留仅为可追溯。

```powershell
# 1) 从 70s 清唱里按停顿切一段（--phrases 0 = 整段不拆句）
& G:\workspace\rvc\env\Scripts\python.exe G:\workspace\rvc\scripts\pick_hum_segments.py `
    --start 2.9 --end 14.9 --phrases 0 --tag A     # 输出 hum-A-full.wav + -loud 试听版
# 2) 按当前 5 个资源重建整池（会先备份旧池子）
& G:\workspace\rvc\env\Scripts\python.exe G:\workspace\rvc\scripts\build_hum_pool_v3.py
```

- 切段清单：`G:\workspace\rvc\out\listen\hum-pool-plan.json`
- 可追溯副本：`G:\workspace\rvc\out\hum_pool_v3\`
- 上一版池子备份：`G:\workspace\rvc\out\hum_pool_v2_backup\`
- 试听技巧：`*-loud.wav` 是峰值拉满版（方便判断断句），`*-pool.wav` 是彩蛋实际电平。
